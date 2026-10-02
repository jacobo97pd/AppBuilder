import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock3,
  Folder,
  Layers3,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  Menu,
  MonitorSmartphone,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { APP_VERSION } from "../version";
import { api, errorMessage, isNative, post, serverUrl, setServer } from "./api";
import type { Connection, Project, ToastFn } from "./types";
import {
  isTouchInput,
  Logo,
  Modal,
  ProjectIcon,
  relativeDate,
  Spinner,
  StatusDot,
  Tag,
  useMediaQuery,
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
  { id: "connections", label: "Conexiones", icon: Plug },
] as const;
const starters = [
  {
    label: "App de tareas",
    name: "Mis tareas",
    icon: ListChecks,
    prompt:
      "Crear una app para organizar mis tareas con listas, etiquetas y prioridades.",
  },
  {
    label: "Portfolio",
    name: "Mi portfolio",
    icon: MonitorSmartphone,
    prompt:
      "Crear un portfolio personal con proyectos, presentación y contacto.",
  },
  {
    label: "Dashboard",
    name: "Panel de métricas",
    icon: LayoutDashboard,
    prompt: "Crear un panel de métricas con gráficos y filtros.",
  },
];
const RECENT_PROJECTS = 5;
const agentNames: Record<string, string> = { codex: "Codex", claude: "Claude" };

