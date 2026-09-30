import type { Router } from "express";
import {
  Codex,
  type ModelReasoningEffort,
  type ThreadOptions,
} from "@openai/codex-sdk";
import {
  query,
  type EffortLevel,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  createJob,
  appendJob,
  finishJob,
  registerJobCancellation,
} from "./jobs.js";
import { getProject, projectDir } from "./workspace.js";
import { createCheckpoint } from "./core.js";
import type { ConnectionId, ModelDiscovery, Provider } from "./integrations.js";
import { APP_VERSION } from "../version.js";

type AgentDependencies = {
  readCredentials: (
    id: ConnectionId,
    required?: boolean,
  ) => Record<string, string>;
  discoverModels: (provider: Provider) => Promise<ModelDiscovery>;
  redactSecrets: (text: string) => string;
  integrationDirectory: () => string;
  codexAuthMode: () => "api" | "chatgpt" | "disabled";
};
type AgentInput = {
  provider: Provider;
  prompt: string;
  model?: string;
  effort?: string;
  speed?: string;
  newSession?: boolean;
};
const activeProjects = new Set<string>();
const execFileAsync = promisify(execFile);

function codexExecutable(): string {
  const require = createRequire(import.meta.url);
  return path.join(
    path.dirname(require.resolve("@openai/codex/package.json")),
    "bin",
    "codex.js",
  );
}

/** Check the local Codex login without reading or returning its credentials. */
export async function codexAccountStatus(): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [codexExecutable(), "login", "status"],
      {
        env: agentEnvironment(),
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 5_000,
      },
    );
    return /Logged in using ChatGPT/i.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

function invalid(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Only runtime variables are inherited; other connectors and server secrets stay out of agent processes. */
export function agentEnvironment(): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "SHELL",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMDATA",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && allowed.has(key.toUpperCase()),
    ),
  ) as Record<string, string>;
}

/** Read runtime capability metadata without starting an agent turn. */
export async function codexModelMetadata(
  directory: string,
  account = false,
): Promise<Map<string, { name: string; efforts: string[] }>> {
  const runtimeHome = path.resolve(directory, "runtime", "catalog");
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        codexExecutable(),
        "app-server",
        ...(account ? ["-c", 'forced_login_method="chatgpt"'] : []),
      ],
      {
        cwd: runtimeHome,
        env: account
          ? agentEnvironment()
          : { ...agentEnvironment(), CODEX_HOME: runtimeHome },
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    const result = new Map<string, { name: string; efforts: string[] }>();
    let done = false;
    let requestId = 1;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      const cleanup = setTimeout(() => child.kill(), 1_000);
      cleanup.unref();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(
      () =>
        finish(new Error("El catálogo de Codex tardó demasiado en responder.")),
      20_000,
    );
    const send = (message: object) => {
      if (!done) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.on("exit", () => {
      if (!done)
        finish(new Error("No se pudo consultar el catálogo de Codex."));
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined) return;
      if (message.error) {
        finish(
          new Error("El runtime de Codex rechazó la consulta de modelos."),
        );
        return;
      }
      if (message.id === 0) {
        send({ method: "initialized", params: {} });
        send({
          id: requestId,
          method: "model/list",
          params: { limit: 100, includeHidden: true },
        });
      } else {
        for (const model of message.result?.data || []) {
          if (typeof model.model !== "string") continue;
          const levels = (model.supportedReasoningEfforts || [])
            .map((item: any) => item.reasoningEffort)
            .filter(
              (level: unknown): level is string =>
                typeof level === "string" &&
                [
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                  "ultra",
                  "persistent",
                ].includes(level),
            );
          result.set(model.model, {
            name: model.displayName || model.model,
            efforts: levels,
          });
        }
        if (message.result?.nextCursor && requestId < 10)
          send({
            id: ++requestId,
            method: "model/list",
            params: {
              limit: 100,
              includeHidden: true,
              cursor: message.result.nextCursor,
            },
          });
        else finish();
      }
    });
    send({
      id: 0,
      method: "initialize",
      params: {
        clientInfo: {
          name: "appbuilder",
          title: "AppBuilder",
          version: APP_VERSION,
        },
      },
    });
  });
}

