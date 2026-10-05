import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const dataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-attachments-test-"),
);
process.env.APPBUILDER_DATA_DIR = dataRoot;
const workspace = await import("./workspace.js");
const attachments = await import("./attachments.js");
const agents = await import("./agents.js");

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
let server: Server;
let base = "";
let projectId = "";

before(async () => {
  projectId = workspace.createProject({ name: "Adjuntos", template: "web" }).id;
  const app = express();
  app.use(express.json());
  app.use("/api", attachments.createAttachmentsRouter());
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status ?? 500).json({ error: error.message }),
  );
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}/attachments`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const upload = (name: string, body: Buffer) =>
  fetch(`${base}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(body),
  });

test("guarda adjuntos dentro del proyecto, fuera de Git y con nombres seguros", async () => {
  const response = await upload("Captura de pantalla ñ (1).PNG", png);
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.match(
    saved.path,
    /^\.appbuilder\/attachments\/\d{8}-\d{6}-[a-f\d]{6}-Captura-de-pantalla-n-1\.png$/,
  );
  assert.equal(saved.name, "Captura-de-pantalla-n-1.png");
  assert.equal(saved.type, "image/png");
  assert.equal(saved.size, png.length);
  const root = workspace.projectDir(projectId);
  assert.ok(fs.existsSync(path.join(root, saved.path)));
  const exclude = fs.readFileSync(
    path.join(root, ".git", "info", "exclude"),
    "utf8",
  );
  assert.equal(exclude.match(/^\/\.appbuilder\/$/gm)?.length, 1);
  // A second upload does not repeat the exclusion.
  await upload("otra.png", png);
  assert.equal(
    fs
      .readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")
      .match(/^\/\.appbuilder\/$/gm)?.length,
    1,
  );
  // The explorer never lists them.
  assert.ok(
    !workspace
      .listFiles(projectId)
      .some((entry) => entry.path.startsWith(".appbuilder")),
  );
  for (const traversal of ["../../secreto.txt", "..\\..\\x.png", "/etc/passwd"])
    assert.doesNotMatch(
      (await (await upload(traversal, png)).json()).path,
      /\.\.|\/etc\//,
    );
  assert.equal((await upload("vacío.txt", Buffer.alloc(0))).status, 400);
});

test("sirve imágenes verificadas en línea y el resto como descarga", async () => {
  const image = await (await upload("foto.png", png)).json();
  const fakeImage = await (
    await upload("pagina.png", Buffer.from("<script>alert(1)</script>"))
  ).json();
  const html = await (
    await upload("informe.html", Buffer.from("<h1>Hola</h1>"))
  ).json();
  const fetchFile = (saved: { path: string }) =>
    fetch(`${base}/${saved.path.split("/").pop()}`);
  const shown = await fetchFile(image);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/png");
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
  assert.match(shown.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(shown.headers.get("content-disposition"), null);
  for (const saved of [fakeImage, html]) {
    const download = await fetchFile(saved);
    assert.equal(
      download.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /^attachment/,
    );
  }
  for (const bad of ["..%2F..%2Fsecreto", ".hidden", "no-existe.png"])
    assert.equal((await fetch(`${base}/${bad}`)).status, 404, bad);
});

test("el agente solo acepta adjuntos de la carpeta del proyecto", async () => {
  const image = await (await upload("pantalla.png", png)).json();
  const log = await (await upload("error.log", Buffer.from("boom"))).json();
  const resolved = attachments.resolveAttachments(projectId, [
    image.path,
    log.path,
    image.path,
  ]);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0]!.image, true);
  assert.equal(resolved[1]!.image, false);
  assert.equal(resolved[1]!.type, "text/plain");
  for (const bad of [
    "../outside.png",
    ".appbuilder/attachments/../../index.html",
    ".appbuilder/attachments/sub/file.png",
    "index.html",
    42,
  ])
    assert.throws(
      () => attachments.resolveAttachments(projectId, [bad]),
      (error: Error & { status?: number }) => error.status === 400,
      String(bad),
    );
  assert.throws(
    () =>
      attachments.resolveAttachments(projectId, [
        ".appbuilder/attachments/20260101-000000-abcdef-borrado.png",
      ]),
    (error: Error & { status?: number }) => error.status === 404,
  );
  assert.throws(() =>
    attachments.resolveAttachments(projectId, Array(11).fill(image.path)),
  );
  assert.deepEqual(attachments.resolveAttachments(projectId, undefined), []);

  const note = agents.attachmentNote(resolved);
  assert.match(note, /\.appbuilder\/attachments\//);
  assert.ok(note.includes(image.path) && note.includes(log.path));
  assert.match(note, /imagen/);
  // Codex receives images as images and the text with every path.
  const input = agents.codexInput(`Arregla esto${note}`, resolved);
  assert.ok(Array.isArray(input));
  assert.deepEqual(
    (input as { type: string }[]).map((item) => item.type),
    ["text", "local_image"],
  );
  assert.equal(
    (input as { path?: string }[])[1]!.path,
    path.join(workspace.projectDir(projectId), image.path),
  );
  assert.equal(agents.codexInput("Sin adjuntos", []), "Sin adjuntos");
});
