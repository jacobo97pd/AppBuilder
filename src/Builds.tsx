import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  GitBranch,
  Layers3,
  Play,
  Plus,
  RefreshCw,
  Square,
  Workflow,
} from "lucide-react";
import { api, errorMessage, post } from "./api";
import type { Build, Connection, Project, ToastFn } from "./types";
import { Empty, Modal, relativeDate, Spinner, Tag } from "./ui";

const LAST_BUILD_KEY = "appbuilder.lastBuild";
const activeStatuses = [
  "building",
  "queued",
  "preparing",
  "in_progress",
  "fetching",
  "testing",
  "publishing",
];

export function Builds({
  connections,
  projects,
  notify,
  onConnections,
}: {
  connections: Connection[];
  projects: Project[];
  notify: ToastFn;
  onConnections: () => void;
}) {
  const connected = connections.some(
    (c) => c.id === "codemagic" && c.status === "connected",
  );
  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [details, setDetails] = useState<Build | null>(null);
  const refresh = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      setBuilds(await api<Build[]>("/builds"));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [connected]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  return (
    <main className="dashboard builds-page">
      <div className="section-page-heading">
        <div>
          <div className="eyebrow">
            <Layers3 size={14} /> De código a aplicación
          </div>
          <h1>
            Listo para despegar<span className="accent-period">.</span>
          </h1>
          <p>Compila, sigue el progreso y descarga tus artefactos.</p>
        </div>
        <button
          className="button primary"
          disabled={!connected}
          title={connected ? undefined : "Conecta Codemagic para empezar"}
          onClick={() => setCreating(true)}
        >
          <Plus size={17} />
          Nueva build
        </button>
      </div>
      <ol className="build-pipeline">
        <li>
          <span>
            <GitBranch size={21} />
          </span>
          <div>
            <strong>Tu repositorio</strong>
            <small>Haz commit y push de tu código</small>
          </div>
        </li>
        <li>
          <span>
            <Workflow size={21} />
          </span>
          <div>
            <strong>Codemagic</strong>
            <small>Compila en la nube</small>
          </div>
        </li>
        <li>
          <span>
            <Layers3 size={21} />
          </span>
          <div>
            <strong>Tu aplicación</strong>
            <small>Descarga los artefactos</small>
          </div>
        </li>
      </ol>
      <section className="builds-list">
        <div className="section-heading">
          <h2>
            Historial de builds{" "}
            <span className="count-pill">{builds.length}</span>
          </h2>
          {connected && (
            <button
              className="button ghost"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? <Spinner /> : <RefreshCw size={16} />}Actualizar
            </button>
          )}
        </div>
        {!connected ? (
          <Empty
            icon={<Layers3 size={30} />}
            title="Tu primera build te espera"
            action={
              <button className="button primary" onClick={onConnections}>
                Conectar Codemagic
                <ArrowRight size={17} />
              </button>
            }
          >
            Conecta tu cuenta para iniciar y seguir las builds de tus
            repositorios.
          </Empty>
        ) : error ? (
          <Empty
            icon={<CircleAlert size={28} />}
            title="No pudimos consultar las builds"
            action={
              <button
                className="button secondary"
                onClick={() => void refresh()}
              >
                Volver a intentar
              </button>
            }
          >
            {error}
          </Empty>
        ) : builds.length === 0 ? (
          <Empty
            icon={loading ? <Spinner /> : <Workflow size={28} />}
            title={loading ? "Consultando Codemagic" : "Aún no hay builds"}
            action={
              loading ? undefined : (
                <button
                  className="button primary"
                  onClick={() => setCreating(true)}
                >
                  <Play size={16} />
                  Iniciar mi primera build
                </button>
              )
            }
          >
            Tus compilaciones aparecerán aquí con su estado y sus resultados.
          </Empty>
        ) : (
          <div className="build-table">
            <div className="build-table-head">
              <span>Workflow</span>
              <span>Estado</span>
              <span>Rama</span>
              <span>Inicio</span>
            </div>
            {builds.map((build) => (
              <button
                className="build-row"
                key={build.id}
                onClick={() => setDetails(build)}
              >
                <span>
                  <span className="build-icon">
                    <Layers3 size={18} />
                  </span>
                  <span>
                    <strong>{build.workflowId || "Build"}</strong>
                    <small>{build.id.slice(-10)}</small>
                  </span>
                </span>
                <span>
                  <BuildStatus status={build.status} />
                </span>
                <span>
                  <GitBranch size={14} />
                  {build.branch || "—"}
                </span>
                <span>
                  {build.startedAt ? relativeDate(build.startedAt) : "—"}
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        )}
      </section>
      <div className="notice">
        <GitBranch size={17} />
        <p>
          Codemagic compila el repositorio remoto configurado en tu cuenta. Haz
          commit y push de tus cambios antes de iniciar una build. La vista
          previa local no publica el proyecto.
        </p>
      </div>
      {creating && (
        <NewBuild
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
            notify("Build enviada a Codemagic.");
          }}
        />
      )}
      {details && (
        <Modal
          title={details.workflowId || "Detalle de build"}
          subtitle={details.id}
          onClose={() => setDetails(null)}
        >
          <div className="build-detail-meta">
            <BuildStatus status={details.status} />
            <span>
              <GitBranch size={14} />
              {details.branch}
            </span>
          </div>
          <h3 className="artifact-title">Artefactos</h3>
          {details.artifacts?.length ? (
            <div className="artifact-list">
              {details.artifacts.map((artifact, i) => {
                let safe = false;
                try {
                  safe = new URL(artifact.url).protocol === "https:";
                } catch {
                  /* Invalid upstream links are not clickable. */
                }
                return safe ? (
                  <a
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer"
                    key={i}
                  >
                    <Layers3 size={17} />
                    {artifact.name}
                    <ArrowDownToLine size={16} />
                  </a>
                ) : (
                  <span key={i}>{artifact.name} · URL no válida</span>
                );
              })}
            </div>
          ) : (
            <p className="muted">
              Esta build todavía no tiene artefactos disponibles.
            </p>
          )}
          <div className="form-footer">
            <a
              className="text-link"
              href={`https://codemagic.io/app/${encodeURIComponent(details.appId)}/build/${encodeURIComponent(details.id)}`}
              target="_blank"
              rel="noreferrer"
            >
              Ver registros en Codemagic
              <ExternalLink size={14} />
            </a>
            {activeStatuses.includes(details.status) && (
              <button
                className="button secondary"
                onClick={async () => {
                  try {
                    await post(`/builds/${details.id}/cancel`);
                    setDetails(null);
                    await refresh();
                    notify("Cancelación solicitada.");
                  } catch (e) {
                    notify(errorMessage(e), "error");
                  }
                }}
              >
                <Square size={14} />
                Cancelar build
              </button>
            )}
          </div>
        </Modal>
      )}
    </main>
  );
}
function BuildStatus({ status }: { status: string }) {
  const success = ["finished", "succeeded", "success"].includes(status);
  const error = ["failed", "error", "timeout"].includes(status);
  const active = activeStatuses.includes(status);
  return (
    <Tag tone={success ? "success" : error ? "danger" : active ? "info" : ""}>
      {success ? (
        <Check size={13} />
      ) : error ? (
        <CircleAlert size={13} />
      ) : (
        <Clock3 size={13} />
      )}
      {(
        {
          finished: "Completada",
          succeeded: "Completada",
          success: "Completada",
          building: "Compilando",
          queued: "En cola",
          preparing: "Preparando",
          in_progress: "En curso",
          fetching: "Descargando código",
          testing: "Probando",
          publishing: "Publicando",
          failed: "Fallida",
          error: "Fallida",
          timeout: "Tiempo agotado",
          canceled: "Cancelada",
          cancelled: "Cancelada",
          skipped: "Omitida",
        } as Record<string, string>
      )[status] || status}
    </Tag>
  );
}
function readLastBuild() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_BUILD_KEY) || "{}");
    return {
      appId: typeof saved.appId === "string" ? saved.appId : "",
      workflowId: typeof saved.workflowId === "string" ? saved.workflowId : "",
      branch: typeof saved.branch === "string" ? saved.branch : "main",
    };
  } catch {
    return { appId: "", workflowId: "", branch: "main" };
  }
}
function NewBuild({
  projects,
  onClose,
  onCreated,
}: {
  projects: Project[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  // Most builds repeat the same app and workflow, so start from the last ones.
  const [last] = useState(readLastBuild);
  const [appId, setAppId] = useState(last.appId);
  const [workflowId, setWorkflowId] = useState(last.workflowId);
  const [branch, setBranch] = useState(last.branch || "main");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Tu próxima build"
      subtitle="Usa los identificadores de tu aplicación y workflow en Codemagic."
      onClose={onClose}
    >
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post("/builds", {
              appId,
              workflowId,
              branch,
              projectId: projectId || undefined,
            });
            try {
              localStorage.setItem(
                LAST_BUILD_KEY,
                JSON.stringify({ appId, workflowId, branch }),
              );
            } catch {
              /* Remembering the form is optional. */
            }
            await onCreated();
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        <label>
          App ID de Codemagic
          <input
            required
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="Identificador de tu aplicación"
          />
        </label>
        <label>
          Workflow ID
          <input
            required
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
            placeholder="android-debug"
          />
        </label>
        <div className="form-columns">
          <label>
            Rama
            <input
              required
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
          <label>
            Proyecto relacionado
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Sin asociación local</option>
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <div role="alert" className="inline-error">
            {error}
          </div>
        )}
        <div className="notice">
          <Clock3 size={16} />
          <p>
            La compilación utiliza los minutos y recursos de tu cuenta de
            Codemagic.
          </p>
        </div>
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : <Play size={16} />}Iniciar build
        </button>
      </form>
    </Modal>
  );
}
