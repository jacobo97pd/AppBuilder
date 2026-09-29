import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { templateFiles, type ProjectTemplate } from "./templates.js";

export interface Project {
  id: string;
  name: string;
  description: string;
  template: ProjectTemplate;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
}

export const dataRoot = path.resolve(
  process.env.APPBUILDER_DATA_DIR || path.join(process.cwd(), ".appbuilder"),
);
const projectsRoot = path.join(dataRoot, "projects");
const metadataPath = path.join(dataRoot, "projects.json");
const maxFileBytes = 2 * 1024 * 1024;
const forbiddenNames = new Set([
  ".git",
  ".appbuilder",
  "node_modules",
  ".npmrc",
  ".netrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".ssh",
  ".aws",
  ".azure",
  ".config",
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "serviceaccount.json",
  "google-services.json",
]);
const secretExtension = /\.(pem|key|p8|p12|pfx|mobileprovision|keystore|jks)$/i;

export function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** OS and toolchain essentials; provider/server credentials never reach ordinary subprocesses. */
export function safeProcessEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "USER",
    "USERNAME",
    "SHELL",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (allowed.has(key.toUpperCase())) env[key] = value;
  return { ...env, FORCE_COLOR: "0", CI: "1", GIT_TERMINAL_PROMPT: "0" };
}

function ensureStorage(): void {
  fs.mkdirSync(projectsRoot, { recursive: true });
  if (fs.lstatSync(projectsRoot).isSymbolicLink())
    throw httpError(
      400,
      "La carpeta de proyectos no puede ser un enlace simbólico.",
    );
}

function readProjects(): Project[] {
  ensureStorage();
  if (!fs.existsSync(metadataPath)) return [];
  if (fs.lstatSync(metadataPath).isSymbolicLink())
    throw httpError(400, "Los metadatos no pueden ser un enlace simbólico.");
  const projects: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (!Array.isArray(projects))
    throw httpError(500, "No se pueden leer los metadatos de proyectos.");
  return projects as Project[];
}

function saveProjects(projects: Project[]): void {
  ensureStorage();
  const temporary = metadataPath + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(projects, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, metadataPath);
}

export function ensureSeedProject(): Project | undefined {
  const projects = readProjects();
  if (projects.length) return projects[0];
  return createProject({
    name: "Orbit Notes",
    description: "Un espacio tranquilo para tus próximas grandes ideas.",
    template: "web",
  });
}

export function listProjects(): Project[] {
  ensureSeedProject();
  return readProjects().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): Project {
  if (
    typeof id !== "string" ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)
  )
    throw httpError(404, "No se ha encontrado el proyecto.");
  const project = readProjects().find((item) => item.id === id);
  if (!project) throw httpError(404, "No se ha encontrado el proyecto.");
  return project;
}

export function projectDir(id: string): string {
  getProject(id);
  const root = path.join(projectsRoot, id);
  if (!fs.existsSync(root))
    throw httpError(404, "La carpeta del proyecto no existe.");
  if (fs.lstatSync(root).isSymbolicLink())
    throw httpError(400, "El proyecto no puede ser un enlace simbólico.");
  return root;
}

export function isProtectedName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    forbiddenNames.has(lower) ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    secretExtension.test(lower)
  );
}

/** Filesystem APIs reject symlinks and traversal. Commands are trusted local processes, not a sandbox. */
export function protectedPath(
  id: string,
  relativePath: string,
  allowMissing = false,
): string {
  const root = projectDir(id);
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(relativePath)
  )
    throw httpError(400, "La ruta del archivo no es válida.");
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes(":"))
    throw httpError(400, "La ruta debe ser relativa al proyecto.");
  const parts = normalized.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /[<>"|?*]/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
    )
  )
    throw httpError(400, "La ruta del archivo no es válida.");
  if (parts.some(isProtectedName))
    throw httpError(
      403,
      "Esta ruta contiene dependencias, metadatos o credenciales protegidas.",
    );
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing)
        continue;
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw httpError(404, "El archivo no existe.");
      throw error;
    }
    if (stat.isSymbolicLink())
      throw httpError(403, "No se permite acceder a enlaces simbólicos.");
    if (stat.isFile() && stat.nlink > 1)
      throw httpError(
        403,
        "No se permite acceder a archivos con enlaces físicos.",
      );
    if (index < parts.length - 1 && !stat.isDirectory())
      throw httpError(400, "Un componente de la ruta no es una carpeta.");
  }
  const relative = path.relative(root, current);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw httpError(403, "La ruta está fuera del proyecto.");
  return current;
}

