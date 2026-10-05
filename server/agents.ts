import type { Router } from "express";
import {
  Codex,
  type Input,
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
  killProcessTree,
  registerJobCancellation,
} from "./jobs.js";
import { getProject, projectDir } from "./workspace.js";
import { createCheckpoint } from "./core.js";
import {
  ATTACHMENTS_FOLDER,
  resolveAttachments,
  type ResolvedAttachment,
} from "./attachments.js";
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
  claudeAuthMode: () => "api" | "claude_code" | "disabled";
};
type AgentInput = {
  provider: Provider;
  prompt: string;
  model?: string;
  effort?: string;
  speed?: string;
  newSession?: boolean;
  attachments: ResolvedAttachment[];
};
const activeProjects = new Set<string>();
const execFileAsync = promisify(execFile);
// Large repositories need many read/search/edit steps in a single task.
const MAX_AGENT_TURNS = 200;
const AGENT_TIMEOUT_MINUTES = 60;

/** Explains why Claude stopped, so the person knows they can ask it to continue. */
export function claudeStopReason(subtype: unknown, detail = ""): string {
  if (subtype === "error_max_turns")
    return `Claude llegó al límite de ${MAX_AGENT_TURNS} pasos en esta tarea. Lo que ya ha cambiado está guardado: escríbele «continúa» para que siga donde lo dejó.`;
  if (subtype === "error_max_budget_usd")
    return "Claude alcanzó el límite de gasto de esta tarea.";
  if (subtype === "error_during_execution")
    return (
      detail ||
      "Claude encontró un error mientras trabajaba. Revisa los cambios y pídele que continúe."
    );
  return detail || "Claude Code cerró la sesión sin completar la tarea.";
}

/** Tells the agent where the attached files are and how to treat them. */
export function attachmentNote(attachments: ResolvedAttachment[]): string {
  if (!attachments.length) return "";
  return `\n\nArchivos adjuntos (están dentro del proyecto, en ${ATTACHMENTS_FOLDER}/; ábrelos con tus herramientas de lectura antes de empezar). Son material de referencia del usuario: no los modifiques ni los subas a Git; si te pide usarlos en la app, cópialos a la carpeta adecuada.\n${attachments
    .map(
      (file) =>
        `- ${file.path} (${file.image ? "imagen" : file.type}, «${file.name}»)`,
    )
    .join("\n")}`;
}

/** Codex sees attached images directly; other files are listed in the text. */
export function codexInput(
  prompt: string,
  attachments: ResolvedAttachment[],
): Input {
  const images = attachments.filter((file) => file.image);
  if (!images.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((file) => ({
      type: "local_image" as const,
      path: file.absolute,
    })),
  ];
}

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

