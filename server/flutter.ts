import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { Router, type Request, type Response } from "express";
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
import { dataRoot, getProject, httpError, projectDir } from "./workspace.js";

export type FlutterStatus = {
  flutter: boolean;
  /** Flutter SDK version on the server, or null when it is not installed. */
  sdk: string | null;
  /** The project has no web/ folder yet; the first build adds it. */
  needsWeb: boolean;
  builtAt: string | null;
  url: string | null;
  job: Job | null;
};

const windows = process.platform === "win32";
let sdkCache:
  { version: string | null; root: string | null; expires: number } | undefined;
const previewTokens = new Map<string, string>();
const projectTokens = new Map<string, string>();

/** flutter is a .bat file on Windows, so it has to go through the shell there. */
function flutterCommand(args: string[]): {
  command: string;
  args: string[];
  shell: boolean;
} {
  if (!windows) return { command: "flutter", args, shell: false };
  // Arguments are fixed flags and server-generated paths; quote the paths.
  return {
    command: "flutter",
    args: args.map((arg) => (/[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg)),
    shell: true,
  };
}

export async function flutterSdk(): Promise<{
  version: string | null;
  root: string | null;
}> {
  if (sdkCache && sdkCache.expires > Date.now()) return sdkCache;
  const { command, args, shell } = flutterCommand(["--version", "--machine"]);
  const result = await new Promise<{
    version: string | null;
    root: string | null;
  }>((resolve) =>
    execFile(
      command,
      args,
      {
        env: commandEnvironment(),
        shell,
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) return resolve({ version: null, root: null });
        try {
          // Flutter may print an upgrade banner before the JSON.
          const json = JSON.parse(stdout.slice(stdout.indexOf("{")));
          resolve({
            version:
              typeof json.frameworkVersion === "string"
                ? json.frameworkVersion
                : null,
            root:
              typeof json.flutterRoot === "string" ? json.flutterRoot : null,
          });
        } catch {
          resolve({ version: null, root: null });
        }
      },
    ),
  );
  sdkCache = {
    ...result,
    // Remember a missing SDK briefly so installing it is noticed soon.
    expires: Date.now() + (result.version ? 10 * 60_000 : 60_000),
  };
  return result;
}

/** A Flutter app has a pubspec.yaml that depends on the Flutter SDK. */
export function flutterProjectName(projectId: string): string | null {
  const directory = projectDir(projectId);
  const pubspec = path.join(directory, "pubspec.yaml");
  if (!fs.existsSync(pubspec) || fs.lstatSync(pubspec).isSymbolicLink())
    return null;
  const text = fs.readFileSync(pubspec, "utf8").slice(0, 200_000);
  if (!/sdk:\s*flutter\b/.test(text)) return null;
  return /^name:\s*([A-Za-z0-9_]+)/m.exec(text)?.[1] ?? "app";
}

function previewDirectory(projectId: string): string {
  return path.join(dataRoot, "previews", projectId, "web");
}

function previewToken(projectId: string): string {
  let token = projectTokens.get(projectId);
  if (!token) {
    token = randomBytes(24).toString("hex");
    projectTokens.set(projectId, token);
    previewTokens.set(token, projectId);
  }
  return token;
}

export async function flutterStatus(projectId: string): Promise<FlutterStatus> {
  getProject(projectId);
  const name = flutterProjectName(projectId);
  const job =
    listJobs(projectId).find(
      (item) => item.kind === "build" && item.title.startsWith("Flutter"),
    ) ?? null;
  if (!name)
    return {
      flutter: false,
      sdk: null,
      needsWeb: false,
      builtAt: null,
      url: null,
      job: null,
    };
  const index = path.join(previewDirectory(projectId), "index.html");
  const built = fs.existsSync(index);
  return {
    flutter: true,
    sdk: (await flutterSdk()).version,
    needsWeb: !fs.existsSync(
      path.join(projectDir(projectId), "web", "index.html"),
    ),
    builtAt: built ? fs.statSync(index).mtime.toISOString() : null,
    url: built ? `/preview/${previewToken(projectId)}/` : null,
    job,
  };
}

