import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { Router } from "express";
import { getGitStatus, gitLocked } from "./core.js";
import { readCredentials } from "./integrations.js";
import {
  appendJob,
  commandEnvironment,
  createJob,
  finishJob,
  getJob,
  isCancelling,
  killProcessTree,
  listJobs,
  registerJobCancellation,
  type Job,
} from "./jobs.js";
import { isGitHubUrl, normalizeRepositoryUrl } from "./remotes.js";
import {
  completeImportedProject,
  deleteProject,
  getProject,
  httpError,
  projectDir,
  reserveImportedProject,
  type Project,
} from "./workspace.js";

function githubToken(): string | undefined {
  try {
    return readCredentials("github", false).token?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Environment for Git commands that talk to a remote. A configured GitHub token
 * travels as a transient HTTP header (GIT_CONFIG_*), so it never appears in the
 * process arguments or in .git/config. Without a token, Git may use the server
 * machine's own credential helper, but never interactively.
 */
export function gitRemoteEnvironment(
  remoteUrl: string,
  token = githubToken(),
): NodeJS.ProcessEnv {
  const config: [string, string][] = [
    ["credential.interactive", "never"],
    ["core.hooksPath", "/dev/null"],
  ];
  if (token && isGitHubUrl(remoteUrl))
    config.push([
      "http.https://github.com/.extraheader",
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    ]);
  const env: NodeJS.ProcessEnv = {
    ...commandEnvironment(),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  return env;
}

/** Turns Git's carriage-return progress into a few readable lines per phase. */
export function gitProgress(write: (text: string) => void) {
  let pending = "";
  const reported = new Map<string, number>();
  const handle = (line: string) => {
    const text = line.trimEnd();
    if (!text.trim()) return;
    const progress = /^(.*?):\s+(\d{1,3})% \(\d+\/\d+\)/.exec(text);
    if (progress) {
      const phase = progress[1]!.trim();
      const percent = Number(progress[2]);
      const step = percent >= 100 ? 5 : Math.floor(percent / 20);
      if ((reported.get(phase) ?? -1) >= step) return;
      reported.set(phase, step);
    }
    write(text + "\n");
  };
  return Object.assign(
    (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r\n|\r|\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) handle(line);
    },
    {
      flush() {
        if (pending) handle(pending);
        pending = "";
      },
    },
  );
}

/** A short, actionable explanation for the most common Git failures. */
export function explainGitFailure(output: string): string {
  const text = output.toLowerCase();
  if (/repository not found|repository .* does not exist/.test(text))
    return "No se encontró el repositorio o tu cuenta no tiene acceso. Si es privado, conecta GitHub en Conexiones o inicia sesión con Git en el ordenador del servidor.";
  if (
    /permission to .* denied|write access to repository not granted|requested url returned error: 403/.test(
      text,
    )
  )
    return "Tu cuenta no tiene permiso de escritura en este repositorio. Si usas un token de GitHub, dale el permiso «Contents: Read and write».";
  if (
    /authentication failed|could not read username|terminal prompts disabled|invalid username or password|requested url returned error: 401|user interactivity has been disabled/.test(
      text,
    )
  )
    return "El repositorio pidió credenciales. Conecta GitHub en Conexiones con un token o inicia sesión con Git en el ordenador del servidor.";
  if (/non-fast-forward|\(fetch first\)|updates were rejected/.test(text))
    return "El repositorio remoto tiene commits que aún no tienes. Pulsa «Traer cambios» y vuelve a subir.";
  if (
    /not possible to fast-forward|diverging branches|have diverged/.test(text)
  )
    return "Tu copia y el remoto tienen commits distintos. Combínalos desde la terminal (por ejemplo, git pull --rebase) o pide ayuda al agente.";
  if (
    /would be overwritten by merge|commit your changes or stash them/.test(text)
  )
    return "Tienes cambios sin guardar en archivos que también cambiaron en el remoto. Guarda un commit o restaura esos archivos y vuelve a intentarlo.";
  if (/no tracking information|has no upstream branch/.test(text))
    return "Esta rama todavía no existe en el remoto. Súbela primero.";
  if (/remote branch .* not found|couldn't find remote ref/.test(text))
    return "Esa rama no existe en el repositorio. Revisa el nombre o déjalo vacío para usar la rama principal.";
  if (/git-lfs|smudge filter lfs failed/.test(text))
    return "El repositorio usa Git LFS y no está disponible en el servidor. Instala Git LFS o usa la descarga ligera.";
  if (/not currently on a branch/.test(text))
    return "No estás en ninguna rama. Cambia a una rama desde la terminal antes de subir.";
  if (
    /could not resolve host|failed to connect|connection timed out|unable to access/.test(
      text,
    )
  )
    return "No se pudo contactar con el servidor de Git. Comprueba la conexión a internet del ordenador del servidor.";
  return "";
}

function lastMessage(output: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ""
  ).slice(0, 300);
}

function runGitTask(task: {
  job: Job;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMinutes: number;
  onFinish: (ok: boolean) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}): void {
  const { job } = task;
  let output = "";
  const write = gitProgress((text) => {
    output = (output + text).slice(-64_000);
    appendJob(job.id, text);
  });
  const child = spawn("git", task.args, {
    cwd: task.cwd,
    env: task.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  let settled = false;
  const finish = async (ok: boolean, exitCode?: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    write.flush();
    if (!ok) {
      const hint = explainGitFailure(output);
      if (hint) appendJob(job.id, `\n${hint}\n`);
    }
    try {
      await task.onFinish(ok);
    } catch (error) {
      ok = false;
      appendJob(
        job.id,
        `\n${error instanceof Error ? error.message : "No se pudo completar la operación."}\n`,
      );
    }
    finishJob(job.id, ok ? "succeeded" : "failed", exitCode);
  };
  const timer = setTimeout(() => {
    appendJob(
      job.id,
      `\n[La operación superó el límite de ${task.timeoutMinutes} minutos. Deteniéndola…]\n`,
    );
    void killProcessTree(child)
      .catch(() => undefined)
      .finally(() => finish(false));
  }, task.timeoutMinutes * 60_000);
  timer.unref();
  registerJobCancellation(job.id, async () => {
    settled = true;
    clearTimeout(timer);
    await killProcessTree(child);
    await task.onCancel?.();
  });
  child.on("error", (error) => {
    appendJob(
      job.id,
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Git no está instalado en el ordenador del servidor.\n"
        : `No se pudo iniciar Git: ${error.message}\n`,
    );
    void finish(false);
  });
  child.on("close", (code) => {
    if (getJob(job.id).status !== "running" || isCancelling(job.id)) return;
    void finish(code === 0, code ?? undefined);
  });
}

function repositoryBranch(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[\w][\w./-]*$/.test(value) ||
    value.includes("..") ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  )
    throw httpError(400, "El nombre de la rama no es válido.");
  return value;
}

/**
 * Clones a repository into a new project. The clone runs as a job so large
 * repositories report progress; a failed or cancelled clone leaves nothing.
 */
export function startImport(
  input: { url?: unknown; name?: unknown; branch?: unknown; light?: unknown },
  options: { allowLocalSources?: boolean } = {},
): { project: Project; job: Job } {
  const repository = normalizeRepositoryUrl(input.url, options);
  const branch = repositoryBranch(input.branch);
  const light = input.light === true;
  const { project, directory } = reserveImportedProject({
    name:
      typeof input.name === "string" && input.name.trim()
        ? input.name
        : repository.name,
    url: repository.url,
  });
  let job: Job;
  try {
    job = createJob(project.id, "git", `Importar ${repository.label}`);
  } catch (error) {
    deleteProject(project.id);
    throw error;
  }
  appendJob(
    job.id,
    `Importando ${repository.label}${branch ? ` · rama ${branch}` : ""}${light ? " · descarga ligera" : ""}\n`,
  );
  const env = gitRemoteEnvironment(repository.url);
  // Light imports skip history and Git LFS assets: ideal for editing code.
  if (light) env.GIT_LFS_SKIP_SMUDGE = "1";
  const discard = () => {
    try {
      deleteProject(project.id);
    } catch (error) {
      console.error("No se pudo eliminar una importación fallida:", error);
    }
  };
  runGitTask({
    job,
    args: [
      // Request URLs may only use HTTPS; ext::, file:// and the like are refused.
      ...(options.allowLocalSources
        ? []
        : ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]),
      "clone",
      "--progress",
      ...(branch ? [`--branch=${branch}`] : []),
      ...(light ? ["--depth=1"] : []),
      "--",
      repository.url,
      directory,
    ],
    cwd: path.dirname(directory),
    env,
    timeoutMinutes: 60,
    onFinish: (ok) => {
      if (!ok) {
        discard();
        return;
      }
      const current = spawnSync("git", ["branch", "--show-current"], {
        cwd: directory,
        env: commandEnvironment(),
        windowsHide: true,
        timeout: 15_000,
        encoding: "utf8",
      });
      completeImportedProject(
        project.id,
        current.stdout?.trim() || branch || "",
      );
      appendJob(job.id, "\nProyecto listo. Ya puedes abrirlo en tu estudio.\n");
    },
    onCancel: discard,
  });
  return { project, job };
}

function originUrl(directory: string): string {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: directory,
    env: commandEnvironment(),
    windowsHide: true,
    timeout: 15_000,
    encoding: "utf8",
  });
  const url = result.status === 0 ? result.stdout.trim() : "";
  if (!url)
    throw httpError(
      409,
      "Este proyecto no tiene un repositorio remoto (origin). Impórtalo desde GitHub o añade uno desde la terminal.",
    );
  return url;
}

