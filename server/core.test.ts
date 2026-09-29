import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Server } from "node:http";
import type { Job } from "./jobs.js";
import type { FileEntry, Project } from "./workspace.js";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-core-test-"),
);
process.env.APPBUILDER_DATA_DIR = testRoot;
const workspace = await import("./workspace.js");
const jobs = await import("./jobs.js");
const { createCheckpoint, createCoreRouter, getGitStatus } =
  await import("./core.js");
let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createCoreRouter());
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status || 500).json({ error: error.message }),
  );
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api";
});

after(async () => {
  for (const project of workspace.listProjects())
    for (const job of jobs.listJobs(project.id))
      if (job.status === "running") await jobs.cancelJob(job.id);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const resolved = path.resolve(testRoot);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^appbuilder-core-test-/);
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function request(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForJob(
  id: string,
  predicate = (job: Job) => job.status !== "running",
): Promise<Job> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = jobs.getJob(id);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    "La tarea no alcanzó el estado esperado: " + jobs.getJob(id).output,
  );
}

test("se crea un proyecto editable y persistente con la plantilla Orbit Notes", async () => {
  const response = await request("/projects");
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].name, "Orbit Notes");
  const id = response.body[0].id;
  const files = await request("/projects/" + id + "/files");
  assert.ok(files.body.some((file: FileEntry) => file.path === "index.html"));
  const saved = await request("/projects/" + id + "/file", "PUT", {
    path: "src/new.js",
    content: "export const answer = 42;\n",
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await request("/projects/" + id + "/file?path=src%2Fnew.js")).body.content,
    "export const answer = 42;\n",
  );
  assert.ok(
    JSON.parse(
      fs.readFileSync(path.join(testRoot, "projects.json"), "utf8"),
    ).some((project: Project) => project.id === id),
  );
});

