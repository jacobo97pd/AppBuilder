import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  dataRoot,
  getProject,
  httpError,
  projectDir,
  safeProcessEnvironment,
} from "./workspace.js";

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";
export interface Job {
  id: string;
  projectId: string;
  kind: "terminal" | "agent" | "build" | "git";
  title: string;
  status: JobStatus;
  output: string;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number;
}

const jobsPath = path.join(dataRoot, "jobs.json");
const jobs = new Map<string, Job>();
const cancellations = new Map<string, () => void | Promise<void>>();
const cancellationRequests = new Map<string, Promise<Job>>();
const execute = promisify(execFile);
const outputLimit = 256_000;
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
let credentialRedactor: ((text: string) => string) | undefined;

export function configureJobRedaction(
  redactor: (text: string) => string,
): void {
  credentialRedactor = redactor;
  if (loaded && jobs.size) {
    for (const job of jobs.values()) {
      job.title = redactJobText(job.title);
      job.output = redactJobText(job.output);
    }
    persist();
  }
}

function redactJobText(text: string): string {
  let clean = text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[clave privada oculta]",
    )
    .replace(
      /\b(?:sk-(?:ant-)?[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]{12,})\b/g,
      "[credencial oculta]",
    )
    .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[credencial oculta]@");
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      value.length >= 8 &&
      /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL/i.test(name)
    )
      clean = clean.split(value).join("[credencial oculta]");
  }
  if (credentialRedactor) {
    try {
      clean = credentialRedactor(clean);
    } catch {
      return "[Registro oculto: no se pudo aplicar la protección de credenciales.]";
    }
  }
  return clean;
}

function persist(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  const temporary = jobsPath + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify([...jobs.values()]), {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, jobsPath);
}

function load(): void {
  if (loaded) return;
  if (!fs.existsSync(jobsPath)) {
    loaded = true;
    return;
  }
  if (fs.lstatSync(jobsPath).isSymbolicLink())
    throw httpError(
      400,
      "El historial de tareas no puede ser un enlace simbólico.",
    );
  const stored: unknown = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
  if (!Array.isArray(stored))
    throw httpError(500, "El historial de tareas no es válido.");
  let recovered = false;
  for (const job of stored as Job[]) {
    const title = redactJobText(job.title);
    const output = redactJobText(job.output);
    if (title !== job.title || output !== job.output) recovered = true;
    job.title = title;
    job.output = output;
    if (job.status === "running") {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.output +=
        "\n[El servidor se reinició antes de completar esta tarea.]\n";
      recovered = true;
    }
    jobs.set(job.id, job);
  }
  loaded = true;
  if (recovered) persist();
}

export function createJob(
  projectId: string,
  kind: Job["kind"],
  title: string,
): Job {
  if (shuttingDown)
    throw httpError(
      503,
      "El servidor se está cerrando. Espera a que vuelva a iniciarse.",
    );
  getProject(projectId);
  load();
  if ([...jobs.values()].filter((job) => job.status === "running").length >= 4)
    throw httpError(
      429,
      "Ya hay cuatro tareas ejecutándose. Espera a que terminen o cancela una.",
    );
  const job: Job = {
    id: randomUUID(),
    projectId,
    kind,
    title: redactJobText(title).slice(0, 200),
    status: "running",
    output: "",
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  const finished = [...jobs.values()]
    .filter((item) => item.status !== "running")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (jobs.size > 200 && finished.length) jobs.delete(finished.shift()!.id);
  persist();
  return job;
}

export function getJob(id: string): Job {
  load();
  const job = jobs.get(id);
  if (!job) throw httpError(404, "No se ha encontrado la tarea.");
  job.title = redactJobText(job.title);
  job.output = redactJobText(job.output);
  return job;
}

export function listJobs(projectId: string): Job[] {
  getProject(projectId);
  load();
  return [...jobs.values()]
    .filter((job) => job.projectId === projectId)
    .map((job) => getJob(job.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function appendJob(id: string, output: string): void {
  const job = getJob(id);
  if (job.status !== "running") return;
  job.output = redactJobText(job.output + output);
  if (job.output.length > outputLimit)
    job.output =
      "[Se ha recortado el inicio del registro para limitar su tamaño.]\n" +
      job.output.slice(-outputLimit);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      try {
        persist();
      } catch (error) {
        console.error("No se pudo guardar el registro de tareas:", error);
      }
    }, 200);
    flushTimer.unref();
  }
}

export function finishJob(
  id: string,
  status: Exclude<JobStatus, "running">,
  exitCode?: number,
): Job {
  const job = getJob(id);
  if (job.status !== "running") return job;
  job.status = status;
  job.finishedAt = new Date().toISOString();
  if (exitCode !== undefined) job.exitCode = exitCode;
  cancellations.delete(id);
  persist();
  return job;
}

export function registerJobCancellation(
  id: string,
  cancel: () => void | Promise<void>,
): void {
  const job = getJob(id);
  if (job.status === "cancelled") {
    void Promise.resolve()
      .then(cancel)
      .catch(() =>
        console.error(
          "No se pudo completar la limpieza de una tarea cancelada.",
        ),
      );
    return;
  }
  if (job.status === "running") cancellations.set(id, cancel);
}

/** True between a cancellation request and the job being marked cancelled. */
export function isCancelling(id: string): boolean {
  return cancellationRequests.has(id);
}

export async function cancelJob(id: string): Promise<Job> {
  const job = getJob(id);
  if (job.status !== "running") return job;
  const pending = cancellationRequests.get(id);
  if (pending) return pending;
  const cancel = cancellations.get(id);
  appendJob(id, "\n[Cancelación solicitada por el usuario.]\n");
  const cancellation = Promise.resolve().then(async () => {
    try {
      if (cancel) await cancel();
      return finishJob(id, "cancelled");
    } catch (error) {
      appendJob(
        id,
        "\n[No se ha podido confirmar la detención completa del proceso. Puedes volver a intentarlo.]\n",
      );
      throw error;
    } finally {
      cancellationRequests.delete(id);
    }
  });
  cancellationRequests.set(id, cancellation);
  return cancellation;
}

/** Stop accepting jobs, await every active cancellation, and flush the final history. */
export function shutdownJobs(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    load();
    const active = [...jobs.values()].filter((job) => job.status === "running");
    const results = await Promise.allSettled(
      active.map((job) => cancelJob(job.id)),
    );
    persist();
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "No se ha podido confirmar la detención de todas las tareas.",
      );
  })();
  return shutdownPromise;
}

