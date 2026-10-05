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
  CloudDownload,
  CloudUpload,
  Code2,
  Copy,
  FileCode2,
  FileJson,
  FilePlus2,
  FileText,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Hammer,
  Info,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import { api, errorMessage, post, serverUrl } from "./api";
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
  projectKind,
  relativeDate,
  Spinner,
  StatusDot,
  Tag,
  type Tone,
} from "./ui";

// Above this many entries the explorer starts with folders collapsed.
const EXPANDED_TREE_LIMIT = 120;
// The server lists at most this many entries per project.
const LISTED_ENTRIES_LIMIT = 20_000;
const PUSH_AFTER_COMMIT_KEY = "appbuilder.pushAfterCommit";
/** Provider effort ids in plain Spanish, from lightest to deepest. */
const effortLabels: Record<string, string> = {
  minimal: "Mínimo",
  low: "Bajo",
  medium: "Medio",
  high: "Alto",
  xhigh: "Muy alto",
  max: "Máximo",
  ultra: "Ultra",
  persistent: "Persistente",
};
const deepEfforts = new Set(["xhigh", "max", "ultra", "persistent"]);
const TAB_KEY = "appbuilder.tab";
const DRAFT_KEY = "appbuilder.agentDraft";
const AGENT_PREFERENCES_KEY = "appbuilder.agent";
const tabIds = ["code", "agent", "preview", "terminal", "git"];

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeLocal(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* Preferences are optional; the studio works without storage. */
  }
}
function savedTab(projectId: string): Tab {
  const value = readLocal(`${TAB_KEY}.${projectId}`);
  return tabIds.includes(value) ? (value as Tab) : "code";
}
type ModelChoice = { model?: string; effort?: string };
type AgentPreferences = {
  provider?: string;
  choices: Record<string, ModelChoice>;
};
function agentPreferences(): AgentPreferences {
  try {
    const value = JSON.parse(readLocal(AGENT_PREFERENCES_KEY) || "{}");
    return {
      provider: typeof value.provider === "string" ? value.provider : undefined,
      choices:
        value.choices && typeof value.choices === "object" ? value.choices : {},
    };
  } catch {
    return { choices: {} };
  }
}

