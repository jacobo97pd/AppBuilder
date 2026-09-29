import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-security-"),
);
const secret = "test-only-provider-key-never-include-in-preview";
process.env.APPBUILDER_DATA_DIR = temporary;
process.env.ANTHROPIC_API_KEY = secret;
process.env.NODE_ENV = "test";

// Storage paths are initialized on import; tests must never use real user data.
const { createApp } = await import("./app.js");
const workspace = await import("./workspace.js");
const { renderPreview } = await import("./preview.js");
const servers: Server[] = [];
let localUrl = "";
let remoteUrl = "";
let cookie = "";
let webId = "";
let reactId = "";
const accessToken = "a".repeat(40);

async function serve(options: Parameters<typeof createApp>[0]) {
  const server = createApp(options).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const authenticated = (extra: Record<string, string> = {}) => ({
  Cookie: cookie,
  ...extra,
});
const rawStatus = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    get(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    }).once("error", reject);
  });

before(async () => {
  localUrl = await serve({ accessToken: "", publicOrigin: "" });
  remoteUrl = await serve({
    accessToken,
    publicOrigin: "https://studio.example.test",
  });
  const session = await fetch(localUrl + "/api/session");
  cookie = session.headers.get("set-cookie")!.split(";")[0];
  webId = workspace.createProject({ name: "Security web", template: "web" }).id;
  reactId = workspace.createProject({
    name: "Security React",
    template: "react",
  }).id;
});

after(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  // Validate the exact, dedicated test directory before recursive removal.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("appbuilder-security-"));
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("local bootstrap sets an HttpOnly session; API needs that session", async () => {
  const denied = await fetch(localUrl + "/api/projects");
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  const session = await fetch(localUrl + "/api/session");
  const setCookie = session.headers.get("set-cookie")!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api/);
  assert.equal((await session.json()).authenticated, true);
  const projects = await fetch(localUrl + "/api/projects", {
    headers: authenticated(),
  });
  assert.equal(projects.status, 200);
  assert.ok(
    (await projects.json()).some(
      (project: { id: string }) => project.id === webId,
    ),
  );
});

test("Host, Origin and cross-site requests cannot bootstrap a session", async () => {
  for (const origin of [
    "https://attacker.example",
    "null",
    "https://localhost.attacker.example",
  ]) {
    const response = await fetch(localUrl + "/api/session", {
      headers: { Origin: origin },
    });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  for (const [host, status] of [
    ["attacker.example", 403],
    ["user@localhost", 400],
    ["localhost/path", 400],
  ] as const) {
    assert.equal(
      await rawStatus(localUrl + "/api/session", { Host: host }),
      status,
    );
  }
  assert.equal(
    (
      await fetch(localUrl + "/api/session", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
});

test("writes require the explicit client header and an allowed origin", async () => {
  const body = JSON.stringify({ name: "Should not exist", template: "web" });
  const missingHeader = await fetch(localUrl + "/api/projects", {
    method: "POST",
    headers: authenticated({ "Content-Type": "application/json" }),
    body,
  });
  assert.equal(missingHeader.status, 403);
  const foreignOrigin = await fetch(localUrl + "/api/projects", {
    method: "POST",
    headers: authenticated({
      "Content-Type": "application/json",
      "X-AppBuilder-Client": "studio",
      Origin: "https://attacker.example",
    }),
    body,
  });
  assert.equal(foreignOrigin.status, 403);
  assert.ok(
    !workspace
      .listProjects()
      .some((project) => project.name === "Should not exist"),
  );
});

test("remote authentication handles unequal UTF-8 lengths without server errors", async () => {
  const unauthenticated = await fetch(remoteUrl + "/api/session");
  assert.equal((await unauthenticated.json()).authenticated, false);
  assert.equal(unauthenticated.headers.get("set-cookie"), null);
  const wrong = await fetch(remoteUrl + "/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AppBuilder-Client": "studio",
    },
    body: JSON.stringify({ token: "é".repeat(accessToken.length) }),
  });
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(await wrong.text(), /buffer|byte length|RangeError/i);
  const valid = await fetch(remoteUrl + "/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AppBuilder-Client": "studio",
    },
    body: JSON.stringify({ token: accessToken }),
  });
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get("set-cookie")!, /; Secure/);
  const projects = await fetch(remoteUrl + "/api/projects", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(projects.status, 200);
  assert.equal(
    (
      await fetch(remoteUrl + "/api/projects", {
        headers: { Authorization: accessToken },
      })
    ).status,
    401,
  );
});