function runFlutterStep(
  job: Job,
  args: string[],
  cwd: string,
  onExit: (ok: boolean) => void,
): () => Promise<void> {
  const { command, args: commandArgs, shell } = flutterCommand(args);
  appendJob(job.id, `$ flutter ${args.join(" ")}\n`);
  const child = spawn(command, commandArgs, {
    cwd,
    env: commandEnvironment(),
    shell,
    windowsHide: true,
    detached: !windows,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => appendJob(job.id, chunk));
  child.stderr.on("data", (chunk: string) => appendJob(job.id, chunk));
  child.on("error", (error) => {
    appendJob(job.id, `\nNo se pudo ejecutar Flutter: ${error.message}\n`);
    onExit(false);
  });
  child.on("close", (code) => {
    if (getJob(job.id).status !== "running" || isCancelling(job.id)) return;
    onExit(code === 0);
  });
  return () => killProcessTree(child);
}

/**
 * Builds the app for the web into AppBuilder's cache, outside the project.
 * A project without web support gets the standard web/ folder first.
 */
export async function startFlutterBuild(projectId: string): Promise<Job> {
  const name = flutterProjectName(projectId);
  if (!name)
    throw httpError(
      400,
      "Este proyecto no es una app de Flutter (falta pubspec.yaml con el SDK de Flutter).",
    );
  const running = listJobs(projectId).find(
    (item) => item.kind === "build" && item.status === "running",
  );
  if (running) return running;
  if (!(await flutterSdk()).version)
    throw httpError(
      409,
      "Flutter no está instalado en el ordenador del servidor. Instálalo, añádelo al PATH y reinicia AppBuilder.",
    );
  const directory = projectDir(projectId);
  const output = previewDirectory(projectId);
  const job = createJob(
    projectId,
    "build",
    "Flutter · compilar la vista previa web",
  );
  const needsWeb = !fs.existsSync(path.join(directory, "web", "index.html"));
  const steps: string[][] = [
    ...(needsWeb
      ? [["create", "--platforms=web", `--project-name=${name}`, "."]]
      : []),
    [
      "build",
      "web",
      "--release",
      "--no-web-resources-cdn",
      "--no-wasm-dry-run",
      `--output=${output}`,
    ],
  ];
  if (needsWeb)
    appendJob(
      job.id,
      "El proyecto no tenía soporte web: se añade la carpeta web/ para poder previsualizarlo. Aparecerá en Cambios; puedes guardarla con un commit o descartarla.\n\n",
    );
  let stop: () => Promise<void> = async () => undefined;
  const timer = setTimeout(() => {
    appendJob(job.id, "\n[La compilación superó 20 minutos. Deteniéndola…]\n");
    void stop()
      .catch(() => undefined)
      .finally(() => finishJob(job.id, "failed"));
  }, 20 * 60_000);
  timer.unref();
  registerJobCancellation(job.id, async () => {
    clearTimeout(timer);
    await stop();
  });
  const run = (index: number) => {
    stop = runFlutterStep(job, steps[index]!, directory, (ok) => {
      if (!ok) {
        clearTimeout(timer);
        appendJob(
          job.id,
          "\nLa compilación falló. Revisa los errores de arriba; si el código usa plugins que no existen en la web, la vista previa no puede mostrarlo.\n",
        );
        finishJob(job.id, "failed");
      } else if (index + 1 < steps.length) run(index + 1);
      else {
        clearTimeout(timer);
        appendJob(job.id, "\nVista previa lista.\n");
        finishJob(job.id, "succeeded", 0);
      }
    });
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  run(0);
  return job;
}

// Service workers are unavailable in an opaque-origin sandbox; hiding the API
// lets Flutter's loader skip it instead of failing to start.
const noServiceWorker = `<script>try{delete Navigator.prototype.serviceWorker}catch(e){}</script>`;
const bridge = `<script>(()=>{for(const level of ['log','warn','error']){const original=console[level];console[level]=(...args)=>{original.apply(console,args);parent.postMessage({type:'appbuilder:console',level,text:args.map(a=>{try{return typeof a==='string'?a:JSON.stringify(a)}catch{return String(a)}}).join(' ').slice(0,4000)},'*')}}window.addEventListener('error',e=>parent.postMessage({type:'appbuilder:console',level:'error',text:e.message},'*'))})();</script>`;

/**
 * Serves a built preview by capability URL. Responses carry a CSP sandbox,
 * so the app runs in an opaque origin even if opened outside the iframe and
 * can never reach the studio session or API.
 */
export function serveFlutterPreview(frameAncestors: string[]) {
  return (req: Request, res: Response) => {
    const projectId = previewTokens.get(String(req.params.token));
    if (!projectId || !/^[a-f\d]{48}$/.test(String(req.params.token)))
      return res
        .status(404)
        .type("text/plain")
        .send("Vista previa no disponible.");
    const raw = req.params.file as unknown;
    // Relative asset URLs need the folder form of the address.
    if (raw === undefined && !req.path.endsWith("/"))
      return res.redirect(302, req.originalUrl.replace(/^([^?]*)/, "$1/"));
    const relative =
      (Array.isArray(raw) ? raw.join("/") : String(raw ?? "")) || "index.html";
    if (
      relative.includes("\0") ||
      relative.includes("\\") ||
      relative.split("/").some((part) => part === "" || part.startsWith("."))
    )
      return res.status(400).type("text/plain").send("Ruta no válida.");
    const root = previewDirectory(projectId);
    const file = path.resolve(root, relative);
    if (path.relative(root, file).startsWith("..") || !fs.existsSync(file))
      return res.status(404).type("text/plain").send("Archivo no encontrado.");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      return res.status(404).type("text/plain").send("Archivo no encontrado.");
    res.removeHeader("X-Frame-Options");
    res.setHeader(
      "Content-Security-Policy",
      `sandbox allow-scripts allow-forms allow-popups allow-pointer-lock; frame-ancestors ${frameAncestors.join(" ")}`,
    );
    // The sandboxed document has an opaque origin; its asset fetches are CORS.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "no-cache");
    if (relative === "index.html") {
      const html = fs
        .readFileSync(file, "utf8")
        .replace(
          /<base href="[^"]*"\s*\/?>/i,
          `<base href="/preview/${req.params.token}/">`,
        )
        .replace(/<head>/i, `<head>${noServiceWorker}`)
        .replace(/<\/head>/i, `${bridge}</head>`);
      return res.type("html").send(html);
    }
    // The data folder (.appbuilder) is hidden; only paths inside the build are
    // checked for hidden parts above.
    res.sendFile(relative, { root, dotfiles: "allow" });
  };
}

export function createFlutterRouter(): Router {
  const router = Router();
  router.get("/projects/:id/flutter", async (req, res) =>
    res.json(await flutterStatus(req.params.id)),
  );
  router.post("/projects/:id/flutter/build", async (req, res) =>
    res.status(202).json(await startFlutterBuild(req.params.id)),
  );
  return router;
}
