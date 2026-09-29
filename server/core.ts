import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import {
  createProject,
  deleteFile,
  getProject,
  httpError,
  isProtectedName,
  listFiles,
  listProjects,
  projectDir,
  protectedPath,
  readFile,
  writeFile,
} from "./workspace.js";
import {
  cancelJob,
  commandEnvironment,
  getJob,
  listJobs,
  startCommand,
} from "./jobs.js";

const execute = promisify(execFile);

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, message);
  return value;
}

async function git(projectId: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute(
      "git",
      [
        "--no-pager",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: projectDir(projectId),
        env: commandEnvironment(),
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    return stdout;
  } catch (error) {
    const failure = error as Error & {
      code?: string | number;
      stderr?: string;
    };
    if (failure.code === "ENOENT")
      throw httpError(503, "Git no está instalado en la máquina del servidor.");
    throw httpError(
      400,
      failure.stderr?.trim() ||
        failure.message ||
        "No se pudo completar la operación de Git.",
    );
  }
}

type Change = { path: string; status: string };

function accessibleGitPath(relativePath: string): boolean {
  return !relativePath.replaceAll("\\", "/").split("/").some(isProtectedName);
}

function parseStatus(output: string): Change[] {
  const entries = output.split("\0");
  const result: Change[] = [];
  for (let i = 0; i < entries.length; i++) {
    const record = entries[i]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2).trim();
    const file = record.slice(3);
    let previousPath: string | undefined;
    if (/[RC]/.test(record.slice(0, 2))) previousPath = entries[++i];
    if (
      accessibleGitPath(file) &&
      (!previousPath || accessibleGitPath(previousPath))
    )
      result.push({ path: file, status });
  }
  return result;
}

export async function getGitStatus(projectId: string): Promise<{
  branch: string;
  changes: Change[];
  log: { hash: string; message: string; date: string }[];
}> {
  const directory = projectDir(projectId);
  const gitPath = path.join(directory, ".git");
  if (
    !fs.existsSync(gitPath) ||
    !fs.lstatSync(gitPath).isDirectory() ||
    fs.lstatSync(gitPath).isSymbolicLink()
  )
    throw httpError(
      400,
      "El proyecto no tiene un repositorio Git local válido.",
    );
  const [branch, status, log] = await Promise.all([
    git(projectId, ["branch", "--show-current"]),
    git(projectId, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(projectId, ["log", "-12", "--format=%H%x00%s%x00%aI%x00"]).catch(
      () => "",
    ),
  ]);
  const logParts = log.trim().split("\0");
  const entries: { hash: string; message: string; date: string }[] = [];
  for (let i = 0; i + 2 < logParts.length; i += 3)
    entries.push({
      hash: logParts[i]!.trim(),
      message: logParts[i + 1]!,
      date: logParts[i + 2]!,
    });
  return {
    branch: branch.trim() || "HEAD",
    changes: parseStatus(status),
    log: entries,
  };
}

const commitsInProgress = new Set<string>();

async function commitChanges(
  projectId: string,
  message: string,
): Promise<{ hash: string; created: boolean }> {
  if (commitsInProgress.has(projectId))
    throw httpError(409, "Ya se está guardando un commit en este proyecto.");
  commitsInProgress.add(projectId);
  try {
    const status = await getGitStatus(projectId);
    // Disable rename detection so both sides of a staged rename are checked.
    const previouslyStaged = await git(projectId, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
    ]);
    if (
      previouslyStaged
        .split("\0")
        .filter(Boolean)
        .some((file) => !accessibleGitPath(file))
    )
      throw httpError(
        403,
        "Hay archivos de credenciales preparados en Git. Retíralos del índice antes de guardar el commit.",
      );
    if (!status.changes.length)
      return { hash: status.log[0]?.hash ?? "", created: false };
    const files = status.changes.map((change) => change.path);
    for (const file of files) protectedPath(projectId, file, true);
    for (let offset = 0; offset < files.length; offset += 100)
      await git(projectId, [
        "add",
        "--all",
        "--",
        ...files.slice(offset, offset + 100).map((file) => ":(literal)" + file),
      ]);
    const staged = await git(projectId, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
    ]);
    if (
      staged
        .split("\0")
        .filter(Boolean)
        .some((file) => !accessibleGitPath(file))
    )
      throw httpError(
        403,
        "Hay archivos de credenciales preparados en Git. Retíralos del índice antes de guardar el commit.",
      );
    await git(projectId, [
      "-c",
      "user.name=AppBuilder",
      "-c",
      "user.email=local@appbuilder.dev",
      "commit",
      "-m",
      message,
    ]);
    return {
      hash: (await git(projectId, ["rev-parse", "HEAD"])).trim(),
      created: true,
    };
  } finally {
    commitsInProgress.delete(projectId);
  }
}

export async function createCheckpoint(
  projectId: string,
  message = "Punto de restauración antes del agente",
): Promise<{ hash: string; created: boolean }> {
  return commitChanges(projectId, message);
}