test("native origins need a bearer token even when a browser cookie exists", async () => {
  const origin = "capacitor://localhost";
  const session = await fetch(localUrl + "/api/session", {
    headers: authenticated({ Origin: origin }),
  });
  assert.equal((await session.json()).authenticated, false);
  assert.equal(session.headers.get("set-cookie"), null);
  assert.equal(
    (
      await fetch(localUrl + "/api/projects", {
        headers: authenticated({ Origin: origin }),
      })
    ).status,
    401,
  );
  const remote = await fetch(remoteUrl + "/api/projects", {
    headers: { Origin: origin, Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(remote.status, 200);
  assert.equal(remote.headers.get("access-control-allow-origin"), origin);
  assert.equal(remote.headers.get("access-control-allow-credentials"), null);
  const preflight = await fetch(remoteUrl + "/api/projects", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers.get("access-control-allow-headers")!,
    /Authorization/,
  );
});

test("public configuration cannot accidentally enable unauthenticated remote use", () => {
  assert.throws(
    () =>
      createApp({
        accessToken: "",
        publicOrigin: "https://studio.example.test",
      }),
    /APPBUILDER_ACCESS_TOKEN/,
  );
  for (const publicOrigin of [
    "http://studio.example.test",
    "https://user:password@studio.example.test",
    "https://studio.example.test/private",
  ]) {
    assert.throws(() => createApp({ accessToken, publicOrigin }), /HTTPS/);
  }
});

test("connection metadata and preview never contain environment credentials", async () => {
  const connections = await fetch(localUrl + "/api/connections", {
    headers: authenticated(),
  });
  assert.equal(connections.status, 200);
  assert.ok(!(await connections.text()).includes(secret));
  const preview = await fetch(localUrl + `/api/projects/${webId}/preview`, {
    headers: authenticated(),
  });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type")!, /application\/json/);
  const payload = await preview.json();
  assert.ok(!payload.html.includes(secret));
  assert.ok(!payload.html.includes(cookie));
  assert.match(payload.html, /Content-Security-Policy/);
  assert.match(payload.html, /form-action 'none'; base-uri 'none'/);
});

test("preview prepends its policy before project code even without a head", async () => {
  const original = workspace.readFile(webId, "index.html").content;
  try {
    workspace.writeFile(
      webId,
      "index.html",
      "<script>globalThis.__appbuilderServerProbe = true;</script><h1>Preview</h1>",
    );
    const result = await renderPreview(webId);
    assert.match(
      result.html,
      /^<!doctype html><meta http-equiv="Content-Security-Policy"/,
    );
    assert.ok(
      result.html.indexOf("Content-Security-Policy") <
        result.html.indexOf("__appbuilderServerProbe"),
    );
    assert.equal(
      (globalThis as Record<string, unknown>).__appbuilderServerProbe,
      undefined,
      "Preview code must never execute on the server",
    );
  } finally {
    workspace.writeFile(webId, "index.html", original);
  }
});

test("React preview bundles actual project code and trusted root dependencies", async () => {
  const result = await renderPreview(reactId);
  assert.equal(result.kind, "react");
  assert.match(result.html, /react/);
  assert.ok(!result.html.includes('src="/src/main.jsx"'));
  assert.ok(!result.html.includes(secret));
});

test("preview rejects protected files and symlink escapes inside node_modules", async () => {
  const root = workspace.projectDir(reactId);
  const original = workspace.readFile(reactId, "src/main.jsx").content;
  const dependency = path.join(root, "node_modules", "preview-fixture");
  const external = path.join(temporary, "outside-project");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "preview-fixture", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(dependency, "index.js"),
    'export default "safe fixture";',
  );
  fs.writeFileSync(
    path.join(dependency, ".env.json"),
    JSON.stringify({ secret }),
  );
  fs.mkdirSync(external);
  fs.writeFileSync(
    path.join(external, "package.json"),
    JSON.stringify({ name: "escaped", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(external, "index.js"),
    `export default ${JSON.stringify(secret)};`,
  );
  fs.symlinkSync(
    external,
    path.join(root, "node_modules", "escaped"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    workspace.writeFile(
      reactId,
      "src/main.jsx",
      'import value from "preview-fixture"; console.log(value);',
    );
    assert.match((await renderPreview(reactId)).html, /safe fixture/);
    for (const source of [
      'import value from "../node_modules/preview-fixture/.env.json"; console.log(value);',
      'import value from "escaped"; console.log(value);',
    ]) {
      workspace.writeFile(reactId, "src/main.jsx", source);
      await assert.rejects(
        renderPreview(reactId),
        (error: Error & { status?: number }) => {
          assert.equal(error.status, 400);
          assert.ok(!error.message.includes(secret));
          assert.ok(!error.message.includes(temporary));
          return true;
        },
      );
    }
  } finally {
    workspace.writeFile(reactId, "src/main.jsx", original);
    fs.unlinkSync(path.join(root, "node_modules", "escaped"));
  }
});