function assertSyncAllowed(projectId: string): void {
  if (
    listJobs(projectId).some(
      (job) =>
        job.status === "running" &&
        (job.kind === "agent" || job.kind === "git"),
    )
  )
    throw httpError(
      409,
      "Espera a que terminen el agente o la sincronización en curso.",
    );
  if (gitLocked(projectId))
    throw httpError(409, "Hay una operación de Git en curso.");
}

/** Pull (fast-forward only) or push the current branch as a visible job. */
export function startSync(projectId: string, action: "pull" | "push"): Job {
  const directory = projectDir(projectId);
  assertSyncAllowed(projectId);
  const url = originUrl(directory);
  const remoteName = isGitHubUrl(url) ? "GitHub" : "el remoto";
  const job = createJob(
    projectId,
    "git",
    action === "pull"
      ? `Traer cambios de ${remoteName}`
      : `Subir cambios a ${remoteName}`,
  );
  runGitTask({
    job,
    args:
      action === "pull"
        ? ["pull", "--ff-only", "--progress"]
        : ["push", "--progress", "--set-upstream", "origin", "HEAD"],
    cwd: directory,
    env: gitRemoteEnvironment(url),
    timeoutMinutes: 30,
    onFinish: (ok) => {
      if (ok)
        appendJob(
          job.id,
          action === "pull"
            ? "\nTu copia está al día.\n"
            : `\nCambios subidos a ${remoteName}.\n`,
        );
    },
  });
  return job;
}