export async function getFileDiff(
  projectId: string,
  relativePath: string,
): Promise<{ diff: string }> {
  const fullPath = protectedPath(projectId, relativePath, true);
  if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isFile())
    throw httpError(400, "La ruta debe corresponder a un archivo.");
  const pathspec = ":(literal)" + relativePath.replaceAll("\\", "/");
  const tracked = await git(projectId, ["ls-files", "-z", "--", pathspec]);
  if (!tracked.trim()) {
    const content = readFile(projectId, relativePath).content;
    const lines = content.split("\n");
    return {
      diff: (
        "--- /dev/null\n+++ b/" +
        relativePath +
        "\n@@ -0,0 +1," +
        lines.length +
        " @@\n" +
        lines.map((line) => "+" + line).join("\n")
      ).slice(0, 512_000),
    };
  }
  return {
    diff: (
      await git(projectId, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
        pathspec,
      ])
    ).slice(0, 512_000),
  };
}

export async function restoreFile(
  projectId: string,
  relativePath: string,
): Promise<void> {
  protectedPath(projectId, relativePath, true);
  if (commitsInProgress.has(projectId))
    throw httpError(409, "Ya hay una operación de Git en curso.");
  commitsInProgress.add(projectId);
  try {
    const pathspec = ":(literal)" + relativePath.replaceAll("\\", "/");
    const entry = await git(projectId, [
      "ls-tree",
      "-z",
      "HEAD",
      "--",
      pathspec,
    ]);
    if (!/^(100644|100755) blob /.test(entry))
      throw httpError(
        400,
        "Solo se pueden restaurar archivos normales guardados en el último commit.",
      );
    await git(projectId, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      pathspec,
    ]);
  } finally {
    commitsInProgress.delete(projectId);
  }
}

export function createCoreRouter(): Router {
  const router = Router();
  router.get("/projects", (_req, res) => res.json(listProjects()));
  router.post("/projects", (req, res) => {
    if (!req.body || typeof req.body !== "object")
      throw httpError(400, "Introduce los datos del proyecto.");
    const project = createProject({
      name: req.body.name,
      template: req.body.template ?? "web",
      description: req.body.description,
    });
    res.status(201).json(project);
  });
  router.get("/projects/:id", (req, res) =>
    res.json(getProject(req.params.id)),
  );
  router.get("/projects/:id/files", (req, res) =>
    res.json(listFiles(req.params.id)),
  );
  router.get("/projects/:id/file", (req, res) =>
    res.json(
      readFile(
        req.params.id,
        requiredString(req.query.path, "Indica la ruta del archivo."),
      ),
    ),
  );
  router.put("/projects/:id/file", (req, res) => {
    const relativePath = requiredString(
      req.body?.path ?? req.query.path,
      "Indica la ruta del archivo.",
    );
    res.json(
      writeFile(
        req.params.id,
        relativePath,
        req.body?.content,
        false,
        req.body?.expectedContent,
      ),
    );
  });
  router.post("/projects/:id/files", (req, res) => {
    const relativePath = requiredString(
      req.body?.path,
      "Indica la ruta del nuevo archivo.",
    );
    res
      .status(201)
      .json(
        writeFile(req.params.id, relativePath, req.body?.content ?? "", true),
      );
  });
  router.delete("/projects/:id/files", (req, res) => {
    deleteFile(
      req.params.id,
      requiredString(req.query.path, "Indica la ruta del archivo."),
    );
    res.json({ ok: true });
  });
  router.delete("/projects/:id/file", (req, res) => {
    deleteFile(
      req.params.id,
      requiredString(req.query.path, "Indica la ruta del archivo."),
    );
    res.json({ ok: true });
  });
  router.post("/projects/:id/commands", (req, res) =>
    res.status(202).json(startCommand(req.params.id, req.body?.command)),
  );
  router.get("/projects/:id/jobs", (req, res) =>
    res.json(listJobs(req.params.id)),
  );
  router.get("/jobs/:id", (req, res) => res.json(getJob(req.params.id)));
  router.post("/jobs/:id/cancel", async (req, res) =>
    res.json(await cancelJob(req.params.id)),
  );
  router.get("/projects/:id/git", async (req, res) =>
    res.json(await getGitStatus(req.params.id)),
  );
  router.get("/projects/:id/git/diff", async (req, res) =>
    res.json(
      await getFileDiff(
        req.params.id,
        requiredString(
          req.query.path,
          "Indica el archivo que quieres revisar.",
        ),
      ),
    ),
  );
  router.post("/projects/:id/git/restore", async (req, res) => {
    await restoreFile(
      req.params.id,
      requiredString(
        req.body?.path,
        "Indica el archivo que quieres restaurar.",
      ),
    );
    res.json({ ok: true });
  });
  router.post("/projects/:id/git/commit", async (req, res) => {
    const message = requiredString(
      req.body?.message,
      "Escribe un mensaje para el commit.",
    ).trim();
    if (message.length > 500 || message.includes("\0"))
      throw httpError(
        400,
        "El mensaje debe tener como máximo 500 caracteres válidos.",
      );
    const id = req.params.id;
    const result = await commitChanges(id, message);
    if (!result.created) throw httpError(409, "No hay cambios para guardar.");
    res.json(await getGitStatus(id));
  });
  return router;
}