export function App() {
  const [session, setSession] = useState<
    "loading" | "ready" | "login" | "offline"
  >("loading");
  const [page, setPage] = useState<Page>("studio");
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [newProject, setNewProject] = useState<{
    prompt: string;
    name: string;
  } | null>(null);
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
  // The sidebar shrinks to icons on tablets, and on laptops while a project
  // is open so the editor gets the extra width.
  const tablet = useMediaQuery("(min-width: 701px) and (max-width: 1099px)");
  const laptop = useMediaQuery("(min-width: 1100px) and (max-width: 1439px)");
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
      if (e.key === "Escape") setMenu(false);
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
  function openProject(next: Project, prompt = "") {
    if (next.id === project?.id) {
      setMenu(false);
      setSearch(false);
      return;
    }
    guardedNavigate(() => {
      setInitialPrompt(prompt);
      setProject(next);
      setMenu(false);
      setSearch(false);
    });
  }
  function startProject(prompt = "", name = "") {
    setMenu(false);
    setNewProject({ prompt, name });
  }
  async function created(next: Project, prompt: string) {
    setNewProject(null);
    await refresh();
    openProject(next, prompt);
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

  const readyConnections = connections.filter(
    (c) => c.status === "connected",
  ).length;
  const rail = tablet || (laptop && project !== null);
  return (
    <div
      className={`app-shell ${project ? "has-workspace" : ""} ${rail ? "rail" : ""}`}
    >
      {menu && (
        <button
          className="sidebar-scrim"
          onClick={() => setMenu(false)}
          aria-label="Cerrar menú"
        />
      )}
      <aside className={`sidebar ${menu ? "is-open" : ""}`}>
        <button
          className="brand"
          onClick={() => navigate("studio")}
          title="Mi estudio"
        >
          <Logo />
          <span className="brand-name">
            appbuilder<span className="brand-period">.</span>
          </span>
        </button>
        <button
          className="sidebar-create"
          onClick={() => startProject()}
          title="Nuevo proyecto"
        >
          <Plus size={18} strokeWidth={2.2} />
          <span>Nuevo proyecto</span>
        </button>
        <nav className="sidebar-nav" aria-label="Principal">
          {pages.map((item) => {
            const active = page === item.id && !project;
            return (
              <button
                key={item.id}
                className={`nav-item ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
                title={item.label}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={19} />
                <span className="nav-label">{item.label}</span>
                {item.id === "projects" && (
                  <span className="nav-count">{projects.length}</span>
                )}
                {item.id === "connections" && readyConnections > 0 && (
                  <StatusDot active />
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-section-heading">
            <span className="nav-caption">Recientes</span>
            {projects.length > RECENT_PROJECTS && (
              <button onClick={() => navigate("projects")}>Ver todos</button>
            )}
          </div>
          <div className="sidebar-projects">
            {projects.slice(0, RECENT_PROJECTS).map((p) => (
              <button
                key={p.id}
                className={p.id === project?.id ? "selected" : ""}
                title={p.name}
                onClick={() => openProject(p)}
              >
                <span className={`mini-project-dot ${p.template}`} />
                <span>{p.name}</span>
              </button>
            ))}
            {!projects.length && (
              <p className="sidebar-empty">Aún no tienes proyectos.</p>
            )}
          </div>
        </div>
        <div className="sidebar-bottom">
          <button
            className="sidebar-status"
            title="Conexiones"
            onClick={() => navigate("connections")}
          >
            <span className="pulse-dot" />
            <span className="sidebar-status-text">
              <strong>Servidor conectado</strong>
              <small>
                {readyConnections} de {connections.length} conexiones listas
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
          <button
            className="sidebar-help"
            title="Guía de inicio"
            onClick={() => {
              setMenu(false);
              setHelp(true);
            }}
          >
            <CircleHelp size={18} />
            <span>Guía de inicio</span>
          </button>
          <div className="sidebar-version">AppBuilder v{APP_VERSION}</div>
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
              <Menu size={22} />
            </button>
            {project ? (
              <>
                <button
                  className="breadcrumb-root"
                  onClick={() => navigate("projects")}
                >
                  Proyectos
                </button>
                <ChevronRight size={15} className="breadcrumb-separator" />
                <strong>{project.name}</strong>
                <Tag tone={project.template === "react" ? "info" : "accent"}>
                  {project.template === "react" ? "React" : "Web"}
                </Tag>
              </>
            ) : (
              <strong>{pages.find((p) => p.id === page)?.label}</strong>
            )}
          </div>
          <div className="topbar-actions">
            <button
              className="search-trigger"
              aria-label="Buscar proyecto"
              onClick={() => setSearch(true)}
            >
              <Search size={17} />
              <span>Buscar proyecto…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              className="icon-button topbar-help"
              aria-label="Ayuda"
              title="Guía de inicio"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={20} />
            </button>
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
            onOpen={(p) => openProject(p)}
            onNew={startProject}
            onConnections={() => navigate("connections")}
            onBuilds={() => navigate("builds")}
            onProjects={() => navigate("projects")}
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
        <nav className="mobile-nav" aria-label="Principal">
          {pages.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={21} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}
      {newProject && (
        <NewProjectModal
          initialPrompt={newProject.prompt}
          initialName={newProject.name}
          onClose={() => setNewProject(null)}
          onCreated={(next, description) =>
            created(next, newProject.prompt ? description.trim() : "")
          }
        />
      )}
      {search && (
        <SearchModal
          projects={projects}
          onClose={() => setSearch(false)}
          onOpen={(p) => openProject(p)}
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
              className="button secondary"
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
              className="button primary"
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
              {leaving ? <Spinner /> : <Check size={16} />}Guardar y continuar
            </button>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          title="Un estudio que va contigo"
          subtitle="De la primera línea a tu próxima build, en cuatro pasos."
          onClose={() => setHelp(false)}
        >
          <ol className="guide-steps">
            {[
              {
                icon: Folder,
                title: "Empieza con un proyecto",
                text: "Abre Orbit Notes o crea una app Web o React. Tus archivos se guardan en tu servidor.",
                action: "Crear proyecto",
                run: () => startProject(),
              },
              {
                icon: Sparkles,
                title: "Conecta tu agente de IA",
                text: "Usa tu cuenta ChatGPT con Codex o Claude Code iniciado en este ordenador. También puedes añadir una API key.",
                action: "Ir a Conexiones",
                run: () => navigate("connections"),
              },
              {
                icon: Terminal,
                title: "Edita, prueba y guarda",
                text: "Edita el código, mira la vista previa y usa la terminal. En Cambios guardas cada avance con Git.",
              },
              {
                icon: Layers3,
                title: "Compila tu app",
                text: "Conecta Codemagic para lanzar builds de tu repositorio. Con Apple y Google consultas tus apps y canales.",
                action: "Ver builds",
                run: () => navigate("builds"),
              },
            ].map((s, i) => (
              <li key={s.title}>
                <span className="guide-number">{i + 1}</span>
                <div>
                  <h3>
                    <s.icon size={17} />
                    {s.title}
                  </h3>
                  <p>{s.text}</p>
                  {s.action && (
                    <button
                      className="button ghost small"
                      onClick={() => {
                        setHelp(false);
                        s.run();
                      }}
                    >
                      {s.action}
                      <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="shortcuts">
            <h3>Atajos de teclado</h3>
            <dl>
              <div>
                <dt>
                  <kbd>Ctrl</kbd> <kbd>K</kbd>
                </dt>
                <dd>Buscar un proyecto</dd>
              </div>
              <div>
                <dt>
                  <kbd>Ctrl</kbd> <kbd>S</kbd>
                </dt>
                <dd>Guardar el archivo</dd>
              </div>
              <div>
                <dt>
                  <kbd>Enter</kbd>
                </dt>
                <dd>Enviar un mensaje al agente</dd>
              </div>
            </dl>
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
            <CircleCheck size={19} />
          ) : (
            <CircleAlert size={19} />
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
  onProjects,
}: {
  projects: Project[];
  connections: Connection[];
  allProjects: boolean;
  onOpen: (project: Project) => void;
  onNew: (prompt?: string, name?: string) => void;
  onConnections: () => void;
  onBuilds: () => void;
  onProjects: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );
  const visible = allProjects ? filtered : projects;
  const agents = connections
    .filter((c) => c.id in agentNames && c.status === "connected")
    .map((c) => agentNames[c.id]);
  const buildsReady = connections.some(
    (c) => c.id === "codemagic" && c.status === "connected",
  );
  const steps = [
    {
      done: projects.length > 0,
      icon: Folder,
      tone: "violet",
      title: "Crea un proyecto",
      text: projects.length
        ? `${projects.length} ${projects.length === 1 ? "proyecto" : "proyectos"} en tu espacio`
        : "Empieza con una idea o una plantilla.",
      action: projects.length ? "Ver proyectos" : "Crear proyecto",
      run: projects.length ? onProjects : () => onNew(),
    },
    {
      done: agents.length > 0,
      icon: Sparkles,
      tone: "pink",
      title: "Conecta tu agente de IA",
      text: agents.length
        ? `${agents.join(" y ")} listo para trabajar contigo`
        : "Codex o Claude, con tu cuenta o una API key.",
      action: agents.length ? "Gestionar" : "Conectar agente",
      run: onConnections,
    },
    {
      done: buildsReady,
      icon: Layers3,
      tone: "sky",
      title: "Prepara tus builds",
      text: buildsReady
        ? "Codemagic configurado para compilar"
        : "Conecta Codemagic para compilar tu app.",
      action: buildsReady ? "Ver builds" : "Configurar builds",
      run: buildsReady ? onBuilds : onConnections,
    },
  ];
  const completed = steps.filter((s) => s.done).length;
  return (
    <main className="dashboard">
      {!allProjects ? (
        <>
          <section className="hero">
            <div className="eyebrow">
              <span className="eyebrow-dot" /> Tu estudio de desarrollo
            </div>
            <h1>
              Las grandes ideas
              <br />
              empiezan <span className="gradient-text">aquí.</span>
              <span className="heading-spark" aria-hidden="true">
                ✳
              </span>
            </h1>
            <p>Tu código, tus agentes y tu próxima app. En un mismo lugar.</p>
            <form
              className="idea-composer"
              onSubmit={(e) => {
                e.preventDefault();
                onNew(prompt.trim());
              }}
            >
              <label className="idea-input">
                <Sparkles size={22} />
                <textarea
                  rows={2}
                  aria-label="Describe tu próxima app"
                  placeholder="¿Qué vamos a construir hoy? Describe tu idea…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                    if (
                      e.ctrlKey ||
                      e.metaKey ||
                      (!e.shiftKey && !isTouchInput())
                    ) {
                      e.preventDefault();
                      onNew(prompt.trim());
                    }
                  }}
                />
              </label>
              <div className="idea-composer-bottom">
                <div className="starter-chips">
                  <span>Ideas rápidas</span>
                  {starters.map((s) => (
                    <button
                      type="button"
                      key={s.label}
                      onClick={() => onNew(s.prompt, s.name)}
                    >
                      <s.icon size={14} />
                      {s.label}
                    </button>
                  ))}
                </div>
                <button className="button primary" type="submit">
                  Empezar a crear <ArrowRight size={17} />
                </button>
              </div>
            </form>
          </section>
          <section className="setup" aria-labelledby="setup-title">
            <div className="section-heading">
              <div>
                <h2 id="setup-title">Tu estudio, paso a paso</h2>
                <p>
                  {completed === steps.length
                    ? "Todo listo. ¡A construir!"
                    : `${completed} de ${steps.length} pasos completados`}
                </p>
              </div>
              <div
                className="setup-progress"
                role="progressbar"
                aria-label="Pasos completados"
                aria-valuemin={0}
                aria-valuemax={steps.length}
                aria-valuenow={completed}
              >
                <span
                  style={{ width: `${(completed / steps.length) * 100}%` }}
                />
              </div>
            </div>
            <div className="setup-grid">
              {steps.map((step) => (
                <article
                  key={step.title}
                  className={`setup-card ${step.done ? "done" : ""}`}
                >
                  <div className="setup-card-top">
                    <span className={`metric-icon ${step.tone}`}>
                      <step.icon size={19} />
                    </span>
                    {step.done ? (
                      <Tag tone="success">
                        <Check size={13} /> Listo
                      </Tag>
                    ) : (
                      <Tag>Pendiente</Tag>
                    )}
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                  <button
                    className={`button small ${step.done ? "ghost" : "secondary"}`}
                    onClick={step.run}
                  >
                    {step.action}
                    <ArrowRight size={15} />
                  </button>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : (
        <div className="section-page-heading">
          <div>
            <div className="eyebrow">
              <Folder size={14} /> Tu código, organizado
            </div>
            <h1>
              Proyectos<span className="accent-period">.</span>
            </h1>
            <p>Un espacio para cada idea. Retoma donde lo dejaste.</p>
          </div>
          <button className="button primary" onClick={() => onNew()}>
            <Plus size={17} /> Nuevo proyecto
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
              <Search size={17} />
              <input
                aria-label="Filtrar proyectos"
                placeholder="Buscar proyecto…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          ) : (
            <div className="section-actions">
              <button
                className="button ghost new-project-button"
                title="Nuevo proyecto"
                onClick={() => onNew()}
              >
                <Plus size={17} />
                <span>Nuevo proyecto</span>
              </button>
            </div>
          )}
        </div>
        <div className="project-grid">
          {visible.map((p, index) => (
            <button
              className="project-card"
              key={p.id}
              onClick={() => onOpen(p)}
            >
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
              <div className="project-card-body">
                <div className="project-card-top">
                  <ProjectIcon template={p.template} />
                  <div>
                    <h3>{p.name}</h3>
                    <p>{p.description || "Una nueva idea en construcción."}</p>
                  </div>
                </div>
                <div className="project-card-bottom">
                  <span>
                    <Clock3 size={14} />
                    {relativeDate(p.updatedAt)}
                  </span>
                  <span className="project-open">
                    Abrir <ArrowRight size={15} />
                  </span>
                </div>
              </div>
            </button>
          ))}
          {!query && (
            <button className="new-project-card" onClick={() => onNew()}>
              <span>
                <Plus size={24} />
              </span>
              <h3>Tu próxima gran idea</h3>
              <p>Un lienzo en blanco. Todas las posibilidades.</p>
              <strong>
                Crear proyecto <ArrowRight size={15} />
              </strong>
            </button>
          )}
        </div>
        {allProjects && filtered.length === 0 && query && (
          <p className="muted">No hay proyectos que coincidan con «{query}».</p>
        )}
      </section>
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
  initialName,
  onClose,
  onCreated,
}: {
  initialPrompt: string;
  initialName: string;
  onClose: () => void;
  onCreated: (project: Project, description: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
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
        description,
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Dale espacio a tu idea"
      subtitle="Ponle nombre y elige un punto de partida. Podrás cambiarlo todo después."
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
          {initialPrompt && (
            <small className="field-hint">
              Tu agente recibirá esta descripción como primer encargo.
            </small>
          )}
        </label>
        <div className="field-group">
          <span className="field-label">Punto de partida</span>
          <div className="template-options">
            {(["web", "react"] as const).map((t) => (
              <button
                type="button"
                className={`template-option ${template === t ? "selected" : ""}`}
                aria-pressed={template === t}
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
                    <Check size={13} strokeWidth={3} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-footer">
          <span>
            <ShieldCheck size={15} /> Tu código permanece en tu servidor.
          </span>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <Plus size={17} />} Crear proyecto
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
  const [active, setActive] = useState(0);
  const results = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal title="Salta a un proyecto" onClose={onClose}>
      <label className="search-input large">
        <Search size={19} />
        <input
          placeholder="Escribe para buscar…"
          aria-label="Buscar proyecto"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && results[active]) {
              e.preventDefault();
              onOpen(results[active]);
            }
          }}
        />
      </label>
      <div className="project-search-results">
        {results.map((p, i) => (
          <button
            className={i === active ? "active" : ""}
            onClick={() => onOpen(p)}
            onMouseEnter={() => setActive(i)}
            key={p.id}
          >
            <ProjectIcon template={p.template} />
            <div>
              <strong>{p.name}</strong>
              <small>{p.description || "Sin descripción"}</small>
            </div>
            <ArrowRight size={17} />
          </button>
        ))}
        {!results.length && (
          <p className="search-empty">
            No hay proyectos que coincidan con «{query}».
          </p>
        )}
      </div>
      <p className="search-hint">
        <kbd>↑</kbd> <kbd>↓</kbd> para moverte · <kbd>Enter</kbd> para abrir
      </p>
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
        <span className="eyebrow">AppBuilder Studio</span>
        <h1>
          Tu estudio.
          <br />
          <span className="gradient-text">Donde tú estés.</span>
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
              className="button primary large"
              onClick={() => void retry()}
            >
              Volver a conectar <ArrowRight size={17} />
            </button>
          ) : (
            <button className="button primary large" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  Entrar en mi estudio <ArrowRight size={17} />
                </>
              )}
            </button>
          )}
        </form>
        <small>
          <ShieldCheck size={15} /> Conexión privada con tu entorno de
          desarrollo.
        </small>
      </div>
      <div className="connect-screen-art" aria-hidden="true">
        <Code2Art />
        <span>IDEAS IN. APPS OUT.</span>
      </div>
    </main>
  );
}
