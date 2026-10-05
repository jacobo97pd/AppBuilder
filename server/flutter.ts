import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
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
import {
  dataRoot,
  getProject,
  httpError,
  initialCommit,
  projectDir,
} from "./workspace.js";

export type FlutterApp = {
  /** Dart package name from pubspec.yaml. */
  name: string;
  /** Folder of the app inside the project; "" when it is the project root. */
  folder: string;
};

export type FlutterStatus = {
  flutter: boolean;
  /** Flutter SDK version on the server, or null when it is not installed. */
  sdk: string | null;
  folder: string;
  /** The app has no web/ folder yet; the first build adds it. */
  needsWeb: boolean;
  builtAt: string | null;
  url: string | null;
  job: Job | null;
};

const windows = process.platform === "win32";
const brotli = promisify(zlib.brotliCompress);
let sdkCache:
  { version: string | null; root: string | null; expires: number } | undefined;
let previewSecret: Buffer | undefined;
const tokenProjects = new Map<string, string>();

/** flutter is a .bat file on Windows, so it has to go through the shell there. */
function flutterCommand(args: string[]): {
  command: string;
  args: string[];
  shell: boolean;
} {
  if (!windows) return { command: "flutter", args, shell: false };
  // Arguments are fixed flags, validated names and server paths; quote the paths.
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

async function requireSdk(): Promise<void> {
  if (!(await flutterSdk()).version)
    throw httpError(
      409,
      "Flutter no está instalado en el ordenador del servidor. Instálalo, añádelo al PATH y reinicia AppBuilder.",
    );
}

/** The Dart package name of a Flutter pubspec.yaml in this folder, if any. */
function flutterPackage(directory: string): string | null {
  const pubspec = path.join(directory, "pubspec.yaml");
  try {
    if (!fs.lstatSync(pubspec).isFile()) return null;
  } catch {
    return null;
  }
  const text = fs.readFileSync(pubspec, "utf8").slice(0, 200_000);
  if (!/sdk:\s*flutter\b/.test(text)) return null;
  return /^name:\s*([A-Za-z0-9_]+)/m.exec(text)?.[1] ?? "app";
}

const hasEntryPoint = (directory: string) =>
  fs.existsSync(path.join(directory, "lib", "main.dart"));
// Platform, build and backend folders never hold the app itself.
const skippedFolders = new Set([
  "android",
  "ios",
  "web",
  "macos",
  "linux",
  "windows",
  "build",
  "lib",
  "test",
  "integration_test",
  "assets",
  "functions",
  "node_modules",
]);

/**
 * Finds the Flutter app of a project: its root or a folder up to two levels
 * deep, such as a monorepo's app, a plugin's example or an app an agent
 * created inside another project.
 */
export function flutterApp(projectId: string): FlutterApp | null {
  const root = projectDir(projectId);
  const rootName = flutterPackage(root);
  if (rootName && hasEntryPoint(root)) return { name: rootName, folder: "" };
  const queue = [{ directory: root, folder: "", depth: 0 }];
  let inspected = 0;
  while (queue.length && inspected < 300) {
    const { directory, folder, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Dirent reports links as links, so they are never followed.
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        skippedFolders.has(entry.name)
      )
        continue;
      inspected++;
      const child = path.join(directory, entry.name);
      const childFolder = folder ? `${folder}/${entry.name}` : entry.name;
      const name = flutterPackage(child);
      if (name && hasEntryPoint(child)) return { name, folder: childFolder };
      if (depth < 1)
        queue.push({ directory: child, folder: childFolder, depth: depth + 1 });
    }
  }
  // Without lib/main.dart, let `flutter build` explain what is missing.
  return rootName ? { name: rootName, folder: "" } : null;
}

export function flutterProjectName(projectId: string): string | null {
  return flutterApp(projectId)?.name ?? null;
}

const dartReserved = new Set(
  (
    "abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for function get hide if implements import in interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try type typedef var void when while with yield " +
    "flutter flutter_test flutter_web_plugins flutter_driver integration_test sky_engine test cupertino_icons"
  ).split(" "),
);

/** A valid, lowercase Dart package name derived from the project name. */
export function dartPackageName(value: string): string {
  let name = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50)
    .replace(/_+$/, "");
  if (!name) name = "app";
  if (/^\d/.test(name)) name = `app_${name}`;
  if (dartReserved.has(name)) name = `${name}_app`;
  return name;
}

