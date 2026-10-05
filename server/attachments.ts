import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { getProject, httpError, projectDir } from "./workspace.js";

/**
 * Files attached to agent prompts live inside the project, where both agents
 * can read them. The folder is hidden from the explorer and the file API
 * (.appbuilder is a protected name) and excluded from Git.
 */
export const ATTACHMENTS_FOLDER = ".appbuilder/attachments";
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const KEEP_DAYS = 14;
const storedFile = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

export type Attachment = {
  name: string;
  path: string;
  type: string;
  size: number;
};
export type ResolvedAttachment = Attachment & {
  absolute: string;
  image: boolean;
};

const extensionTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".zip": "application/zip",
};

/** Raster formats recognised by their first bytes, never by the name alone. */
export function imageType(data: Buffer): string | null {
  if (
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

function fileImageType(file: string): string | null {
  const handle = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(12);
    const read = fs.readSync(handle, head, 0, 12, 0);
    return imageType(head.subarray(0, read));
  } finally {
    fs.closeSync(handle);
  }
}

function typeFromName(name: string): string {
  return (
    extensionTypes[path.extname(name).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** The name shown to people: the stored name without its unique prefix. */
export function displayName(file: string): string {
  return file.replace(/^\d{8}-\d{6}-[a-f\d]{6}-/, "");
}

/** A unique, portable file name that keeps a readable part of the original. */
export function storedName(original: unknown, now = new Date()): string {
  const base = path.basename(
    String(typeof original === "string" ? original : "").replaceAll("\\", "/"),
  );
  const extension = path
    .extname(base)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, "")
    .slice(0, 10);
  const stem =
    path
      .basename(base, path.extname(base))
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "archivo";
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}-${stem}${extension.length > 1 ? extension : ""}`;
}

function rejectLink(target: string) {
  try {
    if (fs.lstatSync(target).isSymbolicLink())
      throw httpError(400, "La carpeta de adjuntos no es válida.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function attachmentsDirectory(projectId: string, create: boolean): string {
  const root = projectDir(projectId);
  const parent = path.join(root, ".appbuilder");
  const directory = path.join(parent, "attachments");
  // Never write or read through a link out of the project.
  rejectLink(parent);
  rejectLink(directory);
  if (create) {
    fs.mkdirSync(directory, { recursive: true });
    excludeFromGit(root);
  }
  return directory;
}

/** Attachments never appear in Cambios, checkpoints or commits. */
export function excludeFromGit(root: string): void {
  const git = path.join(root, ".git");
  try {
    if (!fs.lstatSync(git).isDirectory()) return;
  } catch {
    return;
  }
  const file = path.join(git, "info", "exclude");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    /* Created below. */
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === "/.appbuilder/"))
    return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${current && !current.endsWith("\n") ? "\n" : ""}# AppBuilder: adjuntos de los mensajes al agente\n/.appbuilder/\n`,
  );
}

function prune(directory: string, now = Date.now()) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_DAYS * 86_400_000)
        fs.rmSync(file, { force: true });
    } catch {
      /* Another request may have removed it. */
    }
  }
}

export function saveAttachment(
  projectId: string,
  name: unknown,
  data: Buffer,
): Attachment {
  getProject(projectId);
  if (!data.length) throw httpError(400, "El archivo está vacío.");
  if (data.length > MAX_BYTES)
    throw httpError(413, "El archivo supera el límite de 20 MB.");
  const directory = attachmentsDirectory(projectId, true);
  prune(directory);
  const file = storedName(name);
  fs.writeFileSync(path.join(directory, file), data, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    name: displayName(file),
    path: `${ATTACHMENTS_FOLDER}/${file}`,
    type: imageType(data) ?? typeFromName(file),
    size: data.length,
  };
}

/** Checks the attachments named in an agent request and describes them. */
export function resolveAttachments(
  projectId: string,
  value: unknown,
): ResolvedAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_FILES)
    throw httpError(400, `Adjunta como máximo ${MAX_FILES} archivos.`);
  const directory = attachmentsDirectory(projectId, false);
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const relative = typeof item === "string" ? item : "";
    const file = relative.startsWith(`${ATTACHMENTS_FOLDER}/`)
      ? relative.slice(ATTACHMENTS_FOLDER.length + 1)
      : "";
    if (!storedFile.test(file) || file.includes(".."))
      throw httpError(400, "Uno de los adjuntos no es válido.");
    if (seen.has(file)) return [];
    seen.add(file);
    const absolute = path.join(directory, file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      throw httpError(
        404,
        `El adjunto ${displayName(file)} ya no existe. Vuelve a adjuntarlo.`,
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw httpError(400, "Uno de los adjuntos no es válido.");
    const image = fileImageType(absolute);
    return [
      {
        name: displayName(file),
        path: relative,
        type: image ?? typeFromName(file),
        size: stat.size,
        absolute,
        image: !!image,
      },
    ];
  });
}

const readUpload = express.raw({
  type: "application/octet-stream",
  limit: MAX_BYTES,
});

export function createAttachmentsRouter(): Router {
  const router = Router();
  router.post(
    "/projects/:id/attachments",
    (req: Request, res: Response, next: NextFunction) =>
      readUpload(req, res, (error?: unknown) => {
        if (
          (error as { type?: string } | undefined)?.type === "entity.too.large"
        )
          return next(httpError(413, "El archivo supera el límite de 20 MB."));
        next(error);
      }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body))
        throw httpError(400, "Envía el archivo como application/octet-stream.");
      res
        .status(201)
        .json(saveAttachment(String(req.params.id), req.query.name, req.body));
    },
  );
  router.get("/projects/:id/attachments/:file", (req, res) => {
    const file = String(req.params.file);
    if (!storedFile.test(file) || file.includes(".."))
      throw httpError(404, "El adjunto no existe.");
    const directory = attachmentsDirectory(String(req.params.id), false);
    const absolute = path.join(directory, file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      throw httpError(404, "El adjunto no existe.");
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw httpError(404, "El adjunto no existe.");
    const image = fileImageType(absolute);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.setHeader("Cache-Control", "private, max-age=604800, immutable");
    // Only verified raster images open in place; everything else downloads.
    if (image) res.type(image);
    else {
      // attachment() guesses a type from the name; force a plain download.
      res.attachment(displayName(file));
      res.type("application/octet-stream");
    }
    res.sendFile(file, { root: directory, dotfiles: "allow" });
  });
  return router;
}
