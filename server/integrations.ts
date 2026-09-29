import { Router } from "express";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { codexModelMetadata, mountAgentRoutes } from "./agents.js";
import { getProject } from "./workspace.js";

export type Provider = "codex" | "claude";
export type ConnectionId =
  Provider | "codemagic" | "apple" | "google" | "github";
type Credentials = Record<string, string>;
type ConnectionField = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
};
type ConnectionDefinition = {
  name: string;
  description: string;
  fields: ConnectionField[];
  env: Record<string, string>;
};
export type AgentModel = {
  id: string;
  name: string;
  efforts: string[];
  speeds: string[];
};
export type ModelDiscovery = {
  models: AgentModel[];
  source: string;
  message?: string;
};

const definitions: Record<ConnectionId, ConnectionDefinition> = {
  codex: {
    name: "OpenAI Codex",
    description: "Agente de programación · API de OpenAI",
    fields: [
      { key: "apiKey", label: "API key", secret: true, placeholder: "sk-…" },
    ],
    env: { apiKey: "OPENAI_API_KEY" },
  },
  claude: {
    name: "Claude Agent",
    description: "Agente de programación · API de Anthropic",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        secret: true,
        placeholder: "sk-ant-…",
      },
    ],
    env: { apiKey: "ANTHROPIC_API_KEY" },
  },
  codemagic: {
    name: "Codemagic",
    description: "Builds remotas, registros y artefactos",
    fields: [{ key: "token", label: "API token", secret: true }],
    env: { token: "CODEMAGIC_API_TOKEN" },
  },
  apple: {
    name: "App Store Connect",
    description: "Consultar apps de tu equipo de Apple",
    fields: [
      { key: "issuerId", label: "Issuer ID" },
      { key: "keyId", label: "Key ID" },
      {
        key: "privateKey",
        label: "Clave privada .p8",
        secret: true,
        placeholder: "-----BEGIN PRIVATE KEY-----",
      },
    ],
    env: {
      issuerId: "APPLE_ISSUER_ID",
      keyId: "APPLE_KEY_ID",
      privateKey: "APPLE_PRIVATE_KEY",
    },
  },
  google: {
    name: "Google Play Console",
    description: "Consultar canales y versiones de Android",
    fields: [
      {
        key: "serviceAccountJson",
        label: "JSON de cuenta de servicio",
        secret: true,
        placeholder: '{ "type": "service_account", … }',
      },
    ],
    env: { serviceAccountJson: "GOOGLE_SERVICE_ACCOUNT_JSON" },
  },
  github: {
    name: "GitHub",
    description: "Consultar repositorios de tu cuenta",
    fields: [
      {
        key: "token",
        label: "Personal access token",
        secret: true,
        placeholder: "github_pat_…",
      },
    ],
    env: { token: "GITHUB_TOKEN" },
  },
};

export class IntegrationError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function integrationDirectory(): string {
  return path.join(
    path.resolve(process.env.APPBUILDER_DATA_DIR || ".appbuilder"),
    "integrations",
  );
}

function atomicWrite(filename: string, data: string | Buffer) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, filename);
}

function masterKey(): Buffer {
  const configured = process.env.APPBUILDER_VAULT_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32)
      throw new IntegrationError(
        "APPBUILDER_VAULT_KEY debe contener 32 bytes en base64.",
        500,
      );
    return key;
  }
  const filename = path.join(integrationDirectory(), "master.key");
  if (!existsSync(filename)) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(filename, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const key = readFileSync(filename);
  if (key.length !== 32)
    throw new IntegrationError(
      "La clave del almacén de credenciales no es válida.",
      500,
    );
  return key;
}

function loadVault(): Partial<Record<ConnectionId, Credentials>> {
  const filename = path.join(integrationDirectory(), "vault.json");
  if (!existsSync(filename)) return {};
  try {
    const envelope = JSON.parse(readFileSync(filename, "utf8"));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      masterKey(),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw new IntegrationError(
      "No se puede abrir el almacén de credenciales. Comprueba la clave maestra.",
      500,
    );
  }
}

function saveVault(vault: Partial<Record<ConnectionId, Credentials>>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(vault), "utf8"),
    cipher.final(),
  ]);
  atomicWrite(
    path.join(integrationDirectory(), "vault.json"),
    JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    }),
  );
}