/** Reverse-domain organization for bundle IDs, such as com.tuempresa. */
export function flutterOrganization(value: unknown): string {
  if (value === undefined || value === null || value === "")
    return "com.example";
  const organization = typeof value === "string" ? value.trim() : "";
  if (
    organization.length > 100 ||
    !/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(organization)
  )
    throw httpError(
      400,
      "La organización debe tener el formato com.tuempresa (letras, números y puntos).",
    );
  return organization.toLowerCase();
}

function previewDirectory(projectId: string): string {
  return path.join(dataRoot, "previews", projectId, "web");
}

function secret(): Buffer {
  if (previewSecret) return previewSecret;
  const file = path.join(dataRoot, "preview.key");
  try {
    const stored = fs.readFileSync(file);
    if (stored.length >= 32) return (previewSecret = stored);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  previewSecret = randomBytes(32);
  fs.writeFileSync(file, previewSecret, { mode: 0o600 });
  return previewSecret;
}

/** Stable per project, so an open preview keeps working after a restart. */
export function previewToken(projectId: string): string {
  const token = createHmac("sha256", secret())
    .update(`flutter-preview:${projectId}`)
    .digest("hex")
    .slice(0, 48);
  tokenProjects.set(token, projectId);
  return token;
}

function previewProject(token: string): string | undefined {
  if (!/^[a-f\d]{48}$/.test(token)) return undefined;
  const known = tokenProjects.get(token);
  if (known) return known;
  let built: string[];
  try {
    built = fs.readdirSync(path.join(dataRoot, "previews"));
  } catch {
    return undefined;
  }
  return built.find((projectId) => previewToken(projectId) === token);
}

function latestFlutterJob(projectId: string): Job | null {
  return (
    listJobs(projectId).find(
      (item) => item.kind === "build" && item.title.startsWith("Flutter"),
    ) ?? null
  );
}

export async function flutterStatus(projectId: string): Promise<FlutterStatus> {
  const project = getProject(projectId);
  const app = flutterApp(projectId);
  // A new Flutter project is one before `flutter create` has finished.
  if (!app && project.template !== "flutter")
    return {
      flutter: false,
      sdk: null,
      folder: "",
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
    folder: app?.folder ?? "",
    needsWeb:
      !!app &&
      !fs.existsSync(
        path.join(projectDir(projectId), app.folder, "web", "index.html"),
      ),
    builtAt: built ? fs.statSync(index).mtime.toISOString() : null,
    url: built ? `/preview/${previewToken(projectId)}/` : null,
    job: latestFlutterJob(projectId),
  };
}

type Step =
  | { flutter: string[]; cwd: string }
  | { task: string; run: () => Promise<void> | void };

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

/** Runs Flutter commands and small tasks in order as one cancellable job. */
function runSteps(
  job: Job,
  steps: Step[],
  options: {
    done: string;
    failed: string;
    minutes: number;
    onSuccess?: () => void;
  },
): void {
  let stop: () => Promise<void> = async () => undefined;
  let finished = false;
  const finish = (status: "succeeded" | "failed", message: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    appendJob(job.id, `\n${message}\n`);
    finishJob(job.id, status, status === "succeeded" ? 0 : 1);
    if (status === "succeeded") options.onSuccess?.();
  };
  const timer = setTimeout(() => {
    appendJob(
      job.id,
      `\n[La tarea superó ${options.minutes} minutos. Deteniéndola…]\n`,
    );
    void stop()
      .catch(() => undefined)
      .finally(() => finish("failed", options.failed));
  }, options.minutes * 60_000);
  timer.unref();
  registerJobCancellation(job.id, async () => {
    finished = true;
    clearTimeout(timer);
    await stop();
  });
  const run = (index: number) => {
    if (finished || getJob(job.id).status !== "running" || isCancelling(job.id))
      return;
    if (index >= steps.length) return finish("succeeded", options.done);
    const step = steps[index]!;
    const next = (ok: boolean) =>
      ok ? run(index + 1) : finish("failed", options.failed);
    if ("flutter" in step) {
      stop = runFlutterStep(job, step.flutter, step.cwd, next);
      return;
    }
    stop = async () => undefined;
    Promise.resolve()
      .then(step.run)
      .then(
        () => next(true),
        (error) => {
          appendJob(
            job.id,
            `\n${step.task}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          next(false);
        },
      );
  };
  run(0);
}

const compressible = /\.(js|mjs|wasm|json|css|otf|ttf|svg|txt|map|frag)$/i;

function buildFiles(directory: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) buildFiles(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** Brotli copies next to each file: phones load the preview over the internet. */
async function compressBuild(directory: string): Promise<void> {
  for (const file of buildFiles(directory)) {
    if (!compressible.test(file)) continue;
    const data = fs.readFileSync(file);
    if (data.length < 1024) continue;
    const compressed = await brotli(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 7,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });
    if (compressed.length < data.length * 0.9)
      fs.writeFileSync(`${file}.br`, compressed);
  }
}

function removeCompressedCopies(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const file of buildFiles(directory))
    if (file.endsWith(".br")) fs.rmSync(file, { force: true });
}

/**
 * Builds the app for the web into AppBuilder's cache, outside the project.
 * An app without web support gets the standard web/ folder first.
 */
export async function startFlutterBuild(projectId: string): Promise<Job> {
  const project = getProject(projectId);
  const app = flutterApp(projectId);
  if (!app) {
    // A new Flutter project whose creation failed is created again.
    if (project.template === "flutter")
      return startFlutterCreate(projectId, project.organization);
    throw httpError(
      400,
      "Este proyecto no es una app de Flutter (falta pubspec.yaml con el SDK de Flutter).",
    );
  }
  const running = listJobs(projectId).find(
    (item) => item.kind === "build" && item.status === "running",
  );
  if (running) return running;
  await requireSdk();
  const directory = path.join(projectDir(projectId), app.folder);
  const output = previewDirectory(projectId);
  const job = createJob(
    projectId,
    "build",
    "Flutter · compilar la vista previa web",
  );
  if (app.folder)
    appendJob(job.id, `App de Flutter en la carpeta ${app.folder}/\n\n`);
  const steps: Step[] = [];
  if (!fs.existsSync(path.join(directory, "web", "index.html"))) {
    appendJob(
      job.id,
      "La app no tenía soporte web: se añade la carpeta web/ estándar para poder previsualizarla. Aparecerá en Cambios; puedes guardarla con un commit o descartarla.\n\n",
    );
    // Generate the template elsewhere so only web/ is added to the project.
    const scratch = path.join(dataRoot, "previews", projectId, "template");
    const templateName = /^[a-z][a-z0-9_]*$/.test(app.name) ? app.name : "app";
    steps.push(
      {
        task: "Preparar la plantilla web",
        run: () => fs.rmSync(scratch, { recursive: true, force: true }),
      },
      {
        flutter: [
          "create",
          "--no-pub",
          "--platforms=web",
          `--project-name=${templateName}`,
          scratch,
        ],
        cwd: dataRoot,
      },
      {
        task: "Añadir web/ al proyecto",
        run: () => {
          fs.cpSync(path.join(scratch, "web"), path.join(directory, "web"), {
            recursive: true,
            force: false,
          });
          fs.rmSync(scratch, { recursive: true, force: true });
        },
      },
    );
  }
  steps.push(
    {
      task: "Limpiar la compilación anterior",
      run: () => removeCompressedCopies(output),
    },
    {
      // Profile mode keeps class and method names, so errors stay readable.
      flutter: [
        "build",
        "web",
        "--profile",
        "--no-web-resources-cdn",
        "--no-wasm-dry-run",
        `--output=${output}`,
      ],
      cwd: directory,
    },
    { task: "Comprimir para el móvil", run: () => compressBuild(output) },
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  runSteps(job, steps, {
    done: "Vista previa lista.",
    failed:
      "La compilación falló. Revisa los errores de arriba o pídele al agente que los corrija desde la vista previa.",
    minutes: 20,
  });
  return job;
}

/**
 * Creates a new Flutter app with `flutter create`, saves the first commit and
 * then builds its preview.
 */
export async function startFlutterCreate(
  projectId: string,
  organization = "com.example",
): Promise<Job> {
  const project = getProject(projectId);
  const running = listJobs(projectId).find(
    (item) => item.kind === "build" && item.status === "running",
  );
  if (running) return running;
  await requireSdk();
  const directory = projectDir(projectId);
  const name = dartPackageName(project.name);
  const org = flutterOrganization(organization);
  const job = createJob(projectId, "build", "Flutter · crear la app");
  appendJob(
    job.id,
    `Creando ${project.name}: paquete ${name}, Bundle ID ${org}.${name}\n\n`,
  );
  runSteps(
    job,
    [
      {
        flutter: [
          "create",
          `--org=${org}`,
          `--project-name=${name}`,
          "--platforms=android,ios,web",
          ".",
        ],
        cwd: directory,
      },
      { task: "Guardar el primer commit", run: () => initialCommit(directory) },
    ],
    {
      done: "App creada. Ahora se compila su vista previa.",
      failed:
        "No se pudo crear la app. Revisa el registro y vuelve a intentarlo desde la vista previa.",
      minutes: 10,
      onSuccess: () =>
        void startFlutterBuild(projectId).catch((error) =>
          console.error("No se pudo compilar la nueva app de Flutter:", error),
        ),
    },
  );
  return job;
}

/*
 * Runs first in every preview. The app lives in an opaque-origin sandbox, so
 * this script:
 * - forwards console output and errors to the studio;
 * - loads the app's own scripts in CORS mode so errors are not muted as
 *   "Script error.";
 * - replaces storage that throws there (shared_preferences, Firebase Auth)
 *   with memory that lasts while the preview is open;
 * - hides service workers;
 * - reports the first frame (from Flutter's event, or its first canvas).
 */
const previewRuntime = `(()=>{
const post=m=>{try{parent.postMessage(m,"*")}catch{}};
const describe=v=>{if(typeof v==="string")return v;try{const t=String(v);if(t&&t!=="[object Object]")return t}catch{}try{return JSON.stringify(v)}catch{return Object.prototype.toString.call(v)}};
const log=(level,text)=>post({type:"appbuilder:console",level,text:String(text).slice(0,4000)});
for(const level of ["log","info","warn","error"]){const original=console[level];console[level]=(...args)=>{original.apply(console,args);log(level==="info"?"log":level,args.map(describe).join(" "))}}
addEventListener("error",e=>log("error",describe(e.error??e.message)));
addEventListener("unhandledrejection",e=>log("error","Error no controlado: "+describe(e.reason)));
try{const home=new URL(document.baseURI).origin;const source=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"src");Object.defineProperty(HTMLScriptElement.prototype,"src",{...source,set(value){try{if(new URL(String(value),document.baseURI).origin===home)this.crossOrigin="anonymous"}catch{}source.set.call(this,value)}})}catch{}
const memory=()=>{const data=new Map();const storage=Object.create(Storage.prototype);Object.defineProperties(storage,{length:{get:()=>data.size},key:{value:i=>[...data.keys()][i]??null},getItem:{value:k=>data.get(String(k))??null},setItem:{value:(k,v)=>{data.set(String(k),String(v))}},removeItem:{value:k=>{data.delete(String(k))}},clear:{value:()=>data.clear()}});return storage};
for(const name of ["localStorage","sessionStorage"]){try{window[name].length}catch{const storage=memory();try{Object.defineProperty(window,name,{configurable:true,enumerable:true,get:()=>storage})}catch{}}}
try{document.cookie}catch{const jar=new Map();try{Object.defineProperty(Document.prototype,"cookie",{configurable:true,get:()=>[...jar].map(([k,v])=>k+"="+v).join("; "),set:value=>{const pair=String(value).split(";")[0];const i=pair.indexOf("=");if(i>0)jar.set(pair.slice(0,i).trim(),pair.slice(i+1).trim())}})}catch{}}
try{delete Navigator.prototype.serviceWorker}catch{}
let shown=false;const ready=()=>{if(!shown){shown=true;post({type:"appbuilder:ready"})}};
addEventListener("flutter-first-frame",ready,{once:true});
const painted=root=>!!root.querySelector("canvas")||[...root.querySelectorAll("*")].some(el=>el.shadowRoot&&painted(el.shadowRoot));
const started=Date.now();const poll=setInterval(()=>{if(shown||Date.now()-started>120000)return clearInterval(poll);const view=document.querySelector("flutter-view");if(view&&painted(view.shadowRoot||view))setTimeout(ready,500)},700);
})();`;

/**
 * Serves a built preview by capability URL. Responses carry a CSP sandbox,
 * so the app runs in an opaque origin even if opened outside the iframe and
 * can never reach the studio session or API.
 */
export function serveFlutterPreview(frameAncestors: string[]) {
  return (req: Request, res: Response) => {
    const token = String(req.params.token);
    const projectId = previewProject(token);
    if (!projectId)
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
          `<base href="/preview/${token}/">`,
        )
        .replace(
          /<head[^>]*>/i,
          (head) => `${head}<script>${previewRuntime}</script>`,
        )
        // The bootstrap script too, so its errors are readable.
        .replace(
          /<script(?![^>]*\bcrossorigin\b)(?=[^>]*\ssrc="(?![a-z][a-z0-9+.-]*:|\/\/))/gi,
          '<script crossorigin="anonymous"',
        );
      return res.type("html").send(html);
    }
    const compressed = `${file}.br`;
    if (
      /\bbr\b/.test(String(req.headers["accept-encoding"] ?? "")) &&
      fs.existsSync(compressed) &&
      fs.lstatSync(compressed).isFile()
    ) {
      res.setHeader("Content-Encoding", "br");
      res.setHeader("Vary", "Accept-Encoding");
      res.type(path.extname(relative) || "application/octet-stream");
      return res.sendFile(`${relative}.br`, { root, dotfiles: "allow" });
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