/** Keep OS/toolchain essentials; never inherit provider tokens from the server environment. */
export function commandEnvironment(): NodeJS.ProcessEnv {
  return safeProcessEnvironment();
}

// Toolhelp snapshots avoid taskkill /T's slow WMI enumeration on some Windows hosts.
// Only a numeric child PID is substituted; no project command or path enters this script.
const windowsTreeHelper = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class AppBuilderProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Entry {
    public uint Size, Usage, ProcessId;
    public UIntPtr Heap;
    public uint ModuleId, Threads, ParentId;
    public int BasePriority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Stop(uint rootPid) {
    var children = new Dictionary<uint, List<uint>>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      Entry entry = new Entry(); entry.Size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref entry)) throw new System.ComponentModel.Win32Exception();
      do {
        if (!children.ContainsKey(entry.ParentId)) children[entry.ParentId] = new List<uint>();
        children[entry.ParentId].Add(entry.ProcessId);
      } while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    StopBranch(rootPid, children, new HashSet<uint>());
  }
  static void StopBranch(uint pid, Dictionary<uint, List<uint>> children, HashSet<uint> visited) {
    if (pid == 0 || !visited.Add(pid)) return;
    if (children.ContainsKey(pid)) foreach (uint child in children[pid]) StopBranch(child, children, visited);
    try {
      using (Process process = Process.GetProcessById((int)pid)) {
        if (!process.HasExited) { process.Kill(); if (!process.WaitForExit(5000)) throw new Exception("El proceso no se ha detenido."); }
      }
    } catch (ArgumentException) {} catch (InvalidOperationException) {}
  }
}`;

export async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const systemRoot =
      process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const script =
      "$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n" +
      windowsTreeHelper +
      "\n'@\n[AppBuilderProcessTree]::Stop(" +
      child.pid +
      ")\n";
    try {
      await execute(
        path.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          windowsHide: true,
          env: commandEnvironment(),
          timeout: 15_000,
          maxBuffer: 32_000,
        },
      );
    } catch {
      // Some managed hosts disable Add-Type; preserve a system-tool fallback and await it.
      await execute(
        path.join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          windowsHide: true,
          env: commandEnvironment(),
          timeout: 45_000,
          maxBuffer: 32_000,
        },
      );
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        !child.kill("SIGKILL")
      )
        throw httpError(503, "No se pudo confirmar la detención del proceso.");
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.off("close", closed);
          reject(
            httpError(
              503,
              "El proceso no se ha detenido en el tiempo previsto.",
            ),
          );
        }, 5000);
        const closed = () => {
          clearTimeout(timeout);
          resolve();
        };
        child.once("close", closed);
      });
    }
  }
}

export function startCommand(projectId: string, command: string): Job {
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 8000 ||
    command.includes("\0")
  )
    throw httpError(400, "Introduce un comando de entre 1 y 8000 caracteres.");
  const directory = projectDir(projectId);
  const job = createJob(projectId, "terminal", command.trim());
  appendJob(job.id, "$ " + command + "\n");
  const child = spawn(command, {
    cwd: directory,
    env: commandEnvironment(),
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendJob(job.id, chunk));
  child.stderr?.on("data", (chunk: string) => appendJob(job.id, chunk));
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      appendJob(
        job.id,
        "\n[La tarea superó el límite de 20 minutos. Deteniendo el proceso…]\n",
      );
      void killProcessTree(child)
        .then(() => finishJob(job.id, "failed"))
        .catch((error) => {
          appendJob(
            job.id,
            "\n[No se pudo detener el proceso: " +
              (error as Error).message +
              "]\n",
          );
        });
    },
    20 * 60 * 1000,
  );
  timeout.unref();
  registerJobCancellation(job.id, async () => {
    clearTimeout(timeout);
    await killProcessTree(child);
  });
  child.on("error", (error) => {
    clearTimeout(timeout);
    appendJob(
      job.id,
      "\nNo se pudo ejecutar el comando: " + error.message + "\n",
    );
    finishJob(job.id, "failed");
  });
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    if (getJob(job.id).status !== "running" || cancellationRequests.has(job.id))
      return;
    if (signal)
      appendJob(
        job.id,
        "\n[El proceso terminó con la señal " + signal + ".]\n",
      );
    finishJob(
      job.id,
      code === 0 && !timedOut ? "succeeded" : "failed",
      code ?? undefined,
    );
  });
  return job;
}