/** Refreshes remote-tracking refs so the panel can show commits to bring in. */
export async function fetchRemote(projectId: string): Promise<void> {
  const directory = projectDir(projectId);
  if (
    listJobs(projectId).some(
      (job) => job.kind === "git" && job.status === "running",
    )
  )
    return;
  const url = originUrl(directory);
  await new Promise<void>((resolve, reject) =>
    execFile(
      "git",
      ["fetch", "--prune", "--quiet", "origin"],
      {
        cwd: directory,
        env: gitRemoteEnvironment(url),
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        reject(
          httpError(
            502,
            explainGitFailure(stderr) ||
              lastMessage(stderr) ||
              "No se pudo consultar el repositorio remoto.",
          ),
        );
      },
    ),
  );
}

export function createRepositoriesRouter(): Router {
  const router = Router();
  router.post("/projects/import", (req, res) =>
    res.status(202).json(startImport(req.body ?? {})),
  );
  router.post("/projects/:id/git/pull", (req, res) => {
    getProject(req.params.id);
    res.status(202).json(startSync(req.params.id, "pull"));
  });
  router.post("/projects/:id/git/push", (req, res) => {
    getProject(req.params.id);
    res.status(202).json(startSync(req.params.id, "push"));
  });
  router.post("/projects/:id/git/fetch", async (req, res) => {
    await fetchRemote(req.params.id);
    res.json(await getGitStatus(req.params.id));
  });
  return router;
}