test("rechaza rutas externas, credenciales y enlaces simbólicos sin revelar archivos", async (t) => {
  const project = workspace.createProject({
    name: "Rutas seguras",
    template: "web",
  });
  for (const bad of [
    "../secret.txt",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "a/../../secret",
    ".git/config",
    "node_modules/a.js",
    ".env",
    ".env.local",
    "signing.p12",
    "x/../index.html",
    "nul.txt",
    "file:stream",
    "file.",
  ]) {
    assert.throws(() => workspace.readFile(project.id, bad), bad);
    assert.throws(() => workspace.writeFile(project.id, bad, "no"), bad);
  }
  fs.writeFileSync(
    path.join(workspace.projectDir(project.id), ".env"),
    "EXAMPLE_SECRET=private",
  );
  assert.ok(
    !workspace.listFiles(project.id).some((file) => file.path === ".env"),
  );
  const outside = path.join(testRoot, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "private");
  const junction = path.join(workspace.projectDir(project.id), "linked");
  try {
    fs.symlinkSync(
      outside,
      junction,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.diagnostic(
      "No se pudo crear un enlace simbólico en este sistema: " +
        (error as Error).message,
    );
    return;
  }
  assert.throws(
    () => workspace.readFile(project.id, "linked/secret.txt"),
    /enlaces simbólicos/,
  );
  assert.throws(
    () => workspace.writeFile(project.id, "linked/new.txt", "no"),
    /enlaces simbólicos/,
  );
  assert.ok(
    !workspace
      .listFiles(project.id)
      .some((file) => file.path.startsWith("linked")),
  );
  const invalid = await request(
    "/projects/" +
      project.id +
      "/file?path=" +
      encodeURIComponent("../secret.txt"),
  );
  assert.equal(invalid.status, 400);
});

test("creación exclusiva, eliminación individual y límites de tamaño", async () => {
  const project = workspace.createProject({
    name: "Archivos",
    template: "react",
  });
  assert.ok(
    workspace.listFiles(project.id).some((file) => file.path === "src/App.jsx"),
  );
  const prefix = "/projects/" + project.id;
  assert.equal(
    (
      await request(prefix + "/files", "POST", {
        path: "hello.txt",
        content: "hola",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(prefix + "/files", "POST", {
        path: "hello.txt",
        content: "sobrescribir",
      })
    ).status,
    409,
  );
  assert.equal(workspace.readFile(project.id, "hello.txt").content, "hola");
  assert.equal(
    (await request(prefix + "/files?path=src", "DELETE")).status,
    400,
  );
  assert.equal(
    (await request(prefix + "/files?path=hello.txt", "DELETE")).status,
    200,
  );
  assert.equal((await request(prefix + "/file?path=hello.txt")).status, 404);
  assert.throws(
    () =>
      workspace.writeFile(
        project.id,
        "big.txt",
        "x".repeat(2 * 1024 * 1024 + 1),
      ),
    /2 MB/,
  );
  assert.equal(
    (await request("/projects", "POST", { name: "", template: "web" })).status,
    400,
  );
});

test("la terminal ejecuta procesos reales, informa el código de salida y no hereda tokens", async () => {
  const project = workspace.createProject({
    name: "Terminal",
    template: "web",
  });
  process.env.OPENAI_API_KEY = "unit-test-do-not-inherit";
  process.env.ANTHROPIC_API_KEY = "unit-test-do-not-inherit";
  process.env.APPBUILDER_PAIRING_TOKEN = "unit-test-do-not-inherit";
  const command =
    '"' +
    process.execPath +
    '" -e "console.log(process.env.OPENAI_API_KEY || \'sin-token\'); console.log(process.cwd()); process.exit(7)"';
  const response = await request(
    "/projects/" + project.id + "/commands",
    "POST",
    { command },
  );
  assert.equal(response.status, 202);
  const job = await waitForJob(response.body.id);
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 7);
  assert.match(job.output, /sin-token/);
  assert.ok(job.output.includes(workspace.projectDir(project.id)));
  assert.ok(!job.output.includes("unit-test-do-not-inherit"));
  assert.equal(jobs.commandEnvironment().ANTHROPIC_API_KEY, undefined);
  assert.equal(jobs.commandEnvironment().APPBUILDER_PAIRING_TOKEN, undefined);
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.APPBUILDER_PAIRING_TOKEN;
  const success = jobs.startCommand(
    project.id,
    '"' + process.execPath + '" -e "console.log(6 * 7)"',
  );
  assert.equal((await waitForJob(success.id)).status, "succeeded");
  assert.match(success.output, /42/);
});

test("cancela también los procesos descendientes del comando", async () => {
  const project = workspace.createProject({
    name: "Cancelación",
    template: "web",
  });
  workspace.writeFile(
    project.id,
    "child.cjs",
    "setTimeout(() => require('node:fs').writeFileSync('must-not-exist.txt', 'error'), 5000);\n",
  );
  workspace.writeFile(
    project.id,
    "parent.cjs",
    "require('node:child_process').spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' }); console.log('parent-ready'); setTimeout(() => {}, 10000);\n",
  );
  const job = jobs.startCommand(
    project.id,
    '"' + process.execPath + '" parent.cjs',
  );
  await waitForJob(job.id, (item) => item.output.includes("parent-ready"));
  assert.equal(
    (await request("/jobs/" + job.id + "/cancel", "POST")).body.status,
    "cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 5100));
  assert.equal(
    fs.existsSync(
      path.join(workspace.projectDir(project.id), "must-not-exist.txt"),
    ),
    false,
  );
  assert.equal(jobs.getJob(job.id).status, "cancelled");
});

test("limita concurrencia y registros, y conserva el estado de tareas", async () => {
  const project = workspace.createProject({ name: "Límites", template: "web" });
  const active = Array.from({ length: 4 }, (_, index) =>
    jobs.createJob(project.id, "agent", "Tarea " + index),
  );
  assert.throws(
    () => jobs.createJob(project.id, "agent", "Exceso"),
    /cuatro tareas/,
  );
  jobs.appendJob(active[0]!.id, "x".repeat(300_000));
  assert.ok(jobs.getJob(active[0]!.id).output.length <= 256_100);
  assert.match(jobs.getJob(active[0]!.id).output, /recortado/);
  for (const job of active) jobs.finishJob(job.id, "succeeded", 0);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(testRoot, "jobs.json"), "utf8"),
  ) as Job[];
  assert.equal(
    persisted.find((job) => job.id === active[0]!.id)?.status,
    "succeeded",
  );
  assert.equal((await jobs.cancelJob(active[0]!.id)).status, "succeeded");
});

test("Git guarda cambios reales, omite credenciales y rechaza secretos ya preparados", async () => {
  const project = workspace.createProject({ name: "Git", template: "web" });
  const directory = workspace.projectDir(project.id);
  workspace.writeFile(project.id, "feature.js", "export const ready = true;\n");
  workspace.writeFile(project.id, ".gitignore", "");
  fs.writeFileSync(path.join(directory, ".env"), "TEST_SECRET=do-not-commit");
  const before = await getGitStatus(project.id);
  assert.equal(before.branch, "main");
  assert.ok(before.changes.some((change) => change.path === "feature.js"));
  assert.ok(!before.changes.some((change) => change.path === ".env"));
  const committed = await request(
    "/projects/" + project.id + "/git/commit",
    "POST",
    { message: "Añadir funcionalidad" },
  );
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.log[0].message, "Añadir funcionalidad");
  assert.equal(committed.body.changes.length, 0);
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.ok(!tracked.includes(".env"));
  execFileSync("git", ["add", ".env"], { cwd: directory, windowsHide: true });
  workspace.writeFile(
    project.id,
    "feature.js",
    "export const ready = false;\n",
  );
  const refused = await request(
    "/projects/" + project.id + "/git/commit",
    "POST",
    { message: "No incluir secreto" },
  );
  assert.equal(refused.status, 403);
});