/** Resolve existing ancestors too: a symlink in a project must not allow file tools to escape it. */
export function isProjectPath(root: string, value: unknown): boolean {
  if (typeof value !== "string" || value.includes("\0")) return false;
  const destination = path.resolve(root, value || ".");
  const relative = path.relative(root, destination);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return false;
  let cursor = destination;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  try {
    // Reject all symlink ancestors, including dangling links, before resolving.
    let ancestor = destination;
    while (ancestor !== root) {
      try {
        if (lstatSync(ancestor).isSymbolicLink()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      ancestor = path.dirname(ancestor);
    }
    const realRelative = path.relative(
      realpathSync(root),
      realpathSync(cursor),
    );
    return (
      realRelative !== ".." &&
      !realRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(realRelative)
    );
  } catch {
    return false;
  }
}

function sessionFile(
  dependencies: AgentDependencies,
  projectId: string,
  provider: Provider,
  account = false,
) {
  const folder = path.join(dependencies.integrationDirectory(), "sessions");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return path.join(
    folder,
    `${projectId}-${provider}${account ? "-chatgpt" : ""}.json`,
  );
}

function readSession(filename: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(filename, "utf8")).sessionId;
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function storeSession(filename: string, sessionId: string) {
  writeFileSync(filename, JSON.stringify({ sessionId }), { mode: 0o600 });
}

function runtimeDirectory(
  dependencies: AgentDependencies,
  provider: Provider,
): string {
  const directory = path.join(
    dependencies.integrationDirectory(),
    "runtime",
    provider,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function runCodex(
  input: AgentInput,
  root: string,
  apiKey: string,
  account: boolean,
  session: string | undefined,
  saveSession: (id: string) => void,
  signal: AbortSignal,
  log: (text: string) => void,
  dependencies: AgentDependencies,
) {
  const codex = new Codex({
    ...(account ? {} : { apiKey }),
    env: account
      ? agentEnvironment()
      : {
          ...agentEnvironment(),
          CODEX_HOME: runtimeDirectory(dependencies, "codex"),
        },
    config: {
      forced_login_method: account ? "chatgpt" : "api",
      shell_environment_policy: { inherit: "core" },
    },
  });
  const options: ThreadOptions = {
    workingDirectory: root,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    skipGitRepoCheck: true,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort
      ? { modelReasoningEffort: input.effort as ModelReasoningEffort }
      : {}),
  };
  const thread = session
    ? codex.resumeThread(session, options)
    : codex.startThread(options);
  const stream = await thread.runStreamed(input.prompt, { signal });
  let completed = false;
  for await (const event of stream.events) {
    if (event.type === "thread.started") saveSession(event.thread_id);
    if (
      event.type === "item.started" &&
      event.item.type === "command_execution"
    )
      log(`\n$ ${event.item.command}\n`);
    if (event.type === "item.completed") {
      const item = event.item;
      if (item.type === "agent_message") log(`${item.text}\n`);
      else if (item.type === "command_execution")
        log(`${item.aggregated_output}\n`);
      else if (item.type === "file_change")
        log(
          `Archivos: ${item.changes.map((change) => `${change.kind} ${change.path}`).join(", ")}\n`,
        );
      else if (item.type === "error") log(`Aviso: ${item.message}\n`);
      // Private reasoning and full tool payloads are deliberately not copied to the client log.
    }
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "turn.completed") {
      completed = true;
      log(
        `\nTokens: ${event.usage.input_tokens} entrada · ${event.usage.output_tokens} salida\n`,
      );
    }
  }
  if (thread.id) saveSession(thread.id);
  if (!completed)
    throw new Error("Codex cerró la sesión antes de completar el turno.");
}

async function runClaude(
  input: AgentInput,
  root: string,
  apiKey: string,
  session: string | undefined,
  saveSession: (id: string) => void,
  controller: AbortController,
  log: (text: string) => void,
  dependencies: AgentDependencies,
) {
  const supportsShellSandbox =
    process.platform === "linux" || process.platform === "darwin";
  const fileTools = new Set([
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "NotebookEdit",
  ]);
  const checkFileInput = (toolInput: Record<string, unknown>) => {
    const candidate =
      toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? ".";
    return isProjectPath(root, candidate);
  };
  const options: Options = {
    cwd: root,
    model: input.model,
    effort: input.effort as EffortLevel | undefined,
    env: {
      ...agentEnvironment(),
      ANTHROPIC_API_KEY: apiKey,
      CLAUDE_CONFIG_DIR: runtimeDirectory(dependencies, "claude"),
    },
    settingSources: [],
    permissionMode: "default",
    abortController: controller,
    tools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "NotebookEdit",
      ...(supportsShellSandbox ? ["Bash"] : []),
    ],
    ...(session ? { resume: session } : {}),
    maxTurns: 40,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        "You work inside an AppBuilder project. Read and change only files inside the working directory. Never read or output API keys, server credentials or user authentication files. Complete the requested change and explain the result concisely.",
    },
    ...(supportsShellSandbox
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: true,
          },
        }
      : {}),
    canUseTool: async (name, toolInput) => {
      if (fileTools.has(name) && checkFileInput(toolInput))
        return { behavior: "allow", updatedInput: toolInput };
      return {
        behavior: "deny",
        message:
          "Esta operación no está autorizada fuera del proyecto. Ejecuta manualmente los comandos necesarios desde la terminal.",
      };
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Write|Edit|Glob|Grep|NotebookEdit",
          hooks: [
            async (event) => {
              if (event.hook_event_name !== "PreToolUse") return {};
              if (checkFileInput(event.tool_input as Record<string, unknown>))
                return {};
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason:
                    "La ruta debe permanecer dentro del proyecto.",
                },
              };
            },
          ],
        },
      ],
    },
    stderr: (text) => log(text),
  };
  if (!supportsShellSandbox)
    log(
      "Claude puede leer y editar el proyecto. En Windows, ejecuta los comandos desde Terminal; el sandbox de Bash requiere Linux o macOS.\n\n",
    );
  const stream = query({ prompt: input.prompt, options });
  let completed = false;
  let lastText = "";
  try {
    for await (const event of stream) {
      if ("session_id" in event && typeof event.session_id === "string")
        saveSession(event.session_id);
      if (event.type === "assistant") {
        for (const content of event.message.content) {
          if (content.type === "text") {
            lastText = content.text;
            log(`${content.text}\n`);
          }
          if (content.type === "tool_use") log(`→ ${content.name}\n`);
        }
      }
      if (event.type === "result") {
        if (event.subtype !== "success")
          throw new Error(event.errors.join("\n") || event.subtype);
        if (event.is_error)
          throw new Error(event.result || "Claude no pudo completar el turno.");
        completed = true;
        if (event.result && event.result !== lastText) log(`${event.result}\n`);
        log(
          `\nCoste informado por Anthropic: $${event.total_cost_usd.toFixed(4)}\n`,
        );
      }
    }
  } finally {
    stream.close();
  }
  if (!completed)
    throw new Error("Claude cerró la sesión antes de completar el turno.");
}