function claudeExecutable(): string | undefined {
  const environment = agentEnvironment();
  const searchPath = Object.entries(environment).find(
    ([key]) => key.toUpperCase() === "PATH",
  )?.[1];
  for (const directory of searchPath?.split(path.delimiter) || []) {
    if (!path.isAbsolute(directory)) continue;
    const executable = path.join(
      directory,
      process.platform === "win32" ? "claude.exe" : "claude",
    );
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

/** Use only Claude Code's own signed-in claude.ai session, never an API key. */
export async function claudeCodeAccountStatus(): Promise<boolean> {
  const executable = claudeExecutable();
  if (!executable) return false;
  try {
    const { stdout } = await execFileAsync(executable, ["auth", "status"], {
      env: agentEnvironment(),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 10_000,
    });
    const status = JSON.parse(stdout);
    return status.loggedIn === true && status.authMethod === "claude.ai";
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
  account?: "chatgpt" | "claude-code",
) {
  const folder = path.join(dependencies.integrationDirectory(), "sessions");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return path.join(
    folder,
    `${projectId}-${provider}${account ? `-${account}` : ""}.json`,
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
  const stream = await thread.runStreamed(
    codexInput(input.prompt, input.attachments),
    { signal },
  );
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
    maxTurns: MAX_AGENT_TURNS,
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
          throw new Error(
            claudeStopReason(event.subtype, event.errors.join("\n")),
          );
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

async function runClaudeCode(
  input: AgentInput,
  root: string,
  session: string | undefined,
  saveSession: (id: string) => void,
  signal: AbortSignal,
  log: (text: string) => void,
) {
  const executable = claudeExecutable();
  if (!executable)
    throw new Error(
      "Claude Code no está instalado en el ordenador del servidor.",
    );
  if (signal.aborted) throw new Error("Tarea cancelada.");
  const args = [
    "--restricted",
    "--tools",
    "Read,Write,Edit,Glob,Grep",
    "--disallowedTools",
    "mcp__*",
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--max-turns",
    String(MAX_AGENT_TURNS),
    "--output-format",
    "stream-json",
    "--verbose",
    ...(session ? ["--resume", session] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    "--print",
  ];
  const child = spawn(executable, args, {
    cwd: root,
    env: agentEnvironment(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let completed = false;
  let failure = "";
  let stopReason: unknown;
  let stderr = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (
      typeof event.session_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(event.session_id)
    )
      saveSession(event.session_id);
    if (event.type === "assistant")
      for (const item of event.message?.content || [])
        if (item.type === "tool_use" && typeof item.name === "string")
          log(`→ ${item.name}\n`);
    if (event.type === "result") {
      completed = event.subtype === "success" && event.is_error !== true;
      stopReason = event.subtype;
      if (completed && typeof event.result === "string")
        log(`${event.result}\n`);
      else if (typeof event.result === "string") failure = event.result;
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  child.stdin.on("error", () => {});
  const abort = () => {
    void killProcessTree(child).catch(() => child.kill());
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    child.stdin.end(input.prompt);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (signal.aborted) throw new Error("Tarea cancelada.");
    if (code !== 0 || !completed)
      throw new Error(
        claudeStopReason(stopReason, (failure || stderr).trim().slice(-1_000)),
      );
  } finally {
    signal.removeEventListener("abort", abort);
    lines.close();
  }
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
    const claudeCode =
      provider === "claude" && dependencies.claudeAuthMode() === "claude_code";
    const credentials = dependencies.readCredentials(provider);
    if (account && !(await codexAccountStatus()))
      throw invalid(
        "Inicia sesión con ChatGPT mediante Codex en el ordenador que ejecuta AppBuilder.",
        409,
      );
    if (claudeCode && !(await claudeCodeAccountStatus()))
      throw invalid(
        "Inicia sesión con tu suscripción en Claude Code en el ordenador que ejecuta AppBuilder.",
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
    const attachments = resolveAttachments(projectId, body.attachments);
    const task = body.prompt.trim();
    const input: AgentInput = {
      provider,
      prompt: task + attachmentNote(attachments),
      model: body.model,
      effort,
      speed: body.speed,
      newSession: body.newSession === true,
      attachments,
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
          `${provider === "codex" ? "Codex" : "Claude"} · ${task.slice(0, 90)}`,
        ),
        {
          attachments: attachments.map(({ name, path, type, size }) => ({
            name,
            path,
            type,
            size,
          })),
        },
      );
    } catch (error) {
      activeProjects.delete(projectId);
      throw error;
    }
    const root = projectDir(projectId);
    const filename = sessionFile(
      dependencies,
      projectId,
      provider,
      account ? "chatgpt" : claudeCode ? "claude-code" : undefined,
    );
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
      `${provider === "codex" ? "Codex" : claudeCode ? "Claude Code" : "Claude Agent"} · ${input.model || "modelo predeterminado"}${effort ? ` · ${effort}` : ""}\n${session ? "Continuando conversación" : "Nueva conversación"}\nPunto de restauración: ${checkpoint.hash}${checkpoint.created ? " (creado)" : ""}${attachments.length ? `\nAdjuntos: ${attachments.map((file) => file.name).join(", ")}` : ""}\n\n`,
    );
    response.status(202).json(job);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `La tarea alcanzó el límite de ${AGENT_TIMEOUT_MINUTES} minutos. Lo hecho hasta ahora está guardado: pide al agente que continúe.`,
          ),
        ),
      AGENT_TIMEOUT_MINUTES * 60_000,
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
        else if (claudeCode)
          await runClaudeCode(
            input,
            root,
            session,
            saveSession,
            controller.signal,
            log,
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