function connectionId(value: string): ConnectionId {
  if (!Object.hasOwn(definitions, value))
    throw new IntegrationError("Conector desconocido.", 404);
  return value as ConnectionId;
}

export function readCredentials(
  id: ConnectionId,
  required = true,
): Credentials {
  const values: Credentials = {};
  for (const [key, envName] of Object.entries(definitions[id].env)) {
    if (process.env[envName]) values[key] = process.env[envName]!;
  }
  Object.assign(values, loadVault()[id] || {});
  if (
    required &&
    definitions[id].fields.some((field) => !values[field.key]?.trim())
  ) {
    throw new IntegrationError(
      `Conecta ${definitions[id].name} en Conexiones para continuar.`,
      409,
    );
  }
  return values;
}

const connectionTests = new Map<
  ConnectionId,
  { ok: boolean; message: string }
>();
const modelCache = new Map<
  Provider,
  { key: string; expires: number; data: ModelDiscovery }
>();

export function listConnections() {
  return Object.entries(definitions).map(([key, definition]) => {
    const id = key as ConnectionId;
    const values = readCredentials(id, false);
    const configured = definition.fields.every((field) =>
      Boolean(values[field.key]?.trim()),
    );
    const test = connectionTests.get(id);
    return {
      id,
      name: definition.name,
      status: configured
        ? test?.ok === false
          ? "error"
          : "connected"
        : "missing",
      detail: configured
        ? test?.message ||
          "Credenciales guardadas. Pulsa «Probar» para verificar el acceso."
        : definition.description,
      fields: definition.fields,
    };
  });
}

export function saveCredentials(id: ConnectionId, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new IntegrationError("Introduce las credenciales del conector.");
  const vault = loadVault();
  const values = { ...(vault[id] || {}) };
  for (const field of definitions[id].fields) {
    const value = (input as Credentials)[field.key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 50_000)
      throw new IntegrationError(`El campo ${field.label} no es válido.`);
    values[field.key] = value.trim();
  }
  const effective = { ...readCredentials(id, false), ...values };
  if (definitions[id].fields.some((field) => !effective[field.key]))
    throw new IntegrationError("Completa todos los campos del conector.");
  if (id === "google") parseServiceAccount(effective.serviceAccountJson);
  if (id === "apple" && !effective.privateKey.includes("BEGIN PRIVATE KEY"))
    throw new IntegrationError(
      "La clave de Apple debe estar en formato PEM (.p8).",
    );
  vault[id] = values;
  saveVault(vault);
  connectionTests.delete(id);
  if (id === "codex" || id === "claude") modelCache.delete(id);
}

export function redactSecrets(text: string): string {
  let clean = text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[clave privada oculta]",
    )
    .replace(
      /\b(?:sk-(?:ant-)?[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]{12,})\b/g,
      "[credencial oculta]",
    );
  for (const id of Object.keys(definitions) as ConnectionId[]) {
    for (const value of Object.values(readCredentials(id, false))) {
      if (value.length >= 8)
        clean = clean.split(value).join("[credencial oculta]");
    }
  }
  return clean;
}

export async function providerRequest(
  url: string,
  init: RequestInit = {},
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(20_000),
    });
  } catch {
    throw new IntegrationError(
      "No se pudo contactar con el proveedor. Comprueba la conexión y vuelve a intentarlo.",
      502,
    );
  }
  if (!response.ok) {
    let message = `El proveedor respondió con HTTP ${response.status}.`;
    if (response.status === 401) message += " Comprueba las credenciales.";
    if (response.status === 403)
      message += " La cuenta no tiene permiso para esta operación.";
    if (response.status === 429)
      message += " Límite de uso alcanzado. Inténtalo más tarde.";
    throw new IntegrationError(
      message,
      response.status === 401 || response.status === 403 ? 422 : 502,
    );
  }
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new IntegrationError(
      "El proveedor devolvió una respuesta no válida.",
      502,
    );
  }
}

function supportedEfforts(value: any, allowed: string[]): string[] {
  if (!value || value.supported === false) return [];
  return allowed.filter(
    (level) =>
      value[level]?.supported === true ||
      (Array.isArray(value) && value.includes(level)),
  );
}

