import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  Cpu,
  Folder,
  GitBranch,
  Layers3,
  LayoutGrid,
  Menu,
  MonitorSmartphone,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Unplug,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { api, errorMessage, isNative, post, serverUrl, setServer } from "./api";
import type { Connection, Project, ToastFn } from "./types";
import {
  Empty,
  Logo,
  Modal,
  ProjectIcon,
  relativeDate,
  Spinner,
  StatusDot,
  Tag,
} from "./ui";
const Workspace = lazy(() =>
  import("./Workspace").then((module) => ({ default: module.Workspace })),
);
import { Connections } from "./Connections";
import { Builds } from "./Builds";

type Page = "studio" | "projects" | "builds" | "connections";
const pages = [
  { id: "studio", label: "Mi estudio", icon: LayoutGrid },
  { id: "projects", label: "Proyectos", icon: Folder },
  { id: "builds", label: "Builds", icon: Layers3 },
  { id: "connections", label: "Conexiones", icon: Unplug },
] as const;

export function App() {
  const [session, setSession] = useState<
    "loading" | "ready" | "login" | "offline"
  >("loading");
  const [page, setPage] = useState<Page>("studio");
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [newProject, setNewProject] = useState(false);
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    kind: "success" | "error";
  } | null>(null);
  const [initialPrompt, setInitialPrompt] = useState("");
  const navigationGuard = useRef<(() => Promise<boolean>) | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const [leaving, setLeaving] = useState(false);
  const registerGuard = useCallback((save: (() => Promise<boolean>) | null) => {
    navigationGuard.current = save;
  }, []);
  const notify: ToastFn = useCallback(
    (message, kind = "success") => setToast({ message, kind }),
    [],
  );
  const refresh = useCallback(async () => {
    const [p, c] = await Promise.all([
      api<Project[]>("/projects"),
      api<Connection[]>("/connections"),
    ]);
    setProjects(p);
    setConnections(c);
  }, []);
  const connect = useCallback(async () => {
    setSession("loading");
    if (isNative && !serverUrl()) {
      setSession("login");
      return;
    }
    try {
      const data = await api<{ authenticated: boolean }>("/session");
      if (!data.authenticated) {
        setSession("login");
        return;
      }
      await refresh();
      setSession("ready");
    } catch {
      setSession("offline");
    }
  }, [refresh]);
  useEffect(() => {
    void connect();
  }, [connect]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearch((value) => !value);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  function guardedNavigate(action: () => void) {
    if (navigationGuard.current) setPendingNavigation(() => action);
    else action();
  }
  function navigate(next: Page) {
    guardedNavigate(() => {
      setPage(next);
      setProject(null);
      setMenu(false);
      void refresh().catch((e) => notify(errorMessage(e), "error"));
    });
  }
  function openProject(next: Project) {
    if (next.id === project?.id) {
      setMenu(false);
      setSearch(false);
      return;
    }
    guardedNavigate(() => {
      setProject(next);
      setMenu(false);
      setSearch(false);
    });
  }
  async function created(next: Project) {
    setNewProject(false);
    await refresh();
    openProject(next);
    notify("Proyecto creado. Tu espacio está listo.");
  }
  if (session === "loading")
    return (
      <div className="boot-screen">
        <Logo />
        <Spinner />
        <p>Preparando tu estudio…</p>
      </div>
    );
  if (session !== "ready")
    return <ConnectScreen offline={session === "offline"} retry={connect} />;

  return (
    <div className={`app-shell ${project ? "has-workspace" : ""}`}>
      {menu && (
        <button
          className="sidebar-scrim"
          onClick={() => setMenu(false)}
          aria-label="Cerrar menú"
        />
      )}
      <aside className={`sidebar ${menu ? "is-open" : ""}`}>
        <button className="brand" onClick={() => navigate("studio")}>
          <Logo />
          <span>
            appbuilder<span className="brand-period">.</span>
          </span>
        </button>
        <button className="space-switcher" onClick={() => setHelp(true)}>
          <span className="space-avatar">J</span>
          <span>
            <strong>Mi espacio</strong>
            <small>Personal</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {pages.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id && !project ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "projects" && (
                <span className="nav-count">{projects.length}</span>
              )}
              {item.id === "connections" &&
                connections.some((c) => c.status === "connected") && (
                  <StatusDot active />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-project-heading">
          <span className="nav-caption">TUS PROYECTOS</span>
          <button
            aria-label="Crear proyecto"
            onClick={() => {
              setInitialPrompt("");
              setNewProject(true);
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="sidebar-projects">
          {projects.slice(0, 5).map((p) => (
            <button
              key={p.id}
              className={p.id === project?.id ? "selected" : ""}
              onClick={() => openProject(p)}
            >
              <span className={`mini-project-dot ${p.template}`} />
              {p.name}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="environment-card">
            <div>
              <span className="pulse-dot" />
              Entorno conectado
            </div>
            <p>Todo preparado para crear.</p>
            <span>
              Servidor personal <ArrowUpRight size={12} />
            </span>
          </div>
          <button className="sidebar-help" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
            Guía de inicio
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <span className="profile-avatar">J</span>
            <div>
              <strong>Tu estudio personal</strong>
              <small>AppBuilder · v0.1.2</small>
            </div>
            <ShieldCheck size={17} />
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir menú"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb-root">Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {project?.name ?? pages.find((p) => p.id === page)?.label}
            </strong>
            {project && (
              <Tag tone="green">
                {project.template === "react" ? "React" : "Web"}
              </Tag>
            )}
          </div>
          <div className="topbar-actions">
            <button className="search-trigger" onClick={() => setSearch(true)}>
              <Search size={16} />
              <span>Buscar proyecto</span>
              <kbd>Ctrl K</kbd>
            </button>
            <span className="topbar-separator" />
            <button
              className="icon-button"
              aria-label="Actividad y ayuda"
              onClick={() => setHelp(true)}
            >
              <Bell size={18} />
            </button>
            <span className="topbar-avatar">J</span>
          </div>
        </header>
        {project ? (
          <Suspense
            fallback={
              <div className="workspace-loading">
                <Spinner />
                <span>Abriendo tu proyecto…</span>
              </div>
            }
          >
            <Workspace
              key={project.id}
              project={project}
              connections={connections}
              notify={notify}
              onConnections={() => navigate("connections")}
              onBack={() => navigate("projects")}
              initialPrompt={initialPrompt}
              onChange={() => {
                void refresh().catch(() => {});
              }}
              registerGuard={registerGuard}
            />
          </Suspense>
        ) : page === "connections" ? (
          <Connections
            connections={connections}
            refresh={refresh}
            notify={notify}
          />
        ) : page === "builds" ? (
          <Builds
            connections={connections}
            projects={projects}
            notify={notify}
            onConnections={() => navigate("connections")}
          />
        ) : (
          <Dashboard
            projects={projects}
            connections={connections}
            allProjects={page === "projects"}
            onOpen={openProject}
            onNew={(prompt = "") => {
              setInitialPrompt(prompt);
              setNewProject(true);
            }}
            onConnections={() => navigate("connections")}
            onBuilds={() => navigate("builds")}
          />
        )}
        {!project && (
          <footer className="page-footer">
            <span>
              <StatusDot active /> Tu espacio, tus ideas, tu código.
            </span>
            <span>
              Hecho para construir <span className="footer-star">✳</span>
            </span>
          </footer>
        )}
      </div>
      {!project && (
        <nav className="mobile-nav">
          {pages.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}
      {newProject && (
        <NewProjectModal
          initialPrompt={initialPrompt}
          onClose={() => setNewProject(false)}
          onCreated={created}
        />
      )}
      {search && (
        <SearchModal
          projects={projects}
          onClose={() => setSearch(false)}
          onOpen={openProject}
        />
      )}
      {pendingNavigation && (
        <Modal
          title="Conserva tus últimos cambios"
          subtitle="Hay un archivo editado que todavía no se ha guardado."
          onClose={() => setPendingNavigation(null)}
        >
          <div className="form-footer">
            <button
              className="button light"
              disabled={leaving}
              onClick={() => {
                navigationGuard.current = null;
                pendingNavigation();
                setPendingNavigation(null);
              }}
            >
              Salir sin guardar
            </button>
            <button
              className="button dark"
              disabled={leaving}
              onClick={async () => {
                setLeaving(true);
                try {
                  if (
                    !navigationGuard.current ||
                    (await navigationGuard.current())
                  ) {
                    navigationGuard.current = null;
                    pendingNavigation();
                    setPendingNavigation(null);
                  }
                } finally {
                  setLeaving(false);
                }
              }}
            >
              {leaving ? <Spinner /> : <Check size={15} />}Guardar y continuar
            </button>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          title="Un estudio que va contigo"
          subtitle="De la primera línea a tu próxima build."
          onClose={() => setHelp(false)}
        >
          <div className="guide-steps">
            {[
              {
                icon: Folder,
                title: "Empieza con un proyecto",
                text: "Abre Orbit Notes o crea una app Web o React. Tus archivos se guardan en el servidor.",
              },
              {
                icon: Sparkles,
                title: "Conecta a tu compañero de código",
                text: "Añade tu clave API de Codex o Claude en Conexiones. El agente trabajará sobre los archivos del proyecto.",
              },
              {
                icon: Terminal,
                title: "Edita, ejecuta y comprueba",
                text: "Guarda el código, usa la terminal y abre la vista previa web. Git te permite registrar cada avance.",
              },
              {
                icon: Layers3,
                title: "Lleva tu app al siguiente paso",
                text: "Conecta Codemagic para iniciar builds de repositorios ya configurados. Apple y Google permiten consultar tus apps y canales.",
              },
            ].map((s, i) => (
              <div key={s.title}>
                <span>{i + 1}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
                <s.icon size={19} />
              </div>
            ))}
          </div>
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              Esta versión es un entorno personal. La terminal se ejecuta en el
              equipo servidor con sus permisos. Para un servicio compartido
              hacen falta entornos aislados por usuario.
            </p>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="status" className={`toast ${toast.kind}`}>
          {toast.kind === "success" ? (
            <Check size={18} />
          ) : (
            <CircleHelp size={18} />
          )}
          <span>{toast.message}</span>
          <button aria-label="Cerrar aviso" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function Dashboard({
  projects,
  connections,
  allProjects,
  onOpen,
  onNew,
  onConnections,
  onBuilds,
}: {
  projects: Project[];
  connections: Connection[];
  allProjects: boolean;
  onOpen: (project: Project) => void;
  onNew: (prompt?: string) => void;
  onConnections: () => void;
  onBuilds: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const connected = connections.filter((c) => c.status === "connected").length;
  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main className="dashboard">
      {!allProjects ? (
        <>
          <div className="welcome-eyebrow">
            <span /> TU ESTUDIO DE DESARROLLO <span className="eyebrow-line" />
          </div>
          <div className="welcome-heading">
            <div>
              <h1>
                Las grandes ideas
                <br />
                empiezan <span>aquí.</span>
                <span className="heading-spark">✳</span>
              </h1>
              <p>Tu código, tus agentes y tu próxima app. En un mismo lugar.</p>
            </div>
            <div className="welcome-stamp">
              <div className="stamp-top">
                <span />
                <span />
                <span />
              </div>
              <div>
                <Code2Art />
              </div>
              <small>MAKE SOMETHING GREAT</small>
            </div>
          </div>
          <form
            className="idea-composer"
            onSubmit={(e) => {
              e.preventDefault();
              onNew(prompt);
            }}
          >
            <div className="idea-input">
              <Sparkles size={22} />
              <textarea
                rows={2}
                aria-label="Describe tu próxima app"
                placeholder="¿Qué vamos a construir hoy?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div className="idea-composer-bottom">
              <span>
                <span className="tiny-spark">✧</span> De una idea a tu primer
                proyecto
              </span>
              <button className="button dark" type="submit">
                Empezar a crear <ArrowRight size={16} />
              </button>
            </div>
          </form>
          <div className="starter-chips">
            <span>Un punto de partida</span>
            <button
              onClick={() =>
                onNew(
                  "Crear una app para organizar mis tareas con listas, etiquetas y prioridades.",
                )
              }
            >
              <Check size={13} /> App de tareas
            </button>
            <button
              onClick={() =>
                onNew(
                  "Crear un portfolio personal con proyectos, presentación y contacto.",
                )
              }
            >
              <MonitorSmartphone size={13} /> Portfolio
            </button>
            <button
              onClick={() =>
                onNew("Crear un panel de métricas con gráficos y filtros.")
              }
            >
              <Workflow size={13} /> Dashboard
            </button>
          </div>
          <div className="overview-grid">
            <div className="overview-card">
              <span className="metric-icon mint">
                <Folder size={18} />
              </span>
              <div>
                <span>Proyectos</span>
                <strong>
                  {projects.length.toString().padStart(2, "0")}
                  <small>en tu espacio</small>
                </strong>
              </div>
              <ArrowUpRight size={17} />
            </div>
            <button className="overview-card" onClick={onConnections}>
              <span className="metric-icon lilac">
                <Cpu size={18} />
              </span>
              <div>
                <span>Conexiones</span>
                <strong>
                  {connected.toString().padStart(2, "0")}
                  <small>
                    {connected
                      ? "listas para trabajar"
                      : "conecta tus herramientas"}
                  </small>
                </strong>
              </div>
              <ArrowUpRight size={17} />
            </button>
            <button className="overview-card" onClick={onBuilds}>
              <span className="metric-icon peach">
                <Layers3 size={18} />
              </span>
              <div>
                <span>Tu siguiente build</span>
                <strong className="metric-text">
                  Todo empieza aquí<small>Prepara tu lanzamiento</small>
                </strong>
              </div>
              <ArrowUpRight size={17} />
            </button>
          </div>
        </>
      ) : (
        <div className="section-page-heading">
          <div>
            <div className="welcome-eyebrow">
              <Folder size={14} /> TU CÓDIGO, ORGANIZADO
            </div>
            <h1>
              Proyectos<span className="accent-period">.</span>
            </h1>
            <p>Un espacio para cada idea. Retoma donde lo dejaste.</p>
          </div>
          <button className="button dark" onClick={() => onNew()}>
            <Plus size={16} /> Nuevo proyecto
          </button>
        </div>
      )}
      <section className="projects-section">
        <div className="section-heading">
          <div>
            <h2>
              {allProjects
                ? "Todos tus proyectos"
                : "Continúa donde lo dejaste"}
              <span className="count-pill">{projects.length}</span>
            </h2>
            {!allProjects && <p>Un pequeño paso hoy. Una gran app mañana.</p>}
          </div>
          {allProjects ? (
            <label className="search-input">
              <Search size={16} />
              <input
                aria-label="Filtrar proyectos"
                placeholder="Buscar proyecto…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          ) : (
            <button className="button text" onClick={() => onNew()}>
              <Plus size={16} />
              Nuevo proyecto
            </button>
          )}
        </div>
        <div className="project-grid">
          {filtered.map((p, index) => (
            <button
              className="project-card"
              key={p.id}
              onClick={() => onOpen(p)}
            >
              <div className="project-card-top">
                <ProjectIcon template={p.template} large />
                <span className="project-menu">
                  <ArrowUpRight size={18} />
                </span>
              </div>
              <h3>{p.name}</h3>
              <p>{p.description || "Una nueva idea en construcción."}</p>
              <div className={`project-art art-${index % 3}`}>
                <div className="art-window">
                  <div className="art-title">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="art-content">
                    <div className="art-nav" />
                    <div className="art-main">
                      <span />
                      <span />
                      <div>
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                  </div>
                </div>
                <span className="art-badge">
                  {p.template === "react" ? "React + Vite" : "HTML · CSS · JS"}
                </span>
              </div>
              <div className="project-card-bottom">
                <span>
                  <GitBranch size={13} />
                  Git
                </span>
                <span>{relativeDate(p.updatedAt)}</span>
              </div>
            </button>
          ))}
          <button className="new-project-card" onClick={() => onNew()}>
            <span>
              <Plus size={24} />
            </span>
            <h3>Tu próxima gran idea</h3>
            <p>
              Un lienzo en blanco.
              <br />
              Todas las posibilidades.
            </p>
            <strong>
              Crear proyecto <ArrowRight size={15} />
            </strong>
          </button>
        </div>
        {allProjects && filtered.length === 0 && query && (
          <p className="muted">No hay proyectos que coincidan con «{query}».</p>
        )}
      </section>
      {!allProjects && (
        <div className="connect-banner">
          <div className="connect-illustration">
            <span>
              <Command size={23} />
            </span>
            <span>
              <Sparkles size={23} />
            </span>
            <span>
              <Workflow size={23} />
            </span>
          </div>
          <div>
            <span className="mini-eyebrow">MEJOR, CON TUS HERRAMIENTAS</span>
            <h3>Un buen equipo hace la diferencia.</h3>
            <p>Conecta Codex, Claude y Codemagic a tu forma de trabajar.</p>
          </div>
          <button className="button light" onClick={onConnections}>
            Explorar conexiones <ArrowUpRight size={16} />
          </button>
        </div>
      )}
    </main>
  );
}
function Code2Art() {
  return (
    <div className="code-art">
      <span>&lt;</span>
      <span>/</span>
      <span>&gt;</span>
    </div>
  );
}

function NewProjectModal({
  initialPrompt,
  onClose,
  onCreated,
}: {
  initialPrompt: string;
  onClose: () => void;
  onCreated: (project: Project) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState(initialPrompt);
  const [template, setTemplate] = useState<"web" | "react">("web");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onCreated(
        await post<Project>("/projects", {
          name: name.trim(),
          description,
          template,
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Dale espacio a tu idea"
      subtitle="Elige un punto de partida. Hazlo tuyo."
      onClose={onClose}
    >
      <form onSubmit={submit} className="stack-form">
        <label>
          Nombre del proyecto
          <input
            autoComplete="off"
            maxLength={80}
            required
            placeholder="Mi próxima app"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          ¿Qué quieres construir?
          <textarea
            rows={3}
            placeholder="Una breve descripción de tu idea…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>Punto de partida</label>
        <div className="template-options">
          {(["web", "react"] as const).map((t) => (
            <button
              type="button"
              className={`template-option ${template === t ? "selected" : ""}`}
              key={t}
              onClick={() => setTemplate(t)}
            >
              <ProjectIcon template={t} />
              <strong>{t === "web" ? "Web esencial" : "React + Vite"}</strong>
              <small>
                {t === "web"
                  ? "HTML, CSS y JavaScript"
                  : "Componentes, JSX y estilos"}
              </small>
              {template === t && (
                <span className="template-check">
                  <Check size={13} />
                </span>
              )}
            </button>
          ))}
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-footer">
          <span>
            <ShieldCheck size={14} /> Tu código permanece en tu servidor.
          </span>
          <button className="button dark" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <Plus size={16} />} Crear proyecto
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SearchModal({
  projects,
  onClose,
  onOpen,
}: {
  projects: Project[];
  onClose: () => void;
  onOpen: (project: Project) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <Modal title="Salta a un proyecto" onClose={onClose}>
      <label className="search-input large">
        <Search size={18} />
        <input
          placeholder="Escribe para buscar…"
          aria-label="Buscar proyecto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="project-search-results">
        {projects
          .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
          .map((p) => (
            <button onClick={() => onOpen(p)} key={p.id}>
              <ProjectIcon template={p.template} />
              <div>
                <strong>{p.name}</strong>
                <small>{p.description}</small>
              </div>
              <ArrowRight size={17} />
            </button>
          ))}
      </div>
    </Modal>
  );
}
function ConnectScreen({
  offline,
  retry,
}: {
  offline: boolean;
  retry: () => Promise<void>;
}) {
  const [url, setUrl] = useState(serverUrl());
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (isNative) setServer(url, token);
      await post("/session", { token });
      await retry();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="connect-screen">
      <div className="connect-screen-card">
        <Logo />
        <span className="welcome-eyebrow">APPBUILDER STUDIO</span>
        <h1>
          Tu estudio.
          <br />
          Donde tú estés.
        </h1>
        <p>
          {offline
            ? "No podemos conectar con tu servidor. Comprueba que esté encendido e inténtalo de nuevo."
            : "Conecta tu servidor personal para acceder a tus proyectos, agentes y terminal."}
        </p>
        <form onSubmit={submit} className="stack-form">
          {isNative && (
            <label>
              Dirección del servidor
              <input
                type="url"
                required
                placeholder="https://studio.ejemplo.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
          )}
          {(!offline || isNative) && (
            <label>
              Clave de acceso
              <input
                type="password"
                required
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {offline && !isNative ? (
            <button
              type="button"
              className="button dark"
              onClick={() => void retry()}
            >
              Volver a conectar <ArrowRight size={16} />
            </button>
          ) : (
            <button className="button dark" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  Entrar en mi estudio <ArrowRight size={16} />
                </>
              )}
            </button>
          )}
        </form>
        <small>
          <ShieldCheck size={14} /> Conexión privada con tu entorno de
          desarrollo.
        </small>
      </div>
      <div className="connect-screen-art">
        <Code2Art />
        <span>IDEAS IN. APPS OUT.</span>
      </div>
    </main>
  );
}
