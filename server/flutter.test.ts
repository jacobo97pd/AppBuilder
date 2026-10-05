import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import zlib from "node:zlib";
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
    '<!DOCTYPE html><html><head><base href="/"><title>x</title></head><body><script src="flutter_bootstrap.js" async></script><script src="https://maps.example.com/api.js"></script></body></html>',
  );
  const script = "console.log('hola');".repeat(200);
  fs.writeFileSync(path.join(build, "main.dart.js"), script);
  fs.writeFileSync(
    path.join(build, "main.dart.js.br"),
    zlib.brotliCompressSync(script),
  );
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
  // Readable errors, storage that works in the sandbox and a ready signal.
  assert.ok(html.includes("HTMLScriptElement.prototype"));
  assert.ok(html.includes("localStorage"));
  assert.ok(html.includes("appbuilder:ready"));
  assert.ok(html.indexOf("appbuilder:console") < html.indexOf("<title>"));
  assert.ok(
    html.includes(
      '<script crossorigin="anonymous" src="flutter_bootstrap.js" async>',
    ),
  );
  assert.ok(html.includes('<script src="https://maps.example.com/api.js">'));
  const script = await fetch(base + status.url + "main.dart.js", {
    headers: { "Accept-Encoding": "identity" },
  });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  assert.equal(script.headers.get("content-encoding"), null);
  // Phones get the Brotli copy, with the original type.
  const compressed = await fetch(base + status.url + "main.dart.js", {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });
  assert.equal(compressed.headers.get("content-encoding"), "br");
  assert.match(compressed.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await compressed.text(), "console.log('hola');".repeat(200));
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

test("la dirección de la vista previa sigue valiendo tras reiniciar el servidor", async () => {
  const { url } = await flutter.flutterStatus(projectId);
  assert.equal((await flutter.flutterStatus(projectId)).url, url);
  // A fresh copy of the module has no tokens in memory, like a restarted server.
  const fresh = "./flutter.js?restart=1";
  const restarted = (await import(fresh)) as typeof flutter;
  const app = express();
  app.get("/preview/:token{/*file}", restarted.serveFlutterPreview(["'self'"]));
  const other = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const port = (other.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${url}`);
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test("encuentra la app de Flutter en una subcarpeta y nombra paquetes válidos", () => {
  const nested = workspace.createProject({ name: "Monorepo", template: "web" });
  const root = workspace.projectDir(nested.id);
  assert.equal(flutter.flutterApp(nested.id), null);
  for (const folder of ["backend", "apps/movil"]) {
    fs.mkdirSync(path.join(root, folder, "lib"), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "backend", "pubspec.yaml"), "name: api\n");
  fs.writeFileSync(
    path.join(root, "apps", "movil", "pubspec.yaml"),
    "name: movil\ndependencies:\n  flutter:\n    sdk: flutter\n",
  );
  fs.writeFileSync(path.join(root, "apps", "movil", "lib", "main.dart"), "");
  assert.deepEqual(flutter.flutterApp(nested.id), {
    name: "movil",
    folder: "apps/movil",
  });
  assert.equal(
    flutter.dartPackageName("Vestuario Render 1.0."),
    "vestuario_render_1_0",
  );
  assert.equal(flutter.dartPackageName("2048"), "app_2048");
  assert.equal(flutter.dartPackageName("Test"), "test_app");
  assert.equal(flutter.dartPackageName("¡¡!!"), "app");
  assert.equal(flutter.flutterOrganization(undefined), "com.example");
  assert.equal(flutter.flutterOrganization(" Com.Jacobo "), "com.jacobo");
  for (const bad of ["jacobo", "com.", "com..x", 'com.x" & calc', "1com.x"])
    assert.throws(() => flutter.flutterOrganization(bad), Error, bad);
});