function lastOutputLine(output: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ""
  );
}

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
  onDeleted,
  registerGuard,
}: {
  project: Project;
  connections: Connection[];
  notify: ToastFn;
  onConnections: () => void;
  onBack: () => void;
  initialPrompt: string;
  onChange: () => void;
  onDeleted: () => void;
  registerGuard?: (save: (() => Promise<boolean>) | null) => void;
}) {
  // A project created from an idea opens on the agent, with the idea ready to
  // send; otherwise reopen the tab that was in use for this project.
  const [tab, setTab] = useState<Tab>(() =>
    initialPrompt ? "agent" : savedTab(project.id),
  );
  useEffect(() => {
    writeLocal(`${TAB_KEY}.${project.id}`, tab);
  }, [project.id, tab]);
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const treeReady = useRef(false);
  const [settings, setSettings] = useState(false);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentDraft>(() => {
    // Keep the chosen model and effort, and any unsent message, across
    // app restarts (phones close apps in the background).
    const preferences = agentPreferences();
    const provider = preferences.provider === "claude" ? "claude" : "codex";
    return {
      provider,
      model: preferences.choices[provider]?.model ?? "",
      effort: preferences.choices[provider]?.effort ?? "",
      speed: "",
      prompt: initialPrompt || readLocal(`${DRAFT_KEY}.${project.id}`) || "",
    };
  });
  useEffect(() => {
    writeLocal(`${DRAFT_KEY}.${project.id}`, agentDraft.prompt);
  }, [project.id, agentDraft.prompt]);
  useEffect(() => {
    const preferences = agentPreferences();
    preferences.provider = agentDraft.provider;
    preferences.choices[agentDraft.provider] = {
      model: agentDraft.model,
      effort: agentDraft.effort,
    };
    writeLocal(AGENT_PREFERENCES_KEY, JSON.stringify(preferences));
  }, [agentDraft.provider, agentDraft.model, agentDraft.effort]);
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
    return next;
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
      .then((list) => {
        if (cancelled) return;
        const first = initialFile(project, list);
        if (first) return read(first);
        // Nothing obvious to open: show the files so the person can choose.
        setLoading(false);
        setExplorer(true);
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
    // Small projects open fully expanded; big repositories start collapsed.
    if (treeReady.current || !files.length) return;
    treeReady.current = true;
    if (files.length <= EXPANDED_TREE_LIMIT)
      setExpanded(
        new Set(files.filter((f) => f.type === "directory").map((f) => f.path)),
      );
  }, [files]);
  useEffect(() => {
    if (!activeFile.includes("/")) return;
    setExpanded((current) => {
      const parents = ancestors(activeFile);
      if (parents.every((folder) => current.has(folder))) return current;
      return new Set([...current, ...parents]);
    });
  }, [activeFile]);
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
    // Back from the background: show the agent's progress straight away.
    const resume = () => {
      if (document.visibilityState === "visible") void refreshJobs();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
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
  const extensions = useMemo(() => editorLanguage(activeFile), [activeFile]);
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
  const filter = fileFilter.trim().toLowerCase();
  // Searching shows matches from every folder; otherwise only open folders.
  // Names match by default; typing a "/" searches whole paths instead.
  const treeEntries = filter
    ? files.filter((f) =>
        (filter.includes("/") ? f.path : f.name).toLowerCase().includes(filter),
      )
    : files.filter((f) => ancestors(f.path).every((dir) => expanded.has(dir)));
  const visibleFiles = treeEntries.slice(0, 600);
  const toggleFolder = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
            className="icon-button"
            aria-label="Ajustes del proyecto"
            title="Ajustes del proyecto"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={18} />
          </button>
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
                  {visibleFiles.map((f) => {
                    const folder = f.type === "directory";
                    const open = expanded.has(f.path);
                    const parent = f.path.slice(0, -f.name.length - 1);
                    return (
                      <button
                        className={`file-row ${folder ? "directory" : ""} ${f.path === activeFile ? "active" : ""}`}
                        key={f.path}
                        aria-expanded={folder && !filter ? open : undefined}
                        title={f.path}
                        style={{
                          paddingLeft: `${filter ? 8 : 6 + (f.path.split("/").length - 1) * 14}px`,
                        }}
                        onClick={() =>
                          folder && !filter
                            ? toggleFolder(f.path)
                            : !folder && selectFile(f.path)
                        }
                      >
                        <span className="file-twisty" aria-hidden="true">
                          {folder && !filter && (
                            <ChevronRight
                              size={14}
                              className={open ? "open" : ""}
                            />
                          )}
                        </span>
                        {folder ? (
                          open && !filter ? (
                            <FolderOpen size={15} className="folder-icon" />
                          ) : (
                            <Folder size={15} className="folder-icon" />
                          )
                        ) : (
                          <FileIcon name={f.name} />
                        )}
                        <span className="file-name">{f.name}</span>
                        {filter && parent && (
                          <span className="file-parent">{parent}</span>
                        )}
                        {f.path === activeFile && dirty && (
                          <span className="unsaved-dot" />
                        )}
                      </button>
                    );
                  })}
                  {!visibleFiles.length && fileFilter && (
                    <p className="file-empty">
                      Ningún archivo coincide con «{fileFilter}».
                    </p>
                  )}
                  {treeEntries.length > visibleFiles.length && (
                    <p className="file-empty">
                      Se muestran {visibleFiles.length} de {treeEntries.length}.
                      Escribe más letras para afinar la búsqueda.
                    </p>
                  )}
                </div>
                <div className="explorer-foot">
                  <Check size={13} />
                  {files.length >= LISTED_ENTRIES_LIMIT
                    ? "Se muestran los primeros 20.000 elementos"
                    : "Archivos en tu servidor"}
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
            jobs={jobs}
            onStart={onStart}
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
            syncJobs={jobs.filter((j) => j.kind === "git")}
            onStart={onStart}
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
      {settings && (
        <ProjectSettings
          project={project}
          busy={jobs.some((job) => job.status === "running")}
          onClose={() => setSettings(false)}
          onDeleted={() => {
            dirtyRef.current = false;
            registerGuard?.(null);
            onDeleted();
          }}
        />
      )}
    </main>
  );
}
/** README first for imported repositories; templates open their main file. */
function initialFile(project: Project, files: FileEntry[]): string {
  if (project.template === "react") return "src/App.jsx";
  if (project.template === "web") return "index.html";
  const top = files.filter((f) => f.type === "file" && !f.path.includes("/"));
  return (
    (
      top.find((f) => /^readme(\.md|\.txt)?$/i.test(f.name)) ??
      top.find((f) => /\.(md|txt|json|js|ts|cs|html|py)$/i.test(f.name)) ??
      top[0]
    )?.path ?? ""
  );
}
function ancestors(filePath: string): string[] {
  const parts = filePath.split("/");
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
}
const cLikeExtensions = new Set([
  "cs",
  "java",
  "kt",
  "swift",
  "dart",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "go",
  "rs",
  "gd",
  "shader",
  "hlsl",
  "cginc",
  "compute",
]);
/** Syntax mode by extension. C-like languages borrow the TypeScript grammar,
 * which colors their comments, strings and common keywords well enough. */