export async function discoverModels(
  provider: Provider,
): Promise<ModelDiscovery> {
  const { apiKey } = readCredentials(provider);
  const cached = modelCache.get(provider);
  if (cached?.key === apiKey && cached.expires > Date.now()) return cached.data;
  const payload =
    provider === "codex"
      ? await providerRequest("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
      : await providerRequest(
          "https://api.anthropic.com/v1/models?limit=1000",
          {
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          },
        );
  const models: AgentModel[] = (Array.isArray(payload.data) ? payload.data : [])
    .filter(
      (model: any) =>
        typeof model.id === "string" &&
        (provider === "claude" || /^(gpt-|o\d|codex-)/.test(model.id)) &&
        !/image|audio|realtime|tts|transcribe|search|embedding/.test(model.id),
    )
    .map((model: any) => ({
      id: model.id,
      name: model.display_name || model.id,
      efforts: supportedEfforts(
        model.capabilities?.effort || model.capabilities?.reasoning_effort,
        provider === "codex"
          ? [
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
              "ultra",
              "persistent",
            ]
          : ["low", "medium", "high", "xhigh", "max"],
      ),
      speeds: ["standard"],
    }));
  let runtimeMetadata = false;
  if (provider === "codex" && process.env.NODE_ENV !== "test") {
    const metadata = await codexModelMetadata(integrationDirectory()).catch(
      () => new Map<string, { name: string; efforts: string[] }>(),
    );
    for (const model of models) {
      const capabilities = metadata.get(model.id);
      if (capabilities) {
        model.name = capabilities.name;
        model.efforts = capabilities.efforts;
        runtimeMetadata = true;
      }
    }
  }
  const data: ModelDiscovery = {
    models,
    source: provider === "codex" ? "OpenAI Models API" : "Anthropic Models API",
    message:
      provider === "codex"
        ? runtimeMetadata
          ? "Modelos visibles para tu API key, con esfuerzos del catálogo de Codex cuando existen. La compatibilidad final se verifica al ejecutar. Velocidad estándar del SDK."
          : "Modelos visibles para tu API key; la compatibilidad con Codex se verifica al ejecutar. La API no publica todos los niveles de esfuerzo. Velocidad estándar del SDK."
        : "Se muestran únicamente los niveles de esfuerzo publicados por el proveedor y admitidos por el SDK. Velocidad estándar del SDK.",
  };
  modelCache.set(provider, {
    key: apiKey,
    expires: Date.now() + 300_000,
    data,
  });
  return data;
}

async function appleToken(
  credentials = readCredentials("apple"),
): Promise<string> {
  try {
    const key = await importPKCS8(
      credentials.privateKey.replace(/\\n/g, "\n"),
      "ES256",
    );
    return await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
      .setIssuer(credentials.issuerId)
      .setAudience("appstoreconnect-v1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  } catch {
    throw new IntegrationError(
      "La clave privada de App Store Connect no es válida.",
    );
  }
}

function parseServiceAccount(json: string): {
  client_email: string;
  private_key: string;
  private_key_id?: string;
} {
  try {
    const value = JSON.parse(json);
    if (
      value.type !== "service_account" ||
      typeof value.client_email !== "string" ||
      typeof value.private_key !== "string"
    )
      throw new Error();
    return value;
  } catch {
    throw new IntegrationError(
      "Introduce un JSON válido de cuenta de servicio de Google.",
    );
  }
}

async function googleToken(): Promise<string> {
  const account = parseServiceAccount(
    readCredentials("google").serviceAccountJson,
  );
  let assertion: string;
  try {
    const key = await importPKCS8(account.private_key, "RS256");
    assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/androidpublisher",
    })
      .setProtectedHeader({
        alg: "RS256",
        typ: "JWT",
        ...(account.private_key_id ? { kid: account.private_key_id } : {}),
      })
      .setIssuer(account.client_email)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  } catch {
    throw new IntegrationError(
      "La clave privada de la cuenta de servicio de Google no es válida.",
    );
  }
  const response = await providerRequest(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
  );
  if (typeof response.access_token !== "string")
    throw new IntegrationError("Google no devolvió un token de acceso.", 502);
  return response.access_token;
}

export type Build = {
  id: string;
  appId: string;
  workflowId: string;
  status: string;
  startedAt: string | null;
  branch: string;
  artifacts: { name: string; url: string }[];
};