export function mountAgentRoutes(
  router: Router,
  dependencies: AgentDependencies,
): void {
  router.post("/projects/:id/agent", async (request, response) => {
    const projectId = String(request.params.id);
    getProject(projectId);
    const body = request.body || {};
    if (body.provider !== "codex" && body.provider !== "claude")
      throw invalid("Selecciona Codex o Claude.");
    if (
      typeof body.prompt !== "string" ||
      !body.prompt.trim() ||
      body.prompt.length > 50_000
    )
      throw invalid("Escribe una tarea de entre 1 y 50.000 caracteres.");
    if (
      body.model !== undefined &&
      (typeof body.model !== "string" ||
        !/^[a-zA-Z0-9._:/-]{1,150}$/.test(body.model))
    )
      throw invalid("El identificador del modelo no es válido.");
    const effort =
      !body.effort || body.effort === "default" || body.effort === "auto"
        ? undefined
        : body.effort;
    if (effort !== undefined && typeof effort !== "string")
      throw invalid("El nivel de esfuerzo no es válido.");
    if (body.speed && !["standard", "default", "auto"].includes(body.speed))
      throw invalid(
        "Esta integración admite velocidad estándar. No se puede prometer una velocidad que el SDK no expone.",
      );
    const provider: Provider = body.provider;
    const account =
      provider === "codex" && dependencies.codexAuthMode() === "chatgpt";
    const credentials = dependencies.readCredentials(provider);
    if (account && !(await codexAccountStatus()))
      throw invalid(
        "Inicia sesión con ChatGPT mediante Codex en el ordenador que ejecuta AppBuilder.",
        409,
      );
    if (effort) {
      const catalog = await dependencies.discoverModels(provider);
      const model = catalog.models.find(
        (candidate) => candidate.id === body.model,
      );
      if (!model?.efforts.includes(effort))
        throw invalid(
          "Este esfuerzo no está verificado para el modelo elegido. Selecciona Automático o un nivel publicado por el proveedor.",
        );
    }
    if (activeProjects.has(projectId))
      throw invalid(
        "Ya hay un agente trabajando en este proyecto. Espera a que termine o cancela su tarea.",
        409,
      );
    const input: AgentInput = {
      provider,
      prompt: body.prompt.trim(),
      model: body.model,
      effort,
      speed: body.speed,
      newSession: body.newSession === true,
    };
    activeProjects.add(projectId);
    let checkpoint: Awaited<ReturnType<typeof createCheckpoint>>;
    let job: ReturnType<typeof createJob>;
    try {
      checkpoint = await createCheckpoint(projectId);
      job = createJob(
        projectId,
        "agent",
        dependencies.redactSecrets(
          `${provider === "codex" ? "Codex" : "Claude"} · ${input.prompt.slice(0, 90)}`,
        ),
      );
    } catch (error) {
      activeProjects.delete(projectId);
      throw error;
    }
    const root = projectDir(projectId);
    const filename = sessionFile(dependencies, projectId, provider, account);
    const session = input.newSession ? undefined : readSession(filename);
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    registerJobCancellation(job.id, async () => {
      controller.abort();
      await completion;
    });
    const log = (text: string) =>
      appendJob(job.id, dependencies.redactSecrets(text));
    log(
      `${provider === "codex" ? "Codex" : "Claude Agent"} · ${input.model || "modelo predeterminado"}${effort ? ` · ${effort}` : ""}\n${session ? "Continuando conversación" : "Nueva conversación"}\nPunto de restauración: ${checkpoint.hash}${checkpoint.created ? " (creado)" : ""}\n\n`,
    );
    response.status(202).json(job);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error("La tarea alcanzó el límite de 30 minutos."),
        ),
      30 * 60_000,
    );
    timeout.unref();
    const saveSession = (id: string) => storeSession(filename, id);
    void (async () => {
      try {
        if (provider === "codex")
          await runCodex(
            input,
            root,
            credentials.apiKey,
            account,
            session,
            saveSession,
            controller.signal,
            log,
            dependencies,
          );
        else
          await runClaude(
            input,
            root,
            credentials.apiKey,
            session,
            saveSession,
            controller,
            log,
            dependencies,
          );
        finishJob(
          job.id,
          controller.signal.aborted ? "cancelled" : "succeeded",
          0,
        );
      } catch (error) {
        const message = controller.signal.aborted
          ? "Tarea cancelada."
          : error instanceof Error
            ? error.message
            : "El agente encontró un error.";
        log(`\n${message}\n`);
        finishJob(
          job.id,
          controller.signal.aborted ? "cancelled" : "failed",
          1,
        );
      } finally {
        clearTimeout(timeout);
        activeProjects.delete(projectId);
        resolveCompletion();
      }
    })();
  });
}
