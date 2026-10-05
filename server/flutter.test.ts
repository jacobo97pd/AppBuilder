import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const dataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-flutter-test-"),
);
process.env.APPBUILDER_DATA_DIR = dataRoot;
const workspace = await import("./workspace.js");
const flutter = await import("./flutter.js");

let server: Server;
let base = "";
let projectId = "";

before(async () => {
  const { project, directory } = workspace.reserveImportedProject({
    name: "Juego",
    url: "https://github.com/a/juego.git",
  });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "pubspec.yaml"),
    "name: juego\ndependencies:\n  flutter:\n    sdk: flutter\n",
  );
  workspace.completeImportedProject(project.id, "main");
  projectId = project.id;
  // A finished web build, as `flutter build web` would leave it.
  const build = path.join(dataRoot, "previews", projectId, "web");
  fs.mkdirSync(path.join(build, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(build, "index.html"),
    '<!DOCTYPE html><html><head><base href="/"><title>x</title></head><body></body></html>',
  );
  fs.writeFileSync(path.join(build, "main.dart.js"), "console.log('hola')");
  fs.writeFileSync(path.join(build, "assets", "data.json"), "{}");
  fs.writeFileSync(path.join(dataRoot, "secreto.txt"), "no");
  const app = express();
  app.get("/preview/:token{/*file}", flutter.serveFlutterPreview(["'self'"]));
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("detecta apps de Flutter por su pubspec", () => {
  assert.equal(flutter.flutterProjectName(projectId), "juego");
});

test("sirve la compilación aislada, con <base> propio y sin salir de la carpeta", async () => {
  const status = await flutter.flutterStatus(projectId);
  assert.equal(status.flutter, true);
  assert.match(status.url ?? "", /^\/preview\/[a-f\d]{48}\/$/);
  const index = await fetch(base + status.url);
  assert.equal(index.status, 200);
  assert.match(
    index.headers.get("content-security-policy") ?? "",
    /sandbox allow-scripts/,
  );
  assert.equal(index.headers.get("access-control-allow-origin"), "*");
  const html = await index.text();
  assert.ok(html.includes(`<base href="${status.url}">`));
  assert.ok(html.includes("Navigator.prototype.serviceWorker"));
  const script = await fetch(base + status.url + "main.dart.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  assert.equal(
    (await fetch(base + status.url + "assets/data.json")).status,
    200,
  );
  const folder = await fetch(base + status.url!.slice(0, -1), {
    redirect: "manual",
  });
  assert.equal(folder.status, 302);
  for (const probe of [
    "../../secreto.txt",
    "%2e%2e/%2e%2e/secreto.txt",
    ".hidden",
  ])
    assert.notEqual(
      (await fetch(base + status.url + probe)).status,
      200,
      probe,
    );
  assert.equal(
    (await fetch(`${base}/preview/${"0".repeat(48)}/index.html`)).status,
    404,
  );
});
