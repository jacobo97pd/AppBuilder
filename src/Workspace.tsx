import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  FileCode2,
  FileJson,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Smartphone,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
} from "lucide-react";
import { api, errorMessage, post } from "./api";
import type {
  Connection,
  FileEntry,
  GitState,
  Job,
  Model,
  Project,
  ToastFn,
} from "./types";
import {
  Empty,
  isCompactScreen,
  isTouchInput,
  Modal,
  relativeDate,
  Spinner,
  StatusDot,
  Tag,
  type Tone,
} from "./ui";

type Tab = "code" | "agent" | "preview" | "terminal" | "git";
type AgentDraft = {
  provider: string;
  model: string;
  effort: string;
  speed: string;
  prompt: string;
};
const tabs = [
  { id: "code", name: "Código", icon: Code2 },
  { id: "agent", name: "Agente", icon: Sparkles },
  { id: "preview", name: "Vista previa", icon: Play },
  { id: "terminal", name: "Terminal", icon: TerminalIcon },
  { id: "git", name: "Cambios", icon: GitBranch },
] as const;
export function Workspace({
  project,
  connections,
  notify,
  onConnections,
  onBack,
  initialPrompt,
  onChange,
  registerGuard,
}: {
  project: Project;
  connections: Connection[];
  notify: ToastFn;
  onConnections: () => void;
  onBack: () => void;
  initialPrompt: string;
  onChange: () => void;
  registerGuard?: (save: (() => Promise<boolean>) | null) => void;
}) {
  // A project created from an idea opens on the agent, with the idea ready to send.
  const [tab, setTab] = useState<Tab>(initialPrompt ? "agent" : "code");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newFile, setNewFile] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [revision, setRevision] = useState(0);
  const [fileFilter, setFileFilter] = useState("");
  // On phones the explorer is an overlay, so it starts closed.
  const [explorer, setExplorer] = useState(() => !isCompactScreen());
  const [rightPanel, setRightPanel] = useState(true);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentDraft>({
    provider: "codex",
    model: "",
    effort: "",
    speed: "",
    prompt: initialPrompt,
  });
  const [agentStarting, setAgentStarting] = useState(false);
  const [branch, setBranch] = useState("?");
  const [pendingChanges, setPendingChanges] = useState(0);
  const updateGitSummary = useCallback((state: GitState) => {
    setBranch(state.branch);
    setPendingChanges(state.changes.length);
  }, []);
  useEffect(() => {
    let stopped = false;
    api<GitState>(`/projects/${project.id}/git`)
      .then((state) => {
        if (!stopped) updateGitSummary(state);
      })
      .catch(() => {
        if (!stopped) setBranch("Git");
      });
    return () => {
      stopped = true;
    };
  }, [project.id, revision, updateGitSummary]);
  const dirty = content !== saved;
  const activeRef = useRef(activeFile);
  activeRef.current = activeFile;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const contentRef = useRef(content);
  contentRef.current = content;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const registerGuardRef = useRef(registerGuard);
  registerGuardRef.current = registerGuard;
  const mounted = useRef(true);
  const fileRequest = useRef(0);
  const treeRequest = useRef(0);
  const jobsRequest = useRef(0);
  const editVersion = useRef(0);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const runningAgent = jobs.some(
    (job) => job.kind === "agent" && job.status === "running",
  );
  const runningTerminal = jobs.some(
    (job) => job.kind === "terminal" && job.status === "running",
  );
  const runningAgentRef = useRef(runningAgent);
  runningAgentRef.current = runningAgent;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      fileRequest.current++;
      treeRequest.current++;
      jobsRequest.current++;
    };
  }, []);
  const refreshFiles = useCallback(async () => {
    const request = ++treeRequest.current;
    const next = await api<FileEntry[]>(`/projects/${project.id}/files`);
    if (mounted.current && request === treeRequest.current) setFiles(next);
  }, [project.id]);
  const read = useCallback(
    async (path: string, discard = false) => {
      if (!path || saveInFlight.current || (dirtyRef.current && !discard))
        return;
      const request = ++fileRequest.current;
      const version = editVersion.current;
      setLoading(true);
      try {
        const data = await api<{ content: string }>(
          `/projects/${project.id}/file?path=${encodeURIComponent(path)}`,
        );
        if (
          !mounted.current ||
          request !== fileRequest.current ||
          version !== editVersion.current ||
          (!discard && dirtyRef.current)
        )
          return;
        contentRef.current = data.content;
        savedRef.current = data.content;
        activeRef.current = path;
        dirtyRef.current = false;
        setContent(data.content);
        setSaved(data.content);
        setActiveFile(path);
      } catch (e) {
        if (mounted.current && request === fileRequest.current)
          notifyRef.current(errorMessage(e), "error");
      } finally {
        if (mounted.current && request === fileRequest.current)
          setLoading(false);
      }
    },
    [project.id],
  );
  useEffect(() => {
    let cancelled = false;
    void refreshFiles()
      .then(() => {
        if (!cancelled)
          return read(
            project.template === "react" ? "src/App.jsx" : "index.html",
          );
      })
      .catch((e) => {
        if (!cancelled) {
          setLoading(false);
          notifyRef.current(errorMessage(e), "error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshFiles, read, project.template]);
  useEffect(() => {
    let stopped = false;
    const refreshJobs = async () => {
      const request = ++jobsRequest.current;
      try {
        const next = await api<Job[]>(`/projects/${project.id}/jobs`);
        if (!stopped && request === jobsRequest.current) setJobs(next);
      } catch {
        /* Keep existing logs across brief disconnects. */
      }
    };
    void refreshJobs();
    const timer = setInterval(refreshJobs, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [project.id]);
  const previousRunning = useRef(false);
  useEffect(() => {
    const running = jobs.some((j) => j.status === "running");
    if (previousRunning.current && !running) {
      void refreshFiles().catch((e) =>
        notifyRef.current(errorMessage(e), "error"),
      );
      setRevision((v) => v + 1);
      if (activeRef.current && !dirtyRef.current) void read(activeRef.current);
    }
    previousRunning.current = running;
  }, [jobs, read, refreshFiles]);
  const save = useCallback((): Promise<boolean> => {
    if (saveInFlight.current) return saveInFlight.current;
    if (!dirtyRef.current) return Promise.resolve(true);
    if (!activeRef.current || runningAgentRef.current) {
      notifyRef.current(
        "Espera a que termine el agente antes de guardar.",
        "error",
      );
      return Promise.resolve(false);
    }
    const path = activeRef.current;
    const value = contentRef.current;
    const baseline = savedRef.current;
    setSaving(true);
    const operation = (async () => {
      try {
        await api(`/projects/${project.id}/file`, {
          method: "PUT",
          body: JSON.stringify({
            path,
            content: value,
            expectedContent: baseline,
          }),
        });
        if (!mounted.current) return false;
        if (activeRef.current === path) {
          savedRef.current = value;
          dirtyRef.current = contentRef.current !== value;
          setSaved(value);
        }
        const clean =
          activeRef.current === path && contentRef.current === value;
        if (clean) registerGuardRef.current?.(null);
        setRevision((v) => v + 1);
        onChangeRef.current();
        notifyRef.current("Archivo guardado.");
        return clean;
      } catch (e) {
        if (mounted.current) notifyRef.current(errorMessage(e), "error");
        return false;
      } finally {
        saveInFlight.current = null;
        if (mounted.current) setSaving(false);
      }
    })();
    saveInFlight.current = operation;
    return operation;
  }, [project.id]);
  useEffect(() => {
    registerGuard?.(dirty ? save : null);
    return () => registerGuard?.(null);
  }, [dirty, save, registerGuard]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  function selectFile(path: string) {
    if (isCompactScreen()) setExplorer(false);
    if (path === activeRef.current || saveInFlight.current) return;
    if (dirtyRef.current) {
      setPendingFile(path);
      return;
    }
    void read(path);
  }
  const onStart = (job: Job) => {
    jobsRequest.current++;
    setJobs((current) => [
      job,
      ...current.filter((item) => item.id !== job.id),
    ]);
  };
  const extensions = useMemo(
    () =>
      activeFile.endsWith(".css")
        ? [css()]
        : activeFile.endsWith(".html")
          ? [html()]
          : activeFile.endsWith(".json")
            ? [json()]
            : [
                javascript({
                  jsx: true,
                  typescript:
                    activeFile.endsWith(".ts") || activeFile.endsWith(".tsx"),
                }),
              ],
    [activeFile],
  );
  const agentPanel = (
    <AgentPanel
      project={project}
      connections={connections}
      jobs={jobs}
      notify={notify}
      onConnections={onConnections}
      draft={agentDraft}
      setDraft={setAgentDraft}
      starting={agentStarting}
      onBusyChange={setAgentStarting}
      onStart={onStart}
      beforeRun={async () => {
        if (runningAgentRef.current)
          throw new Error("Ya hay un agente trabajando en este proyecto.");
        if (!(await save()))
          throw new Error(
            "La tarea no se ha iniciado porque no se pudieron guardar tus cambios.",
          );
      }}
    />
  );
  const visibleFiles = files.filter(
    (f) =>
      !fileFilter || f.path.toLowerCase().includes(fileFilter.toLowerCase()),
  );
  return (
    <main className="workspace">
      <div className="workspace-toolbar">
        <div>
          <button
            className="icon-button"
            onClick={() => {
              if (!registerGuard && dirty) setPendingFile("__back");
              else onBack();
            }}
            aria-label="Volver a proyectos"
            title="Volver a proyectos"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="workspace-branch" title="Rama de Git">
            <GitBranch size={14} />
            {branch}
          </span>
          <span className={`workspace-save-status ${dirty ? "is-dirty" : ""}`}>
            {dirty ? (
              <>
                <span className="unsaved-dot" />
                Sin guardar
              </>
            ) : (
              <>
                <Check size={14} />
                Guardado
              </>
            )}
          </span>
        </div>
        <div>
          <button
            className="button small secondary"
            aria-label="Guardar archivo"
            title="Guardar (Ctrl + S)"
            onClick={() => void save()}
            disabled={
              !dirty || saving || loading || runningAgent || agentStarting
            }
          >
            {saving ? <Spinner /> : <Save size={15} />}
            <span>Guardar</span>
          </button>
          <button
            className="button small primary"
            title="Abrir la vista previa"
            onClick={() => setTab("preview")}
          >
            <Play size={15} />
            Ejecutar
          </button>
        </div>
      </div>
      <div className="workspace-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon">
              <t.icon size={17} />
              {((t.id === "terminal" && runningTerminal) ||
                (t.id === "agent" && runningAgent)) && (
                <span className="tab-live" aria-hidden="true" />
              )}
            </span>
            <span>{t.name}</span>
            {t.id === "git" && pendingChanges > 0 && (
              <span
                className="tab-badge"
                aria-hidden="true"
                title={`${pendingChanges} archivos con cambios`}
              >
                {pendingChanges > 99 ? "99+" : pendingChanges}
              </span>
            )}
          </button>
        ))}
        <div className="workspace-tabs-spacer" />
        {tab === "code" && (
          <button
            className={`assistant-toggle ${rightPanel ? "enabled" : ""}`}
            onClick={() => setRightPanel(!rightPanel)}
            aria-pressed={rightPanel}
            title={rightPanel ? "Ocultar asistente" : "Mostrar asistente"}
          >
            {rightPanel ? (
              <PanelRightClose size={16} />
            ) : (
              <PanelRightOpen size={16} />
            )}
            Asistente
          </button>
        )}
      </div>
      <div className={`workspace-content tab-${tab}`}>
        {tab === "code" && (
          <>
            <section
              className={`editor-layout ${explorer ? "" : "hide-explorer"}`}
            >
              {explorer && (
                <button
                  className="explorer-scrim"
                  aria-label="Cerrar explorador"
                  onClick={() => setExplorer(false)}
                />
              )}
              <aside className="file-explorer">
                <div className="panel-heading">
                  <span>Archivos</span>
                  <button
                    className="icon-button"
                    aria-label="Nuevo archivo"
                    title="Nuevo archivo"
                    disabled={saving || runningAgent || agentStarting}
                    onClick={() => setNewFile(true)}
                  >
                    <FilePlus2 size={17} />
                  </button>
                </div>
                <label className="file-filter">
                  <Search size={14} />
                  <input
                    placeholder="Buscar archivo…"
                    aria-label="Buscar archivo"
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                  />
                </label>
                <div className="file-tree">
                  <div className="file-root">
                    <ChevronDown size={14} />
                    <FolderOpen size={15} />
                    <strong>{project.name}</strong>
                  </div>
                  {visibleFiles.map((f) => (
                    <button
                      className={`file-row ${f.type === "directory" ? "directory" : ""} ${f.path === activeFile ? "active" : ""}`}
                      key={f.path}
                      disabled={f.type === "directory"}
                      style={{
                        paddingLeft: `${4 + f.path.split("/").length * 14}px`,
                      }}
                      onClick={() => selectFile(f.path)}
                    >
                      {f.type === "directory" ? (
                        <Folder size={15} className="folder-icon" />
                      ) : (
                        <FileIcon name={f.name} />
                      )}
                      <span>{f.name}</span>
                      {f.path === activeFile && dirty && (
                        <span className="unsaved-dot" />
                      )}
                    </button>
                  ))}
                  {!visibleFiles.length && fileFilter && (
                    <p className="file-empty">
                      Ningún archivo coincide con «{fileFilter}».
                    </p>
                  )}
                </div>
                <div className="explorer-foot">
                  <Check size={13} />
                  Archivos en tu servidor
                </div>
              </aside>
              <div className="code-panel">
                <div className="file-tabbar">
                  <button
                    className="icon-button explorer-toggle"
                    aria-label={
                      explorer ? "Ocultar archivos" : "Mostrar archivos"
                    }
                    aria-expanded={explorer}
                    title={explorer ? "Ocultar archivos" : "Mostrar archivos"}
                    onClick={() => setExplorer(!explorer)}
                  >
                    {explorer ? <FolderOpen size={17} /> : <Folder size={17} />}
                  </button>
                  <div className="active-file-tab">
                    <FileIcon name={activeFile || "archivo"} />
                    {activeFile.split("/").pop() || "Archivo"}
                    {dirty && <span className="unsaved-dot" />}
                  </div>
                  <div className="file-tab-spacer" />
                  <button
                    className="icon-button"
                    aria-label="Recargar archivo"
                    title="Recargar desde el servidor"
                    disabled={!activeFile || saving}
                    onClick={() => {
                      if (dirty) setPendingFile(activeFile);
                      else void read(activeFile);
                    }}
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
                <div className="editor-breadcrumb">
                  {project.name}
                  <ChevronRight size={13} />
                  {activeFile}
                </div>
                <div className="code-editor">
                  {loading ? (
                    <div className="editor-loading">
                      <Spinner />
                    </div>
                  ) : (
                    <CodeMirror
                      aria-label="Editor de código"
                      value={content}
                      height="100%"
                      theme={oneDark}
                      extensions={extensions}
                      readOnly={
                        !activeFile || saving || runningAgent || agentStarting
                      }
                      editable={
                        Boolean(activeFile) &&
                        !saving &&
                        !runningAgent &&
                        !agentStarting
                      }
                      onChange={(value) => {
                        editVersion.current++;
                        contentRef.current = value;
                        dirtyRef.current = value !== savedRef.current;
                        setContent(value);
                      }}
                      basicSetup={{
                        lineNumbers: true,
                        foldGutter: true,
                        highlightActiveLine: true,
                        autocompletion: true,
                      }}
                    />
                  )}
                </div>
                <div className="editor-statusbar">
                  <span>
                    <GitBranch size={13} />
                    {branch}
                  </span>
                  {(runningAgent || agentStarting) && (
                    <span className="editor-locked">
                      <Sparkles size={13} />
                      El agente está editando · solo lectura
                    </span>
                  )}
                  <span className="statusbar-push">UTF-8</span>
                  <span>{activeFile.split(".").pop()?.toUpperCase()}</span>
                  <span>{content.split("\n").length} líneas</span>
                </div>
              </div>
            </section>
            {rightPanel && (
              <aside className="workspace-assistant">{agentPanel}</aside>
            )}
          </>
        )}
        {tab === "agent" && <div className="full-agent">{agentPanel}</div>}
        {tab === "preview" && (
          <Preview
            project={project}
            revision={revision}
            dirty={dirty}
            onSave={save}
            notify={notify}
          />
        )}
        {tab === "terminal" && (
          <TerminalPanel
            project={project}
            jobs={jobs.filter((j) => j.kind === "terminal")}
            notify={notify}
            onStart={onStart}
          />
        )}
        {tab === "git" && (
          <GitPanel
            project={project}
            revision={revision}
            notify={notify}
            onStatus={updateGitSummary}
            canRestore={!dirty && !saving && !runningAgent && !agentStarting}
            beforeCommit={async () => {
              if (runningAgentRef.current || agentStarting) {
                notify(
                  "Espera a que termine el agente antes de crear un commit.",
                  "error",
                );
                return false;
              }
              return save();
            }}
            onRestored={() => {
              void read(activeFile);
              setRevision((r) => r + 1);
            }}
          />
        )}
      </div>
      {newFile && (
        <NewFile
          project={project}
          onClose={() => setNewFile(false)}
          onCreated={async (path) => {
            await refreshFiles();
            selectFile(path);
            setNewFile(false);
          }}
        />
      )}
      {pendingFile !== null && (
        <Modal
          title="Tienes cambios sin guardar"
          subtitle="Conserva tu trabajo antes de continuar."
          onClose={() => setPendingFile(null)}
        >
          <div className="form-footer">
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => {
                const next = pendingFile;
                setPendingFile(null);
                if (next === "__back") {
                  dirtyRef.current = false;
                  registerGuard?.(null);
                  onBack();
                } else void read(next, true);
              }}
            >
              Descartar cambios
            </button>
            <button
              className="button primary"
              disabled={saving}
              onClick={async () => {
                const next = pendingFile;
                if (!(await save())) return;
                setPendingFile(null);
                if (next === "__back") onBack();
                else void read(next);
              }}
            >
              Guardar y continuar
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
function FileIcon({ name }: { name: string }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "json") return <FileJson size={15} className="json-file" />;
  if (["md", "txt"].includes(extension))
    return <FileText size={15} className="text-file" />;
  const kind = ["html", "htm"].includes(extension)
    ? "html-file"
    : ["css", "scss"].includes(extension)
      ? "css-file"
      : "js-file";
  return <FileCode2 size={15} className={kind} />;
}

function AgentPanel({
  project,
  connections,
  jobs,
  notify,
  onConnections,
  draft,
  setDraft,
  starting,
  onBusyChange,
  onStart,
  beforeRun,
}: {
  project: Project;
  connections: Connection[];
  jobs: Job[];
  notify: ToastFn;
  onConnections: () => void;
  draft: AgentDraft;
  setDraft: React.Dispatch<React.SetStateAction<AgentDraft>>;
  starting: boolean;
  onBusyChange: (busy: boolean) => void;
  onStart: (job: Job) => void;
  beforeRun: () => Promise<void>;
}) {
  const { provider, model, effort, speed, prompt } = draft;
  const [models, setModels] = useState<Model[]>([]);
  const [localBusy, setBusy] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const busy = localBusy || starting;
  const runInFlight = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const touch = useMemo(isTouchInput, []);
  const setProvider = (provider: string) =>
    setDraft((current) =>
      current.provider === provider
        ? current
        : { ...current, provider, model: "", effort: "", speed: "" },
    );
  const setModel = (model: string) =>
    setDraft((current) => ({ ...current, model, effort: "", speed: "" }));
  const setEffort = (effort: string) =>
    setDraft((current) => ({ ...current, effort }));
  const setSpeed = (speed: string) =>
    setDraft((current) => ({ ...current, speed }));
  const setPrompt = (prompt: string) =>
    setDraft((current) => ({ ...current, prompt }));
  const connection = connections.find((c) => c.id === provider);
  const connected = connection?.status === "connected";
  const activeModel = models.find((m) => m.id === model);
  const agentJobs = jobs.filter((j) => j.kind === "agent");
  const running = agentJobs.find((j) => j.status === "running");
  const latestOutput = agentJobs[0]?.output.length ?? 0;
  useEffect(() => {
    // Keep the newest output in view unless the user scrolled up to read.
    const element = conversationRef.current;
    if (element && agentJobs.length && followOutput.current)
      element.scrollTop = element.scrollHeight;
  }, [agentJobs.length, latestOutput]);
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setModelMessage("");
    setLoadingModels(connected);
    if (!connected) return;
    api<{ models: Model[]; message?: string }>(
      `/agents/models?provider=${provider}`,
    )
      .then((data) => {
        if (cancelled) return;
        setModels(data.models);
        setDraft((current) => {
          if (current.provider !== provider) return current;
          const selected = data.models.find(
            (candidate) => candidate.id === current.model,
          );
          const model =
            selected?.id ||
            (connection?.authMode === "claude_code"
              ? data.models[0]?.id || ""
              : current.model || data.models[0]?.id || "");
          return {
            ...current,
            model,
            effort: selected?.efforts.includes(current.effort)
              ? current.effort
              : "",
            speed: selected?.speeds.includes(current.speed)
              ? current.speed
              : "",
          };
        });
        setModelMessage(data.message ?? "");
      })
      .catch((e) => {
        if (!cancelled) setModelMessage(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, connected, connection?.authMode, setDraft]);
  async function run() {
    if (
      !prompt.trim() ||
      busy ||
      runInFlight.current ||
      running ||
      !connected ||
      loadingModels
    )
      return;
    runInFlight.current = true;
    followOutput.current = true;
    setBusy(true);
    onBusyChange(true);
    const submitted = prompt;
    try {
      await beforeRun();
      const job = await post<Job>(`/projects/${project.id}/agent`, {
        provider,
        model: model || undefined,
        effort: activeModel?.efforts.includes(effort) ? effort : undefined,
        speed: activeModel?.speeds.includes(speed) ? speed : undefined,
        prompt: submitted,
      });
      onStart(job);
      setDraft((current) =>
        current.prompt === submitted ? { ...current, prompt: "" } : current,
      );
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      runInFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  const providerReady = (id: string) =>
    connections.some((c) => c.id === id && c.status === "connected");
  return (
    <div className="agent-panel">
      <div className="agent-heading">
        <span className="agent-avatar">
          <Sparkles size={17} />
        </span>
        <div>
          <strong>Tu compañero de código</strong>
          <span>Trabaja sobre {project.name}</span>
        </div>
        <Tag tone="accent">IA</Tag>
      </div>
      <div className="provider-switch" role="group" aria-label="Proveedor">
        <button
          className={provider === "codex" ? "active" : ""}
          aria-pressed={provider === "codex"}
          disabled={busy}
          onClick={() => setProvider("codex")}
        >
          <Braces size={15} />
          Codex
          <StatusDot active={providerReady("codex")} />
        </button>
        <button
          className={provider === "claude" ? "active" : ""}
          aria-pressed={provider === "claude"}
          disabled={busy}
          onClick={() => setProvider("claude")}
        >
          <span className="claude-symbol">✳</span>Claude
          <StatusDot active={providerReady("claude")} />
        </button>
      </div>
      <div
        className="agent-conversation"
        ref={conversationRef}
        onScroll={(e) => {
          const element = e.currentTarget;
          followOutput.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            80;
        }}
      >
        {!agentJobs.length ? (
          <div className="agent-welcome">
            <div className="agent-welcome-symbol" aria-hidden="true">
              <Sparkles size={26} />
            </div>
            <h3>
              Una idea.
              <br />
              Muchas posibilidades.
            </h3>
            <p>
              Describe un cambio, resuelve un error o construye algo desde cero.
            </p>
            <div className="agent-suggestions">
              {[
                "Explícame cómo funciona este proyecto",
                "Mejora el diseño para móvil",
                "Revisa el código y busca errores",
              ].map((text) => (
                <button
                  key={text}
                  onClick={() => {
                    setPrompt(text);
                    promptRef.current?.focus();
                  }}
                >
                  {text}
                  <ArrowUp size={14} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          [...agentJobs].reverse().map((job) => (
            <article className="agent-message" key={job.id}>
              <div className="agent-message-user">
                <p>{job.title}</p>
              </div>
              <div className="agent-message-result">
                <div className="agent-message-meta">
                  <span className="agent-avatar small">
                    <Sparkles size={13} />
                  </span>
                  <strong>Agente</strong>
                  <Tag
                    tone={
                      job.status === "failed"
                        ? "danger"
                        : job.status === "running"
                          ? "accent"
                          : job.status === "succeeded"
                            ? "success"
                            : ""
                    }
                  >
                    {statusLabel(job.status)}
                  </Tag>
                  <time dateTime={job.createdAt}>
                    {relativeDate(job.createdAt)}
                  </time>
                </div>
                <pre>{job.output || "Preparando el entorno…"}</pre>
                {job.status === "running" && (
                  <div className="agent-working">
                    <Spinner /> Trabajando en tu proyecto…
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>
      <div className="agent-compose">
        {!connected ? (
          <div className="agent-connect-notice">
            <span className="agent-connect-icon">
              <Plug size={17} />
            </span>
            <div>
              <strong>
                Conecta {provider === "codex" ? "Codex" : "Claude"}
              </strong>
              <p>
                {connection?.status === "error"
                  ? connection.detail
                  : provider === "codex"
                    ? "Conecta tu cuenta ChatGPT o añade una API key."
                    : "Conecta Claude Code del ordenador o añade una API key."}
              </p>
            </div>
            <button className="button small primary" onClick={onConnections}>
              Configurar agente
              <ArrowRight size={15} />
            </button>
          </div>
        ) : (
          <div className="model-controls">
            {loadingModels ? (
              <span className="model-loading">
                <Spinner /> Cargando modelos…
              </span>
            ) : (
              <label className="model-field grow">
                <span>Modelo</span>
                {models.length ? (
                  <select
                    aria-label="Modelo"
                    disabled={busy}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {model && !activeModel && (
                      <option value={model}>{model} (personalizado)</option>
                    )}
                    {models.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="Identificador del modelo"
                    disabled={busy}
                    placeholder="Identificador del modelo"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                )}
              </label>
            )}
            {!!activeModel?.efforts?.length && (
              <label className="model-field">
                <span>Esfuerzo</span>
                <select
                  aria-label="Esfuerzo"
                  disabled={busy}
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                >
                  <option value="">Automático</option>
                  {activeModel.efforts.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(activeModel?.speeds?.length ?? 0) > 1 && (
              <label className="model-field">
                <span>Velocidad</span>
                <select
                  aria-label="Velocidad"
                  disabled={busy}
                  value={speed}
                  onChange={(e) => setSpeed(e.target.value)}
                >
                  <option value="">Automática</option>
                  {activeModel!.speeds.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {modelMessage && connected && (
          <p className="model-message">{modelMessage}</p>
        )}
        <div className="agent-prompt">
          <textarea
            ref={promptRef}
            aria-label="Mensaje al agente"
            placeholder="Pídele algo a tu agente…"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              // Enter sends, Shift+Enter adds a line. Touch keyboards keep
              // Enter for new lines and send with the button.
              if (e.ctrlKey || e.metaKey || (!e.shiftKey && !touch)) {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div>
            <span className="agent-context">
              <FileCode2 size={13} />
              Proyecto completo
            </span>
            {running ? (
              <button
                className="send-button stop"
                aria-label="Detener agente"
                title="Detener agente"
                onClick={() =>
                  void post(`/jobs/${running.id}/cancel`).catch((e) =>
                    notify(errorMessage(e), "error"),
                  )
                }
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="Enviar al agente"
                title="Enviar al agente"
                disabled={!connected || !prompt.trim() || busy || loadingModels}
                onClick={() => void run()}
              >
                {busy ? <Spinner /> : <ArrowUp size={18} strokeWidth={2.4} />}
              </button>
            )}
          </div>
        </div>
        <p className="agent-footnote">
          {touch
            ? "Revisa los cambios en Código y Cambios."
            : "Enter para enviar · Mayús + Enter para una nueva línea"}
        </p>
      </div>
    </div>
  );
}

function Preview({
  project,
  revision,
  dirty,
  onSave,
  notify,
}: {
  project: Project;
  revision: number;
  dirty: boolean;
  onSave: () => Promise<boolean>;
  notify: ToastFn;
}) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const [logs, setLogs] = useState<{ level: string; text: string }[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ html: string }>(
        `/projects/${project.id}/preview`,
      );
      if (id === request.current) {
        setSource(data.html);
        setLogs([]);
      }
    } catch (e) {
      if (id === request.current) setError(errorMessage(e));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, [project.id]);
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load, revision]);
  useEffect(() => {
    const message = (e: MessageEvent) => {
      if (
        e.source === frame.current?.contentWindow &&
        e.data?.type === "appbuilder:console" &&
        typeof e.data.text === "string"
      )
        setLogs((v) => [
          ...v.slice(-99),
          { level: e.data.level, text: e.data.text.slice(0, 4000) },
        ]);
    };
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, []);
  const errors = logs.filter((log) => log.level === "error").length;
  return (
    <div className="preview-panel">
      <div className="preview-toolbar">
        <div className="device-switch" role="group" aria-label="Dispositivo">
          <button
            className={device === "mobile" ? "active" : ""}
            aria-label="Vista móvil"
            aria-pressed={device === "mobile"}
            title="Vista móvil"
            onClick={() => setDevice("mobile")}
          >
            <Smartphone size={16} />
          </button>
          <button
            className={device === "desktop" ? "active" : ""}
            aria-label="Vista escritorio"
            aria-pressed={device === "desktop"}
            title="Vista escritorio"
            onClick={() => setDevice("desktop")}
          >
            <Monitor size={16} />
          </button>
        </div>
        <span className="preview-address">
          <StatusDot active />
          {project.name.toLowerCase().replaceAll(" ", "-")}.preview
        </span>
        <button
          className="icon-button"
          aria-label="Actualizar vista previa"
          title="Actualizar vista previa"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? <Spinner /> : <RefreshCw size={16} />}
        </button>
      </div>
      {dirty && (
        <div className="preview-unsaved">
          <CircleAlert size={16} />
          <span>Guarda tus cambios para verlos aquí.</span>
          <button onClick={() => void onSave()}>Guardar ahora</button>
        </div>
      )}
      <div className={`preview-stage ${device}`}>
        {error ? (
          <Empty
            icon={<CircleAlert size={28} />}
            title="No se pudo ejecutar la vista previa"
            action={
              <button className="button secondary" onClick={() => void load()}>
                Volver a intentar
              </button>
            }
          >
            {error}
          </Empty>
        ) : (
          <div className={`preview-device ${device}`}>
            {device === "mobile" && (
              <div className="phone-top">
                <span>9:41</span>
                <div />
                <span>••• ▰</span>
              </div>
            )}
            {source ? (
              <iframe
                ref={frame}
                title="Vista previa del proyecto"
                sandbox="allow-scripts allow-forms"
                srcDoc={source}
              />
            ) : (
              <div className="preview-loading">
                <Spinner />
                <p>Preparando tu app…</p>
              </div>
            )}
            {device === "mobile" && (
              <div className="phone-bottom">
                <span />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="preview-console">
        <div>
          <TerminalIcon size={14} />
          <strong>Consola</strong>
          <span>
            {logs.length} {logs.length === 1 ? "mensaje" : "mensajes"}
          </span>
          {errors > 0 && (
            <Tag tone="danger">
              {errors} {errors === 1 ? "error" : "errores"}
            </Tag>
          )}
          <button onClick={() => setLogs([])} disabled={!logs.length}>
            Limpiar
          </button>
        </div>
        <section>
          {logs.length ? (
            logs.map((log, i) => (
              <p className={log.level} key={i}>
                {log.text}
              </p>
            ))
          ) : (
            <p>Los mensajes y errores de tu app aparecerán aquí.</p>
          )}
        </section>
      </div>
      <div className="preview-note">
        <Monitor size={14} />
        Vista previa web · Las funciones nativas requieren una build de
        dispositivo.
      </div>
    </div>
  );
}

function TerminalPanel({
  project,
  jobs,
  notify,
  onStart,
}: {
  project: Project;
  jobs: Job[];
  notify: ToastFn;
  onStart: (job: Job) => void;
}) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = jobs.find((j) => j.id === selected) ?? jobs[0];
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [current?.output]);
  async function run(cmd = command) {
    if (!cmd.trim() || busy) return;
    setBusy(true);
    try {
      const job = await post<Job>(`/projects/${project.id}/commands`, {
        command: cmd,
      });
      onStart(job);
      setSelected(job.id);
      setHistory((h) => [cmd, ...h].slice(0, 50));
      setHistoryIndex(-1);
      setCommand((current) => (current === cmd ? "" : current));
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="terminal-panel">
      <div className="terminal-heading">
        <div>
          <TerminalIcon size={17} />
          <strong>Terminal del proyecto</strong>
          <Tag>Servidor</Tag>
        </div>
        <span>Los comandos siguen en marcha al cambiar de pestaña.</span>
      </div>
      <div className="command-presets">
        <span>Comandos útiles</span>
        {["git status", "node --version", "npm install", "npm run build"].map(
          (cmd) => (
            <button
              key={cmd}
              title="Escribir en la terminal"
              onClick={() => {
                setCommand(cmd);
                input.current?.focus();
              }}
            >
              <ChevronRight size={13} />
              {cmd}
            </button>
          ),
        )}
      </div>
      <div className="terminal-body">
        <aside className="terminal-sessions">
          <div>Historial</div>
          {jobs.map((job) => (
            <button
              key={job.id}
              className={`${current?.id === job.id ? "active" : ""} ${job.status}`}
              onClick={() => setSelected(job.id)}
            >
              {job.status === "running" ? (
                <Spinner />
              ) : job.status === "succeeded" ? (
                <Check size={14} />
              ) : (
                <CircleAlert size={14} />
              )}
              <span>{job.title}</span>
            </button>
          ))}
        </aside>
        <div className="terminal-output">
          {current ? (
            <>
              <div className="terminal-command">
                <span>❯</span> {current.title}
              </div>
              <pre>{stripAnsi(current.output)}</pre>
              <div ref={end} />
              {current.status !== "running" && (
                <div className={`terminal-result ${current.status}`}>
                  {current.status === "succeeded" ? (
                    <Check size={14} />
                  ) : (
                    <CircleAlert size={14} />
                  )}
                  {statusLabel(current.status)}
                  {current.exitCode !== undefined &&
                    ` · código ${current.exitCode}`}
                </div>
              )}
            </>
          ) : (
            <div className="terminal-intro">
              <span className="terminal-intro-icon">
                <TerminalIcon size={26} />
              </span>
              <h3>Tu proyecto. Tu terminal.</h3>
              <p>
                Ejecuta comandos reales en el servidor.
                <br />
                Prueba <code>node --version</code> para empezar.
              </p>
              <small>
                Sesiones por comando · Sin entrada interactiva ni estado
                compartido entre comandos.
              </small>
            </div>
          )}
        </div>
      </div>
      <form
        className="terminal-input"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <span>❯</span>
        <input
          ref={input}
          aria-label="Comando de terminal"
          placeholder="Escribe un comando y pulsa Enter…"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const index = Math.min(historyIndex + 1, history.length - 1);
              setHistoryIndex(index);
              setCommand(history[index]);
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const index = Math.max(historyIndex - 1, -1);
              setHistoryIndex(index);
              setCommand(index < 0 ? "" : history[index]);
            }
          }}
        />
        <button
          type="submit"
          className="terminal-run"
          aria-label="Ejecutar comando"
          title="Ejecutar comando"
          disabled={!command.trim() || busy}
        >
          {busy ? <Spinner /> : <ArrowRight size={18} />}
        </button>
        {current?.status === "running" && (
          <button
            type="button"
            className="terminal-stop"
            aria-label="Cancelar comando"
            title="Cancelar comando"
            onClick={() =>
              void post(`/jobs/${current.id}/cancel`).catch((e) =>
                notify(errorMessage(e), "error"),
              )
            }
          >
            <Square size={14} />
          </button>
        )}
      </form>
      <div className="terminal-foot">
        <span>
          <StatusDot active />
          {project.name}
        </span>
        <span>Entorno personal · permisos del servidor</span>
      </div>
    </div>
  );
}

function GitPanel({
  project,
  revision,
  notify,
  onStatus,
  onRestored,
  canRestore,
  beforeCommit,
}: {
  project: Project;
  revision: number;
  notify: ToastFn;
  onStatus: (state: GitState) => void;
  onRestored: () => void;
  canRestore: boolean;
  beforeCommit: () => Promise<boolean>;
}) {
  const [git, setGit] = useState<GitState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState("");
  const [selected, setSelected] = useState("");
  const refresh = useCallback(async () => {
    try {
      const state = await api<GitState>(`/projects/${project.id}/git`);
      setGit(state);
      onStatus(state);
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }, [project.id, notify, onStatus]);
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  const diffRequest = useRef(0);
  useEffect(
    () => () => {
      diffRequest.current++;
    },
    [],
  );
  async function inspect(path: string) {
    const request = ++diffRequest.current;
    setSelected(path);
    setDiff("Cargando diferencias…");
    try {
      const data = await api<{ diff: string }>(
        `/projects/${project.id}/git/diff?path=${encodeURIComponent(path)}`,
      );
      if (request === diffRequest.current)
        setDiff(data.diff || "No hay diferencias de texto.");
    } catch (e) {
      if (request === diffRequest.current) {
        setDiff("No se pudieron cargar las diferencias.");
        notify(errorMessage(e), "error");
      }
    }
  }
  async function commit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (!(await beforeCommit())) return;
      await post(`/projects/${project.id}/git/commit`, { message });
      setMessage("");
      setDiff("");
      setSelected("");
      diffRequest.current++;
      await refresh();
      notify("Cambios guardados en Git.");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="git-panel">
      <div className="git-sidebar">
        <div className="panel-heading">
          <span>
            <GitBranch size={15} /> Control de versiones
          </span>
          <button
            className="icon-button"
            aria-label="Actualizar cambios"
            title="Actualizar cambios"
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        <form className="git-commit-form" onSubmit={commit}>
          <textarea
            aria-label="Mensaje del commit"
            required
            rows={3}
            placeholder="Describe lo que ha cambiado…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="button primary"
            disabled={busy || !message.trim() || !git?.changes.length}
          >
            {busy ? <Spinner /> : <Check size={16} />}Guardar commit
          </button>
          <small>
            Un commit guarda una versión de tu proyecto a la que podrás volver.
          </small>
        </form>
        <div className="git-group-title">
          Cambios <span>{git?.changes.length ?? 0}</span>
        </div>
        <div className="git-files">
          {git?.changes.length ? (
            git.changes.map((c) => {
              const change = describeChange(c.status);
              return (
                <button
                  key={c.path}
                  onClick={() => void inspect(c.path)}
                  className={selected === c.path ? "active" : ""}
                >
                  <FileIcon name={c.path} />
                  <span>{c.path}</span>
                  <Tag tone={change.tone}>{change.label}</Tag>
                </button>
              );
            })
          ) : (
            <div className="git-clean">
              <span>
                <Check size={18} />
              </span>
              <p>
                Todo al día.
                <br />
                <small>No hay cambios pendientes.</small>
              </p>
            </div>
          )}
        </div>
        <div className="git-group-title git-history-title">Historial</div>
        <div className="git-history">
          {git?.log.map((item) => (
            <div key={item.hash}>
              <GitCommitHorizontal size={17} />
              <div>
                <strong>{item.message}</strong>
                <small>
                  {item.hash.slice(0, 7)} · {relativeDate(item.date)}
                </small>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="git-diff">
        {selected ? (
          <>
            <div className="panel-heading">
              <span className="git-diff-path">{selected}</span>
              <button
                className="button small secondary"
                disabled={!canRestore || busy}
                title={
                  !canRestore
                    ? "Guarda tus cambios y espera a que termine el agente."
                    : "Descarta los cambios de este archivo"
                }
                onClick={async () => {
                  if (!canRestore || busy) return;
                  setBusy(true);
                  diffRequest.current++;
                  try {
                    await post(`/projects/${project.id}/git/restore`, {
                      path: selected,
                    });
                    await refresh();
                    setSelected("");
                    setDiff("");
                    onRestored();
                    notify("Archivo restaurado al último commit.");
                  } catch (e) {
                    notify(errorMessage(e), "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RotateCcw size={14} />
                Restaurar archivo
              </button>
            </div>
            <pre>
              {diff.split("\n").map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("+")
                      ? "diff-add"
                      : line.startsWith("-")
                        ? "diff-remove"
                        : line.startsWith("@@")
                          ? "diff-info"
                          : ""
                  }
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          </>
        ) : (
          <Empty icon={<GitBranch size={30} />} title="Cada cambio cuenta">
            Selecciona un archivo para revisar las diferencias. Guarda un commit
            para crear un punto al que volver.
          </Empty>
        )}
      </div>
    </div>
  );
}
function NewFile({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Nuevo archivo"
      subtitle="Puedes incluir carpetas, por ejemplo src/components/Button.jsx."
      onClose={onClose}
    >
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post(`/projects/${project.id}/files`, { path, content: "" });
            await onCreated(path);
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        <label>
          Ruta del archivo
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="src/nuevo-archivo.js"
          />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : <FilePlus2 size={17} />}Crear archivo
        </button>
      </form>
    </Modal>
  );
}
/** Translates `git status --porcelain` codes into words a person can scan. */
function describeChange(status: string): { label: string; tone: Tone } {
  if (status.includes("U") || status === "AA" || status === "DD")
    return { label: "Conflicto", tone: "danger" };
  if (status === "??") return { label: "Nuevo", tone: "success" };
  if (status.includes("D")) return { label: "Eliminado", tone: "danger" };
  if (status.includes("R")) return { label: "Renombrado", tone: "info" };
  if (status.includes("A")) return { label: "Añadido", tone: "success" };
  if (status.includes("C")) return { label: "Copiado", tone: "info" };
  return { label: "Modificado", tone: "warning" };
}
function statusLabel(status: string) {
  return (
    (
      {
        running: "En curso",
        succeeded: "Completado",
        failed: "Error",
        cancelled: "Cancelado",
      } as Record<string, string>
    )[status] || status
  );
}
function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
