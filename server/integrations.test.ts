import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import express from "express";
import {
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
} from "jose";

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-integrations-"),
);
process.env.APPBUILDER_DATA_DIR = temporaryRoot;
process.env.NODE_ENV = "test";
for (const variable of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEMAGIC_API_TOKEN",
  "APPLE_ISSUER_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GITHUB_TOKEN",
  "APPBUILDER_VAULT_KEY",
])
  delete process.env[variable];
const {
  createIntegrationsRouter,
  integrationDirectory,
  normalizeBuild,
  redactSecrets,
} = await import("./integrations.js");
const { agentEnvironment, isProjectPath } = await import("./agents.js");
const { createProject, projectDir } = await import("./workspace.js");
const realFetch = globalThis.fetch;
let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createIntegrationsRouter());
  app.use(
    (
      error: Error & { status?: number },
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => response.status(error.status || 500).json({ error: error.message }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert(
    temporaryRoot.startsWith(
      path.join(os.tmpdir(), "appbuilder-integrations-"),
    ),
  );
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

async function api(url: string, method = "GET", body?: unknown) {
  const response = await realFetch(`${baseUrl}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

function mockProvider(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
}

test("missing credentials and unknown connectors produce explicit errors", async () => {
  const connections = await api("/connections");
  assert.equal(connections.body.length, 6);
  assert(
    connections.body.every(
      (connection: any) => connection.status === "missing",
    ),
  );
  assert.equal(
    (await api("/connections/not-a-provider", "PUT", { credentials: {} }))
      .status,
    404,
  );
  assert.equal((await api("/builds")).status, 409);
  const models = await api("/agents/models?provider=codex");
  assert.deepEqual(models.body.models, []);
  assert.equal(models.body.source, "unavailable");
  assert.match(models.body.message, /Conecta/);
});

test("credential storage is authenticated encryption and API never returns secrets", async () => {
  const secret = "sk-test-appbuilder-secret-value-12345";
  assert.equal(
    (
      await api("/connections/codex", "PUT", {
        credentials: { apiKey: secret },
      })
    ).status,
    200,
  );
  const envelope = fs.readFileSync(
    path.join(integrationDirectory(), "vault.json"),
    "utf8",
  );
  assert(!envelope.includes(secret));
  assert.equal(JSON.parse(envelope).version, 1);
  assert.equal(
    fs.readFileSync(path.join(integrationDirectory(), "master.key")).length,
    32,
  );
  const connections = await api("/connections");
  assert(!JSON.stringify(connections.body).includes(secret));
  assert.equal(
    connections.body.find((connection: any) => connection.id === "codex")
      .status,
    "connected",
  );
  assert(!redactSecrets(`token=${secret}`).includes(secret));
  assert.equal(
    (await api("/connections/codex", "PUT", { credentials: { apiKey: 12 } }))
      .status,
    400,
  );
});

test("model discovery uses the configured key and only provider-reported effort levels", async () => {
  await api("/connections/claude", "PUT", {
    credentials: { apiKey: "sk-ant-test-appbuilder-123456789" },
  });
  mockProvider((url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/models?limit=1000");
    assert.equal(
      (init?.headers as Record<string, string>)["x-api-key"],
      "sk-ant-test-appbuilder-123456789",
    );
    return Response.json({
      data: [
        {
          id: "claude-test-model",
          display_name: "Test model",
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              xhigh: { supported: true },
              max: { supported: false },
            },
          },
        },
      ],
    });
  });
  const result = await api("/agents/models?provider=claude");
  assert.deepEqual(result.body.models, [
    {
      id: "claude-test-model",
      name: "Test model",
      efforts: ["low", "xhigh"],
      speeds: ["standard"],
    },
  ]);
  const verification = await api("/connections/claude/test", "POST");
  assert.equal(verification.body.ok, true);
  assert(!JSON.stringify(verification).includes("sk-ant"));
});

test("unsupported agent capabilities are rejected before launching any model", async () => {
  const project = createProject({ name: "Agent validation", template: "web" });
  assert.equal(
    (
      await api(`/projects/${project.id}/agent`, "POST", {
        provider: "unknown",
        prompt: "hello",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(`/projects/${project.id}/agent`, "POST", {
        provider: "claude",
        prompt: "hello",
        speed: "ultrafast",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(`/projects/${project.id}/agent`, "POST", {
        provider: "claude",
        prompt: "hello",
        model: "claude-test-model",
        effort: "max",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(`/projects/${project.id}/agent`, "POST", {
        provider: "claude",
        prompt: "hello",
        model: "bad\nmodel",
      })
    ).status,
    400,
  );
});

test("agent environments exclude server secrets and file paths cannot escape a project", () => {
  process.env.APPBUILDER_VAULT_KEY = "secret-not-for-agent";
  process.env.GITHUB_TOKEN = "secret-github-token";
  const environment = agentEnvironment();
  assert(!environment.APPBUILDER_VAULT_KEY);
  assert(!environment.GITHUB_TOKEN);
  delete process.env.APPBUILDER_VAULT_KEY;
  delete process.env.GITHUB_TOKEN;
  const project = createProject({ name: "Path containment", template: "web" });
  const root = projectDir(project.id);
  assert.equal(isProjectPath(root, "src/new-file.ts"), true);
  assert.equal(isProjectPath(root, "../integrations/master.key"), false);
  assert.equal(isProjectPath(root, "\0"), false);
  const link = path.join(root, "outside");
  fs.symlinkSync(
    temporaryRoot,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(isProjectPath(root, "outside/integrations/master.key"), false);
});

test("build requests call Codemagic and normalize only safe artifact URLs", async () => {
  await api("/connections/codemagic", "PUT", {
    credentials: { token: "codemagic-test-token" },
  });
  const project = createProject({ name: "Build project", template: "web" });
  let submitted = false;
  mockProvider((url, init) => {
    assert.equal(
      (init?.headers as Record<string, string>)["x-auth-token"],
      "codemagic-test-token",
    );
    if (init?.method === "POST") {
      assert.equal(url, "https://api.codemagic.io/builds");
      assert.deepEqual(JSON.parse(String(init.body)), {
        appId: "app-123",
        workflowId: "android",
        branch: "main",
      });
      submitted = true;
      return Response.json({ buildId: "build-123" });
    }
    assert(url.includes("appId=app-123"));
    return Response.json({
      builds: [
        {
          _id: "build-123",
          appId: "app-123",
          workflowId: "android",
          status: "finished",
          branch: "main",
          artefacts: [
            { name: "app.apk", url: "https://example.test/app.apk" },
            { name: "bad", url: "javascript:alert(1)" },
          ],
        },
      ],
    });
  });
  const created = await api("/builds", "POST", {
    projectId: project.id,
    appId: "app-123",
    workflowId: "android",
    branch: "main",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, "build-123");
  assert.equal(submitted, true);
  const builds = await api(`/builds?projectId=${project.id}`);
  assert.equal(builds.body.length, 1);
  assert.deepEqual(builds.body[0].artifacts, [
    { name: "app.apk", url: "https://example.test/app.apk" },
  ]);
  assert.equal(normalizeBuild({}).status, "unknown");
});

test("provider failures do not reflect upstream secret-bearing error bodies", async () => {
  mockProvider(
    () =>
      new Response("sk-test-appbuilder-secret-value-12345", { status: 401 }),
  );
  const result = await api("/connections/codemagic/test", "POST");
  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  assert(!JSON.stringify(result).includes("sk-test"));
});

test("Apple connector signs a short-lived team token and returns app metadata", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateKey = await exportPKCS8(pair.privateKey);
  await api("/connections/apple", "PUT", {
    credentials: { issuerId: "issuer-test", keyId: "key-test", privateKey },
  });
  mockProvider((url, init) => {
    assert.equal(
      url,
      "https://api.appstoreconnect.apple.com/v1/apps?limit=200",
    );
    const jwt = (init?.headers as Record<string, string>).Authorization.slice(
      7,
    );
    assert.equal(decodeProtectedHeader(jwt).kid, "key-test");
    const claims = decodeJwt(jwt);
    assert.equal(claims.aud, "appstoreconnect-v1");
    assert.equal(claims.iss, "issuer-test");
    assert.equal(claims.exp! - claims.iat!, 300);
    return Response.json({
      data: [
        {
          id: "apple-app",
          attributes: {
            name: "My app",
            bundleId: "com.example.app",
            sku: "APP",
          },
        },
      ],
    });
  });
  const result = await api("/stores/apple/apps");
  assert.equal(result.status, 200);
  assert.equal(result.body.apps[0].bundleId, "com.example.app");
  assert(!JSON.stringify(result).includes("PRIVATE KEY"));
});

test("Google track inspection signs OAuth, never commits an edit and always cleans it up", async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const privateKey = await exportPKCS8(pair.privateKey);
  await api("/connections/google", "PUT", {
    credentials: {
      serviceAccountJson: JSON.stringify({
        type: "service_account",
        client_email: "appbuilder@example.iam.gserviceaccount.com",
        private_key: privateKey,
        token_uri: "https://attacker.invalid",
      }),
    },
  });
  const requests: string[] = [];
  mockProvider((url, init) => {
    requests.push(`${init?.method || "GET"} ${url}`);
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(String(init?.body)).get(
        "assertion",
      )!;
      assert.equal(
        decodeJwt(assertion).aud,
        "https://oauth2.googleapis.com/token",
      );
      return Response.json({ access_token: "test-oauth-token" });
    }
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer test-oauth-token",
    );
    if (init?.method === "POST") return Response.json({ id: "edit-123" });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({
      tracks: [
        {
          track: "internal",
          releases: [{ status: "completed", versionCodes: ["1"] }],
        },
      ],
    });
  });
  const result = await api("/stores/google/tracks", "POST", {
    packageName: "com.example.app",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.tracks[0].track, "internal");
  assert(requests.some((request) => request.startsWith("DELETE ")));
  assert(
    !requests.some(
      (request) =>
        request.includes(":commit") || request.includes("attacker.invalid"),
    ),
  );
  assert.equal(
    (await api("/stores/google/tracks", "POST", { packageName: "../../etc" }))
      .status,
    400,
  );
});

test("disconnect removes saved secrets and reports remaining environment credentials", async () => {
  process.env.OPENAI_API_KEY = "sk-environment-key-123456";
  const result = await api("/connections/codex", "DELETE");
  assert.equal(result.body.ok, true);
  assert.match(result.body.message, /variables de entorno/);
  delete process.env.OPENAI_API_KEY;
  const connections = await api("/connections");
  assert.equal(
    connections.body.find((connection: any) => connection.id === "codex")
      .status,
    "missing",
  );
});