export function normalizeBuild(value: any): Build {
  return {
    id: String(value._id || value.id || value.buildId || ""),
    appId: String(value.appId || value.app?.id || ""),
    workflowId: String(value.workflowId || value.workflow?.id || ""),
    status: String(value.status || "unknown"),
    startedAt: value.startedAt || value.createdAt || null,
    branch: String(value.branch || value.config?.branch || ""),
    artifacts: (Array.isArray(value.artefacts)
      ? value.artefacts
      : Array.isArray(value.artifacts)
        ? value.artifacts
        : []
    )
      .filter(
        (artifact: any) =>
          typeof (artifact.url || artifact.downloadUrl) === "string" &&
          /^https:\/\//.test(artifact.url || artifact.downloadUrl),
      )
      .map((artifact: any) => ({
        name: String(artifact.name || "Descargar artefacto"),
        url: String(artifact.url || artifact.downloadUrl),
      })),
  };
}

function buildAssociations(): Record<
  string,
  { projectId: string; appId: string }
> {
  const filename = path.join(integrationDirectory(), "builds.json");
  if (!existsSync(filename)) return {};
  return JSON.parse(readFileSync(filename, "utf8"));
}

function codemagicHeaders() {
  return {
    "x-auth-token": readCredentials("codemagic").token,
    "content-type": "application/json",
  };
}