export function listFiles(id: string): FileEntry[] {
  const root = projectDir(id);
  const result: FileEntry[] = [];
  function visit(directory: string, prefix: string, depth: number): void {
    if (depth > 15 || result.length >= 4000) return;
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
    for (const entry of entries) {
      if (result.length >= 4000) break;
      if (
        entry.isSymbolicLink() ||
        isProtectedName(entry.name) ||
        ["dist", "build", "coverage", ".next", ".vite"].includes(entry.name)
      )
        continue;
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) continue;
      if (stat.isDirectory()) {
        result.push({ path: relative, name: entry.name, type: "directory" });
        visit(full, relative, depth + 1);
      } else if (stat.isFile())
        result.push({
          path: relative,
          name: entry.name,
          type: "file",
          size: stat.size,
        });
    }
  }
  visit(root, "", 0);
  return result;
}

export function readFile(
  id: string,
  relativePath: string,
): { path: string; content: string } {
  const file = protectedPath(id, relativePath);
  const stat = fs.statSync(file);
  if (!stat.isFile())
    throw httpError(400, "La ruta no corresponde a un archivo.");
  if (stat.size > maxFileBytes)
    throw httpError(413, "El editor admite archivos de hasta 2 MB.");
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0))
    throw httpError(415, "El editor solo admite archivos de texto.");
  return {
    path: relativePath.replaceAll("\\", "/"),
    content: buffer.toString("utf8"),
  };
}

function touchProject(id: string): void {
  const projects = readProjects();
  const project = projects.find((item) => item.id === id);
  if (project) project.updatedAt = new Date().toISOString();
  saveProjects(projects);
}

export function writeFile(
  id: string,
  relativePath: string,
  content: string,
  exclusive = false,
  expectedContent?: string,
): { path: string; content: string } {
  if (typeof content !== "string")
    throw httpError(400, "El contenido debe ser texto.");
  if (Buffer.byteLength(content, "utf8") > maxFileBytes)
    throw httpError(413, "El editor admite archivos de hasta 2 MB.");
  const file = protectedPath(id, relativePath, true);
  if (expectedContent !== undefined) {
    if (typeof expectedContent !== "string")
      throw httpError(400, "El contenido de referencia debe ser texto.");
    if (
      !fs.existsSync(file) ||
      readFile(id, relativePath).content !== expectedContent
    )
      throw httpError(
        409,
        "El archivo ha cambiado en el servidor. Recarga su contenido antes de guardar para conservar ambos cambios.",
      );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  protectedPath(id, relativePath, true);
  try {
    fs.writeFileSync(file, content, {
      encoding: "utf8",
      flag: exclusive ? "wx" : "w",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw httpError(409, "Ya existe un archivo con ese nombre.");
    if ((error as NodeJS.ErrnoException).code === "EISDIR")
      throw httpError(400, "La ruta corresponde a una carpeta.");
    throw error;
  }
  touchProject(id);
  return { path: relativePath.replaceAll("\\", "/"), content };
}

export function deleteFile(id: string, relativePath: string): void {
  const file = protectedPath(id, relativePath);
  if (!fs.statSync(file).isFile())
    throw httpError(400, "Solo se pueden eliminar archivos individuales.");
  fs.unlinkSync(file);
  touchProject(id);
}

export function createProject(input: {
  name: string;
  template: ProjectTemplate;
  description?: string;
}): Project {
  if (
    typeof input.name !== "string" ||
    input.name.trim().length < 1 ||
    input.name.trim().length > 80
  )
    throw httpError(
      400,
      "El nombre del proyecto debe tener entre 1 y 80 caracteres.",
    );
  if (input.template !== "web" && input.template !== "react")
    throw httpError(400, "La plantilla debe ser web o react.");
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 500)
  )
    throw httpError(
      400,
      "La descripción debe tener como máximo 500 caracteres.",
    );
  const projects = readProjects();
  if (projects.length >= 200)
    throw httpError(409, "Se ha alcanzado el límite de 200 proyectos locales.");
  const now = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    name: input.name.trim(),
    description: input.description?.trim() || "",
    template: input.template,
    createdAt: now,
    updatedAt: now,
  };
  const directory = path.join(projectsRoot, project.id);
  fs.mkdirSync(directory);
  for (const [relative, content] of Object.entries(
    templateFiles(input.template),
  )) {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const gitOptions = {
    cwd: directory,
    windowsHide: true,
    timeout: 15_000,
    encoding: "utf8" as const,
    env: safeProcessEnvironment(),
  };
  const init = spawnSync("git", ["init", "-b", "main"], gitOptions);
  if (init.status === 0) {
    spawnSync("git", ["add", "--", "."], gitOptions);
    spawnSync(
      "git",
      [
        "-c",
        "user.name=AppBuilder",
        "-c",
        "user.email=local@appbuilder.dev",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Crear proyecto",
      ],
      gitOptions,
    );
  }
  saveProjects([...projects, project]);
  return project;
}