function editorLanguage(file: string) {
  const extension = file.split(".").pop()?.toLowerCase() ?? "";
  if (["css", "scss", "less"].includes(extension)) return [css()];
  if (["html", "htm", "vue", "svelte"].includes(extension)) return [html()];
  if (["json", "jsonc", "asmdef", "asmref"].includes(extension))
    return [json()];
  if (["js", "jsx", "mjs", "cjs"].includes(extension))
    return [javascript({ jsx: true })];
  if (["ts", "tsx", "mts", "cts"].includes(extension))
    return [javascript({ jsx: extension.endsWith("x"), typescript: true })];
  if (cLikeExtensions.has(extension)) return [javascript({ typescript: true })];
  return [];
}
function ProjectSettings({
  project,
  busy,
  onClose,
  onDeleted,
}: {
  project: Project;
  busy: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [directory, setDirectory] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ directory: string }>(`/projects/${project.id}/details`)
      .then((details) => setDirectory(details.directory))
      .catch(() => setDirectory(""));
  }, [project.id]);
  const source = project.source;
  const sourceLink = source?.url
    .replace(/\.git$/i, "")
    .replace(/^git@([^:]+):/, "https://$1/");
  return (
    <Modal
      title="Ajustes del proyecto"
      subtitle={project.name}
      onClose={onClose}
    >
      <dl className="project-details">
        <div>
          <dt>Origen</dt>
          <dd>
            {source ? (
              <a
                className="text-link"
                href={sourceLink}
                target="_blank"
                rel="noreferrer"
              >
                <FolderGit2 size={15} />
                {source.url.replace(/^https:\/\//, "").replace(/\.git$/i, "")}
              </a>
            ) : (
              `Creado en el estudio · plantilla ${projectKind(project)}`
            )}
          </dd>
        </div>
        {source?.branch && (
          <div>
            <dt>Rama importada</dt>
            <dd>
              <code>{source.branch}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Carpeta en el servidor</dt>
          <dd className="project-directory">
            <code>{directory || "…"}</code>
            {directory && (
              <button
                className="icon-button"
                aria-label="Copiar ruta"
                title="Copiar ruta"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(directory);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  } catch {
                    /* Clipboard access can be blocked; the path stays visible. */
                  }
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>Creado</dt>
          <dd>{relativeDate(project.createdAt)}</dd>
        </div>
      </dl>
      <div className="danger-zone">
        <h3>Eliminar proyecto</h3>
        <p>
          {source
            ? "Se borra la copia de este servidor. Lo que ya está en el repositorio remoto no se toca, pero perderás los commits sin subir y los cambios sin guardar."
            : "Se borran los archivos y el historial de este proyecto. No se puede deshacer."}
        </p>
        {busy && (
          <p className="danger-note">
            <Info size={15} /> Hay tareas en curso. Espera a que terminen para
            poder eliminarlo.
          </p>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {confirming ? (
          <div className="danger-actions">
            <button
              className="button secondary"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </button>
            <button
              className="button danger"
              disabled={deleting || busy}
              onClick={async () => {
                setDeleting(true);
                setError("");
                try {
                  await api(`/projects/${project.id}`, { method: "DELETE" });
                  onDeleted();
                } catch (e) {
                  setError(errorMessage(e));
                  setDeleting(false);
                }
              }}
            >
              {deleting ? <Spinner /> : <Trash2 size={16} />} Sí, eliminar
              definitivamente
            </button>
          </div>
        ) : (
          <button
            className="button danger-outline"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={16} /> Eliminar proyecto
          </button>
        )}
      </div>
    </Modal>
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
      : cLikeExtensions.has(extension)
        ? "cs-file"
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
    setDraft((current) => {
      if (current.provider === provider) return current;
      // Each provider remembers its own last model and effort.
      const choice = agentPreferences().choices[provider] ?? {};
      return {
        ...current,
        provider,
        model: choice.model ?? "",
        effort: choice.effort ?? "",
        speed: "",
      };
    });
  const setModel = (model: string) =>
    setDraft((current) => ({
      ...current,
      model,
      // Keep the chosen effort when the new model also offers it.
      effort: models
        .find((candidate) => candidate.id === model)
        ?.efforts.includes(current.effort)
        ? current.effort
        : "",
      speed: "",
    }));
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
                      {effortLabels[e] ?? e}
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
        {connected && deepEfforts.has(effort) && (
          <p className="model-message deep-effort">
            <Sparkles size={13} /> Razonamiento{" "}
            {(effortLabels[effort] ?? effort).toLowerCase()}: piensa más a
            fondo, tarda más y consume más cuota de tu plan.
          </p>
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

type FlutterStatus = {
  flutter: boolean;
  sdk: string | null;
  needsWeb: boolean;
  builtAt: string | null;
  url: string | null;
  job: Job | null;
};

/** Imported Flutter apps get a web build preview; everything else is static. */
function Preview({
  project,
  revision,
  dirty,
  onSave,
  notify,
  jobs,
  onStart,
}: {
  project: Project;
  revision: number;
  dirty: boolean;
  onSave: () => Promise<boolean>;
  notify: ToastFn;
  jobs: Job[];
  onStart: (job: Job) => void;
}) {
  const repository = project.template === "repo";
  const [flutter, setFlutter] = useState<FlutterStatus | null>(null);
  const [checked, setChecked] = useState(!repository);
  useEffect(() => {
    if (!repository) return;
    let stopped = false;
    api<FlutterStatus>(`/projects/${project.id}/flutter`)
      .then((status) => {
        if (!stopped) setFlutter(status);
      })
      .catch(() => {
        /* Not available: fall back to the static preview. */
      })
      .finally(() => {
        if (!stopped) setChecked(true);
      });
    return () => {
      stopped = true;
    };
  }, [project.id, repository, revision]);
  if (!checked)
    return (
      <div className="preview-panel">
        <div className="preview-loading">
          <Spinner />
          <p>Preparando la vista previa…</p>
        </div>
      </div>
    );
  if (flutter?.flutter)
    return (
      <FlutterPreview
        project={project}
        status={flutter}
        dirty={dirty}
        onSave={onSave}
        notify={notify}
        jobs={jobs}
        onStart={onStart}
      />
    );
  return (
    <WebPreview
      project={project}
      revision={revision}
      dirty={dirty}
      onSave={onSave}
      notify={notify}
    />
  );
}

function useConsoleLogs(frame: React.RefObject<HTMLIFrameElement | null>) {
  const [logs, setLogs] = useState<{ level: string; text: string }[]>([]);
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
  }, [frame]);
  return [logs, setLogs] as const;
}

function FlutterPreview({
  project,
  status,
  dirty,
  onSave,
  notify,
  jobs,
  onStart,
}: {
  project: Project;
  status: FlutterStatus;
  dirty: boolean;
  onSave: () => Promise<boolean>;
  notify: ToastFn;
  jobs: Job[];
  onStart: (job: Job) => void;
}) {
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const [starting, setStarting] = useState(false);
  const [reload, setReload] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const [logs, setLogs] = useConsoleLogs(frame);
  const job =
    jobs.find(
      (item) => item.kind === "build" && item.title.startsWith("Flutter"),
    ) ?? status.job;
  const building = job?.status === "running";
  const failed =
    !building &&
    job?.status === "failed" &&
    (!status.builtAt || job.createdAt > status.builtAt);
  const errors = logs.filter((log) => log.level === "error").length;
  async function build() {
    setStarting(true);
    try {
      if (dirty && !(await onSave())) return;
      onStart(await post<Job>(`/projects/${project.id}/flutter/build`));
      setLogs([]);
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setStarting(false);
    }
  }
  const source = status.url
    ? `${serverUrl()}${status.url}?v=${encodeURIComponent(`${status.builtAt}-${reload}`)}`
    : "";
  const tail = (job?.output ?? "").trim().split("\n").slice(-12).join("\n");
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
          <span className="flutter-mark" aria-hidden="true">
            ◆
          </span>
          {status.builtAt
            ? `Flutter · compilado ${relativeDate(status.builtAt).toLowerCase()}`
            : "Flutter · sin compilar"}
        </span>
        {status.url && !building && (
          <button
            className="icon-button"
            aria-label="Reiniciar la app"
            title="Reiniciar la app"
            onClick={() => setReload((value) => value + 1)}
          >
            <RotateCcw size={16} />
          </button>
        )}
        <button
          className="button small primary"
          disabled={building || starting || !status.sdk}
          onClick={() => void build()}
        >
          {building || starting ? <Spinner /> : <Hammer size={15} />}
          {status.url ? "Recompilar" : "Compilar"}
        </button>
      </div>
      {dirty && (
        <div className="preview-unsaved">
          <CircleAlert size={16} />
          <span>Tienes cambios sin guardar. Recompilar los guardará.</span>
        </div>
      )}
      <div className={`preview-stage ${device}`}>
        {!status.sdk ? (
          <Empty
            icon={<Hammer size={28} />}
            title="Flutter no está instalado en el servidor"
            action={
              <a
                className="button secondary"
                href="https://docs.flutter.dev/get-started/install"
                target="_blank"
                rel="noreferrer"
              >
                Cómo instalar Flutter
              </a>
            }
          >
            Instala el SDK de Flutter en el ordenador que ejecuta AppBuilder,
            añádelo al PATH y reinicia el servidor para ver aquí tus apps.
          </Empty>
        ) : building ? (
          <div className="flutter-building">
            <div className="import-progress-head">
              <Spinner />
              <div>
                <strong>Compilando {project.name} para la web…</strong>
                <small>
                  La primera vez tarda uno o dos minutos; después es más rápido.
                  Puedes seguir trabajando mientras tanto.
                </small>
              </div>
            </div>
            <pre className="import-log">{tail || "Preparando Flutter…"}</pre>
          </div>
        ) : failed ? (
          <div className="flutter-building">
            <div className="import-progress-head failed">
              <CircleAlert size={20} />
              <div>
                <strong>La compilación falló</strong>
                <small>
                  Corrige los errores (o pídeselo al agente) y vuelve a
                  compilar.
                </small>
              </div>
            </div>
            <pre className="import-log">{tail}</pre>
          </div>
        ) : !source ? (
          <Empty
            icon={<Smartphone size={28} />}
            title="Mira tu app de Flutter aquí"
            action={
              <button
                className="button primary"
                disabled={starting}
                onClick={() => void build()}
              >
                {starting ? <Spinner /> : <Hammer size={16} />} Compilar vista
                previa
              </button>
            }
          >
            AppBuilder compila la app para la web en tu servidor y la muestra en
            formato móvil.
            {status.needsWeb &&
              " Como el proyecto aún no tiene soporte web, se añadirá la carpeta web/."}
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
            <iframe
              key={source}
              ref={frame}
              title="Vista previa del proyecto"
              sandbox="allow-scripts allow-forms allow-popups allow-pointer-lock"
              src={source}
            />
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
            <p>Los mensajes de tu app (print y errores) aparecerán aquí.</p>
          )}
        </section>
      </div>
      <div className="preview-note">
        <Monitor size={14} />
        Vista previa web de Flutter · Los plugins nativos (cámara, Bluetooth,
        notificaciones…) solo funcionan en una build de dispositivo.
      </div>
    </div>
  );
}

function WebPreview({
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
  syncJobs,
  onStart,
  onRestored,
  canRestore,
  beforeCommit,
}: {
  project: Project;
  revision: number;
  notify: ToastFn;
  onStatus: (state: GitState) => void;
  syncJobs: Job[];
  onStart: (job: Job) => void;
  onRestored: () => void;
  canRestore: boolean;
  beforeCommit: () => Promise<boolean>;
}) {
  const [git, setGit] = useState<GitState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState("");
  const [selected, setSelected] = useState("");
  const [checking, setChecking] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [pushAfterCommit, setPushAfterCommit] = useState(() => {
    try {
      return localStorage.getItem(PUSH_AFTER_COMMIT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const checked = useRef(false);
  const lastSync = useRef<{ id: string; status: Job["status"] } | null>(null);
  const remote = git?.remote;
  const syncJob = syncJobs[0];
  const syncing = syncJob?.status === "running";
  const remoteName = /github\.com/i.test(remote?.url ?? "")
    ? "GitHub"
    : "el remoto";
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
  const checkRemote = useCallback(
    async (quiet: boolean) => {
      setChecking(true);
      try {
        const state = await post<GitState>(`/projects/${project.id}/git/fetch`);
        setGit(state);
        onStatus(state);
        setRemoteError("");
      } catch (e) {
        setRemoteError(errorMessage(e));
        if (!quiet) notify(errorMessage(e), "error");
      } finally {
        setChecking(false);
      }
    },
    [project.id, notify, onStatus],
  );
  useEffect(() => {
    // Look for new remote commits once when the panel opens.
    if (!remote || checked.current) return;
    checked.current = true;
    void checkRemote(true);
  }, [remote, checkRemote]);
  useEffect(() => {
    if (!syncJob) return;
    const previous = lastSync.current;
    lastSync.current = { id: syncJob.id, status: syncJob.status };
    if (
      previous?.id !== syncJob.id ||
      previous.status !== "running" ||
      syncJob.status === "running"
    )
      return;
    const summary = lastOutputLine(syncJob.output);
    if (syncJob.status === "succeeded")
      notify(summary || "Sincronización completada.");
    else if (syncJob.status === "failed")
      notify(summary || "No se pudo sincronizar.", "error");
  }, [syncJob, notify]);
  async function sync(action: "pull" | "push") {
    try {
      onStart(await post<Job>(`/projects/${project.id}/git/${action}`));
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }
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
      if (pushAfterCommit && remote) {
        notify(`Commit guardado. Subiendo a ${remoteName}…`);
        await sync("push");
      } else notify("Cambios guardados en Git.");
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
        {remote ? (
          <section className="git-sync" aria-label="Sincronización">
            <div className="git-sync-head">
              <FolderGit2 size={18} />
              <div>
                {remote.webUrl ? (
                  <a href={remote.webUrl} target="_blank" rel="noreferrer">
                    {remote.label}
                  </a>
                ) : (
                  <strong>{remote.label}</strong>
                )}
                <small>
                  Rama <code>{git?.branch}</code>
                  {!remote.upstream && " · aún no está en el remoto"}
                </small>
              </div>
              <button
                className="icon-button"
                aria-label={`Comprobar ${remoteName}`}
                title={`Buscar cambios nuevos en ${remoteName}`}
                disabled={checking || syncing}
                onClick={() => void checkRemote(false)}
              >
                {checking ? <Spinner /> : <RefreshCw size={15} />}
              </button>
            </div>
            <div className="git-sync-counts">
              <span
                className={remote.ahead ? "pending" : ""}
                title={`Commits de esta copia que aún no están en ${remoteName}`}
              >
                <CloudUpload size={15} />
                {remote.ahead} por subir
              </span>
              <span
                className={remote.behind ? "pending" : ""}
                title={`Commits de ${remoteName} que aún no tienes`}
              >
                <CloudDownload size={15} />
                {remote.behind} por traer
              </span>
            </div>
            <div className="git-sync-actions">
              <button
                className={`button small ${remote.behind ? "primary" : "secondary"}`}
                disabled={syncing || busy}
                onClick={() => void sync("pull")}
              >
                <CloudDownload size={15} /> Traer cambios
              </button>
              <button
                className={`button small ${remote.ahead || !remote.upstream ? "primary" : "secondary"}`}
                disabled={syncing || busy}
                onClick={() => void sync("push")}
              >
                <CloudUpload size={15} /> Subir a {remoteName}
              </button>
            </div>
            {syncing && (
              <p className="git-sync-status">
                <Spinner /> {syncJob.title}…
              </p>
            )}
            {!syncing && syncJob?.status === "failed" && (
              <details className="git-sync-log">
                <summary>La última sincronización falló · ver detalles</summary>
                <pre>
                  {syncJob.output.trim().split("\n").slice(-14).join("\n")}
                </pre>
              </details>
            )}
            {remoteError && !syncing && (
              <p className="git-sync-warning">{remoteError}</p>
            )}
          </section>
        ) : (
          git && (
            <div className="git-sync empty">
              <Info size={16} />
              <p>
                Este proyecto solo está en tu servidor. Para sincronizarlo con
                GitHub, impórtalo desde allí o añade un remoto en la terminal
                con <code>git remote add origin URL</code>.
              </p>
            </div>
          )
        )}
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
          {remote && (
            <label className="checkbox-row compact">
              <input
                type="checkbox"
                checked={pushAfterCommit}
                onChange={(e) => {
                  setPushAfterCommit(e.target.checked);
                  try {
                    localStorage.setItem(
                      PUSH_AFTER_COMMIT_KEY,
                      e.target.checked ? "1" : "0",
                    );
                  } catch {
                    /* The preference is optional. */
                  }
                }}
              />
              <span>Subir a {remoteName} al guardar el commit</span>
            </label>
          )}
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
