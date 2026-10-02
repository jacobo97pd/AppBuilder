import { useState } from "react";
import {
  Apple,
  ArrowRight,
  ArrowUpRight,
  Braces,
  FolderGit2,
  GitBranch as Github,
  Globe2,
  KeyRound,
  Layers3,
  LockKeyhole,
  Plug,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Unplug,
} from "lucide-react";
import { api, errorMessage, post } from "./api";
import type { Connection, ToastFn } from "./types";
import { ExternalLink as LinkOut, Modal, Spinner, StatusDot, Tag } from "./ui";

const metadata: Record<
  string,
  {
    category: string;
    description: string;
    label: string;
    docs: string;
    color: string;
    icon: typeof Braces;
  }
> = {
  codex: {
    category: "INTELIGENCIA ARTIFICIAL",
    description:
      "Planifica, escribe código y resuelve problemas con un agente que conoce tu proyecto.",
    label: "OpenAI",
    docs: "https://learn.chatgpt.com/docs/auth",
    color: "emerald",
    icon: Braces,
  },
  claude: {
    category: "INTELIGENCIA ARTIFICIAL",
    description:
      "Trabaja con Claude sobre tus archivos, explora ideas y construye nuevas funciones.",
    label: "Anthropic",
    docs: "https://platform.claude.com/settings/keys",
    color: "coral",
    icon: Sparkles,
  },
  codemagic: {
    category: "BUILD & DEPLOY",
    description:
      "Inicia builds remotas y consulta su estado y artefactos desde tu estudio.",
    label: "CI/CD",
    docs: "https://docs.codemagic.io/rest-api/overview/",
    color: "sky",
    icon: Layers3,
  },
  apple: {
    category: "DISTRIBUCIÓN",
    description:
      "Conecta tu equipo y consulta las aplicaciones de App Store Connect.",
    label: "Apple",
    docs: "https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api",
    color: "slate",
    icon: Apple,
  },
  google: {
    category: "DISTRIBUCIÓN",
    description:
      "Consulta canales de pruebas y versiones de tus aplicaciones Android.",
    label: "Google",
    docs: "https://developers.google.com/android-publisher/getting_started",
    color: "amber",
    icon: Smartphone,
  },
  github: {
    category: "CÓDIGO FUENTE",
    description:
      "Importa tus repositorios al estudio y sube los cambios que hagas desde la app.",
    label: "GitHub",
    docs: "https://github.com/settings/tokens",
    color: "violet",
    icon: Github,
  },
};
const groups = [
  {
    id: "ai",
    title: "Agentes de IA",
    text: "El compañero que escribe, revisa y explica código contigo. Con uno es suficiente.",
    ids: ["codex", "claude"],
  },
  {
    id: "dev",
    title: "Desarrollo y distribución",
    text: "Compila tu app, consulta las tiendas y accede a tus repositorios.",
    ids: ["codemagic", "apple", "google", "github"],
  },
];
export function Connections({
  connections,
  refresh,
  notify,
  onImport,
}: {
  connections: Connection[];
  refresh: () => Promise<void>;
  notify: ToastFn;
  onImport: () => void;
}) {
  const [editing, setEditing] = useState<Connection | null>(null);
  const [testing, setTesting] = useState("");
  const [connectingAccount, setConnectingAccount] = useState(false);
  const [connectingClaude, setConnectingClaude] = useState(false);
  const [exploring, setExploring] = useState<Connection | null>(null);
  async function test(connection: Connection) {
    setTesting(connection.id);
    try {
      const result = await post<{ ok: boolean; message: string }>(
        `/connections/${connection.id}/test`,
      );
      notify(result.message, result.ok ? "success" : "error");
      await refresh();
    } catch (e) {
      notify(errorMessage(e), "error");
      await refresh();
    } finally {
      setTesting("");
    }
  }
  async function remove(connection: Connection) {
    try {
      await api(`/connections/${connection.id}`, { method: "DELETE" });
      await refresh();
      notify("Conexión desconectada.");
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  }
  async function connectChatgpt() {
    setConnectingAccount(true);
    try {
      await post("/connections/codex/account");
      await refresh();
      notify("Cuenta ChatGPT conectada para Codex en este ordenador.");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setConnectingAccount(false);
    }
  }
  async function connectClaudeCode() {
    setConnectingClaude(true);
    try {
      await post("/connections/claude/local");
      await refresh();
      notify("Claude Code conectado con la sesión de este ordenador.");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setConnectingClaude(false);
    }
  }
  const ready = connections.filter((c) => c.status === "connected").length;
  return (
    <main className="dashboard connections-page">
      <div className="section-page-heading">
        <div>
          <div className="eyebrow">
            <Plug size={14} /> Tu equipo, conectado
          </div>
          <h1>
            Todo trabaja contigo<span className="accent-period">.</span>
          </h1>
          <p>
            Las herramientas que conoces. Un espacio para unirlas.{" "}
            <strong>
              {ready} de {connections.length} listas.
            </strong>
          </p>
        </div>
        <span className="secure-badge">
          <ShieldCheck size={16} />
          Credenciales cifradas
        </span>
      </div>
      {groups.map((group) => (
        <section
          className="connection-group"
          key={group.id}
          aria-labelledby={`group-${group.id}`}
        >
          <div className="section-heading">
            <div>
              <h2 id={`group-${group.id}`}>{group.title}</h2>
              <p>{group.text}</p>
            </div>
          </div>
          <div className="connections-grid">
            {connections
              .filter((c) => group.ids.includes(c.id))
              .map((c) => {
                const meta = metadata[c.id];
                if (!meta) return null;
                return (
                  <article className={`connection-card ${c.status}`} key={c.id}>
                    <div className="connection-card-heading">
                      <span className={`connection-icon ${meta.color}`}>
                        <meta.icon size={24} />
                      </span>
                      <div className="connection-title">
                        <span className="mini-eyebrow">{meta.category}</span>
                        <h3>{c.name}</h3>
                      </div>
                      <Tag
                        tone={
                          c.status === "connected"
                            ? "success"
                            : c.status === "error"
                              ? "danger"
                              : ""
                        }
                      >
                        <StatusDot active={c.status === "connected"} />
                        {c.status === "connected"
                          ? "Configurado"
                          : c.status === "error"
                            ? "Revisar conexión"
                            : "Sin conectar"}
                      </Tag>
                    </div>
                    <p className="connection-description">{meta.description}</p>
                    <div className="connection-detail">{c.detail}</div>
                    <div className="connection-actions">
                      {c.id === "codex" && c.authMode !== "chatgpt" && (
                        <button
                          className="button small primary"
                          onClick={() => void connectChatgpt()}
                          disabled={connectingAccount}
                        >
                          {connectingAccount ? <Spinner /> : <Plug size={15} />}
                          Usar cuenta ChatGPT
                        </button>
                      )}
                      {c.id === "claude" && c.authMode !== "claude_code" && (
                        <button
                          className="button small primary"
                          onClick={() => void connectClaudeCode()}
                          disabled={connectingClaude}
                        >
                          {connectingClaude ? <Spinner /> : <Plug size={15} />}
                          Usar Claude Code
                        </button>
                      )}
                      {c.status !== "missing" ? (
                        <>
                          <button
                            className="button small secondary"
                            onClick={() => void test(c)}
                            disabled={!!testing}
                          >
                            {testing === c.id ? (
                              <Spinner />
                            ) : (
                              <RefreshCw size={15} />
                            )}
                            Probar
                          </button>
                          {c.id === "github" && (
                            <button
                              className="button small primary"
                              onClick={onImport}
                            >
                              <FolderGit2 size={15} />
                              Importar repositorio
                            </button>
                          )}
                          {["apple", "google"].includes(c.id) && (
                            <button
                              className="button small secondary"
                              onClick={() => setExploring(c)}
                            >
                              Consultar
                              <ArrowRight size={14} />
                            </button>
                          )}
                          {c.authMode !== "chatgpt" &&
                            c.authMode !== "claude_code" && (
                              <button
                                className="icon-button"
                                title="Editar credenciales"
                                aria-label={`Editar ${c.name}`}
                                onClick={() => setEditing(c)}
                              >
                                <KeyRound size={17} />
                              </button>
                            )}
                          <button
                            className="icon-button danger"
                            title="Eliminar credenciales guardadas"
                            aria-label={`Desconectar ${c.name}`}
                            onClick={() => void remove(c)}
                          >
                            <Unplug size={17} />
                          </button>
                        </>
                      ) : (
                        <button
                          className={`button small ${["codex", "claude"].includes(c.id) ? "secondary" : "primary"}`}
                          onClick={() => setEditing(c)}
                        >
                          {["codex", "claude"].includes(c.id) ? (
                            <KeyRound size={15} />
                          ) : (
                            <Plug size={15} />
                          )}
                          {["codex", "claude"].includes(c.id)
                            ? "Usar API key"
                            : "Conectar"}
                        </button>
                      )}
                      <a
                        className="connection-docs"
                        aria-label={`Documentación de ${c.name}`}
                        title="Documentación"
                        href={
                          c.id === "claude" && c.authMode === "claude_code"
                            ? "https://code.claude.com/docs/en/setup"
                            : meta.docs
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ArrowUpRight size={18} />
                      </a>
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
      ))}
      <div className="connection-privacy">
        <span>
          <LockKeyhole size={20} />
        </span>
        <div>
          <h3>Tus credenciales se quedan en tu servidor.</h3>
          <p>
            El estudio cifra las claves guardadas y no las devuelve al
            navegador. Puedes sustituirlas o eliminarlas cuando quieras. Las
            claves definidas como variables de entorno se gestionan en el
            servidor.
          </p>
        </div>
      </div>
      {editing && (
        <ConnectionModal
          connection={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            setEditing(null);
            notify(
              "Credenciales guardadas. Prueba la conexión para verificar el acceso.",
            );
          }}
        />
      )}
      {exploring && (
        <StoreExplorer
          connection={exploring}
          onClose={() => setExploring(null)}
        />
      )}
    </main>
  );
}
function ConnectionModal({
  connection,
  onClose,
  onSaved,
}: {
  connection: Connection;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/connections/${connection.id}`, {
        method: "PUT",
        body: JSON.stringify({ credentials }),
      });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Conectar ${connection.name}`}
      subtitle="Guarda tus credenciales para activar la integración."
      onClose={onClose}
    >
      <form className="stack-form" onSubmit={submit}>
        {connection.fields.map((field) => (
          <label key={field.key}>
            {field.label}
            {field.key === "privateKey" ||
            field.key === "serviceAccountJson" ? (
              <textarea
                rows={5}
                className="secret-textarea"
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                value={credentials[field.key] ?? ""}
                onChange={(e) =>
                  setCredentials((v) => ({ ...v, [field.key]: e.target.value }))
                }
                required={connection.status === "missing"}
              />
            ) : (
              <input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  connection.status !== "missing"
                    ? "Dejar vacío para conservar el valor actual"
                    : field.placeholder
                }
                value={credentials[field.key] ?? ""}
                onChange={(e) =>
                  setCredentials((v) => ({ ...v, [field.key]: e.target.value }))
                }
                required={connection.status === "missing"}
              />
            )}
          </label>
        ))}
        {["codex", "claude"].includes(connection.id) && (
          <div className="notice">
            <KeyRound size={17} />
            <p>
              {connection.id === "codex"
                ? "Esta opción usa una API key con facturación independiente. Para usar tu suscripción, pulsa «Usar cuenta ChatGPT» en la tarjeta de Codex."
                : "Esta opción usa una API key con facturación independiente. Para usar Claude Code instalado e iniciado en tu ordenador, pulsa «Usar Claude Code» en la tarjeta de Claude."}
            </p>
          </div>
        )}
        {connection.id === "github" && (
          <div className="notice">
            <KeyRound size={17} />
            <p>
              Crea un token «fine-grained» con acceso a tus repositorios y el
              permiso <strong>Contents: Read and write</strong> para poder
              importar y subir cambios. El token solo se usa para hablar con
              GitHub y nunca se guarda dentro de los proyectos.
            </p>
          </div>
        )}
        {error && (
          <div role="alert" className="inline-error">
            {error}
          </div>
        )}
        <div className="form-footer">
          <LinkOut href={metadata[connection.id].docs}>
            Obtener credenciales
          </LinkOut>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <LockKeyhole size={16} />}Guardar conexión
          </button>
        </div>
      </form>
    </Modal>
  );
}
function StoreExplorer({
  connection,
  onClose,
}: {
  connection: Connection;
  onClose: () => void;
}) {
  const [data, setData] = useState<unknown>(null);
  const [packageName, setPackageName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result =
        connection.id === "google"
          ? await post("/stores/google/tracks", { packageName })
          : await api(
              connection.id === "apple"
                ? "/stores/apple/apps"
                : "/github/repos",
            );
      setData(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={connection.name}
      subtitle="Consulta los datos reales de tu cuenta."
      onClose={onClose}
    >
      <form
        className="store-query"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        {connection.id === "google" && (
          <label>
            Identificador de la app
            <input
              required
              placeholder="com.ejemplo.miapp"
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
            />
          </label>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : <RefreshCw size={16} />}Consultar{" "}
          {connection.id === "google"
            ? "canales"
            : connection.id === "github"
              ? "repositorios"
              : "aplicaciones"}
        </button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {data ? (
        <pre className="store-results">{JSON.stringify(data, null, 2)}</pre>
      ) : (
        <p className="store-empty">
          Los resultados aparecerán aquí cuando consultes la cuenta.
        </p>
      )}
      <div className="notice">
        <Globe2 size={17} />
        <p>
          Esta versión permite consultar la cuenta. La configuración inicial y
          la publicación final se gestionan en el portal del proveedor.
        </p>
      </div>
    </Modal>
  );
}