export function createIntegrationsRouter(): Router {
  const router = Router();
  router.get("/connections", (_request, response) =>
    response.json(listConnections()),
  );
  router.put("/connections/:id", (request, response) => {
    const id = connectionId(String(request.params.id));
    saveCredentials(id, request.body?.credentials);
    response.json(listConnections().find((connection) => connection.id === id));
  });
  router.delete("/connections/:id", (request, response) => {
    const id = connectionId(String(request.params.id));
    const vault = loadVault();
    delete vault[id];
    saveVault(vault);
    connectionTests.delete(id);
    if (id === "codex" || id === "claude") modelCache.delete(id);
    response.json({
      ok: true,
      message: Object.keys(readCredentials(id, false)).length
        ? "Credenciales locales eliminadas. El servidor sigue configurado mediante variables de entorno."
        : "Conector desconectado.",
    });
  });
  router.post("/connections/:id/test", async (request, response) => {
    const id = connectionId(String(request.params.id));
    try {
      const credentials = readCredentials(id);
      let message = "Conexión verificada.";
      if (id === "codex" || id === "claude") {
        modelCache.delete(id);
        const data = await discoverModels(id);
        message = `Acceso verificado. ${data.models.length} modelos visibles.`;
      } else if (id === "codemagic") {
        await providerRequest("https://api.codemagic.io/apps", {
          headers: codemagicHeaders(),
        });
      } else if (id === "apple") {
        await providerRequest(
          "https://api.appstoreconnect.apple.com/v1/apps?limit=1",
          {
            headers: {
              Authorization: `Bearer ${await appleToken(credentials)}`,
            },
          },
        );
      } else if (id === "google") {
        await googleToken();
        message =
          "Google aceptó la cuenta de servicio. Consulta un paquete para verificar sus permisos en Play Console.";
      } else {
        const account = await providerRequest("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            Accept: "application/vnd.github+json",
          },
        });
        message = `Conectado como ${account.login}.`;
      }
      connectionTests.set(id, { ok: true, message });
      response.json({ ok: true, message });
    } catch (error) {
      const message = redactSecrets(
        error instanceof Error
          ? error.message
          : "No se pudo verificar la conexión.",
      );
      connectionTests.set(id, { ok: false, message });
      response
        .status(error instanceof IntegrationError ? error.status : 502)
        .json({ ok: false, message, error: message });
    }
  });
  router.get("/agents/models", async (request, response) => {
    const provider = request.query.provider;
    if (provider !== "codex" && provider !== "claude")
      throw new IntegrationError("Selecciona Codex o Claude.");
    try {
      response.json(await discoverModels(provider));
    } catch (error) {
      response.json({
        models: [],
        source: "unavailable",
        message: redactSecrets(
          error instanceof Error
            ? error.message
            : "No se pudo consultar el catálogo.",
        ),
      });
    }
  });
  mountAgentRoutes(router, {
    readCredentials,
    discoverModels,
    redactSecrets,
    integrationDirectory,
  });

  router.get("/builds", async (request, response) => {
    const headers = codemagicHeaders();
    const query = new URLSearchParams({ limit: "30" });
    let projectId: string | undefined;
    const associations = buildAssociations();
    if (typeof request.query.projectId === "string") {
      projectId = request.query.projectId;
      await getProject(projectId);
      const associated = Object.values(associations).find(
        (value) => value.projectId === projectId,
      );
      if (!associated) {
        response.json([]);
        return;
      }
      query.set("appId", associated.appId);
    }
    const result = await providerRequest(
      `https://api.codemagic.io/builds?${query}`,
      { headers },
    );
    const builds = (Array.isArray(result) ? result : result.builds || []).map(
      normalizeBuild,
    );
    response.json(
      projectId
        ? builds.filter(
            (build: Build) => associations[build.id]?.projectId === projectId,
          )
        : builds,
    );
  });
  router.post("/builds", async (request, response) => {
    const { appId, workflowId, branch, projectId } = request.body || {};
    for (const [label, value] of Object.entries({
      appId,
      workflowId,
      branch,
    })) {
      if (typeof value !== "string" || !value.trim() || value.length > 200)
        throw new IntegrationError(`El campo ${label} es obligatorio.`);
    }
    if (projectId) await getProject(projectId);
    const result = await providerRequest("https://api.codemagic.io/builds", {
      method: "POST",
      headers: codemagicHeaders(),
      body: JSON.stringify({ appId, workflowId, branch }),
    });
    if (typeof result.buildId !== "string")
      throw new IntegrationError(
        "Codemagic no devolvió el identificador de la build.",
        502,
      );
    if (projectId) {
      const associations = buildAssociations();
      associations[result.buildId] = { projectId, appId };
      atomicWrite(
        path.join(integrationDirectory(), "builds.json"),
        JSON.stringify(associations),
      );
    }
    response.status(201).json(
      normalizeBuild({
        buildId: result.buildId,
        appId,
        workflowId,
        branch,
        status: "queued",
      }),
    );
  });
  router.post("/builds/:id/cancel", async (request, response) => {
    await providerRequest(
      `https://api.codemagic.io/builds/${encodeURIComponent(String(request.params.id))}/cancel`,
      { method: "POST", headers: codemagicHeaders() },
    );
    response.json({ ok: true });
  });
  router.get("/stores/apple/apps", async (_request, response) => {
    const result = await providerRequest(
      "https://api.appstoreconnect.apple.com/v1/apps?limit=200",
      { headers: { Authorization: `Bearer ${await appleToken()}` } },
    );
    response.json({
      apps: (result.data || []).map((app: any) => ({
        id: app.id,
        name: app.attributes?.name,
        bundleId: app.attributes?.bundleId,
        sku: app.attributes?.sku,
      })),
      hasMore: Boolean(result.links?.next),
    });
  });
  router.post("/stores/google/tracks", async (request, response) => {
    const packageName = request.body?.packageName;
    if (
      typeof packageName !== "string" ||
      !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/.test(packageName) ||
      packageName.length > 250
    )
      throw new IntegrationError(
        "Introduce un package name válido, por ejemplo com.miempresa.miapp.",
      );
    const headers = {
      Authorization: `Bearer ${await googleToken()}`,
      "content-type": "application/json",
    };
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits`;
    const edit = await providerRequest(base, {
      method: "POST",
      headers,
      body: "{}",
    });
    if (typeof edit.id !== "string")
      throw new IntegrationError(
        "Google no devolvió una sesión de consulta.",
        502,
      );
    const editUrl = `${base}/${encodeURIComponent(edit.id)}`;
    try {
      const result = await providerRequest(`${editUrl}/tracks`, { headers });
      response.json({ packageName, tracks: result.tracks || [] });
    } finally {
      // The temporary edit is never committed: inspecting tracks cannot publish a release.
      await providerRequest(editUrl, { method: "DELETE", headers }).catch(
        () => undefined,
      );
    }
  });
  router.get("/github/repos", async (_request, response) => {
    const result = await providerRequest(
      "https://api.github.com/user/repos?sort=updated&per_page=100",
      {
        headers: {
          Authorization: `Bearer ${readCredentials("github").token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    response.json({
      repos: result.map((repo: any) => ({
        id: String(repo.id),
        name: repo.full_name,
        private: repo.private,
        url: repo.html_url,
        cloneUrl: repo.clone_url,
        branch: repo.default_branch,
      })),
    });
  });
  return router;
}