test("los checkpoints, diff y restauración recuperan el contenido guardado", async () => {
  const project = workspace.createProject({
    name: "Restauración",
    template: "web",
  });
  const original = workspace.readFile(project.id, "app.js").content;
  const clean = await createCheckpoint(project.id);
  assert.equal(clean.created, false);
  assert.match(clean.hash, /^[0-9a-f]{40}$/);
  workspace.writeFile(
    project.id,
    "app.js",
    original + "\n// cambio previo al agente\n",
  );
  const checkpoint = await createCheckpoint(project.id);
  assert.equal(checkpoint.created, true);
  assert.notEqual(checkpoint.hash, clean.hash);
  workspace.writeFile(
    project.id,
    "app.js",
    'throw new Error("cambio del agente");\n',
  );
  const diff = await request(
    "/projects/" + project.id + "/git/diff?path=app.js",
  );
  assert.equal(diff.status, 200);
  assert.match(diff.body.diff, /cambio del agente/);
  const restore = await request(
    "/projects/" + project.id + "/git/restore",
    "POST",
    { path: "app.js" },
  );
  assert.equal(restore.status, 200);
  assert.equal(
    workspace.readFile(project.id, "app.js").content,
    original + "\n// cambio previo al agente\n",
  );
  const unsafeRestore = await request(
    "/projects/" + project.id + "/git/restore",
    "POST",
    { path: "../outside" },
  );
  assert.equal(unsafeRestore.status, 400);
  workspace.writeFile(project.id, "new.txt", "nuevo\n");
  assert.equal(
    (
      await request("/projects/" + project.id + "/git/restore", "POST", {
        path: "new.txt",
      })
    ).status,
    400,
  );
  const newDiff = await request(
    "/projects/" + project.id + "/git/diff?path=new.txt",
  );
  assert.match(newDiff.body.diff, /\+nuevo/);
});
