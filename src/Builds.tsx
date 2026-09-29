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
          <div className="welcome-eyebrow">
            <Layers3 size={14} /> DE CÓDIGO A APLICACIÓN
          </div>
          <h1>
            Listo para despegar<span className="accent-period">.</span>
          </h1>
          <p>Compila, sigue el progreso y descarga tus artefactos.</p>
        </div>
        <button
          className="button dark"
          disabled={!connected}
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          Nueva build
        </button>
      </div>
      <div className="build-pipeline">
        <div>
          <span>
            <GitBranch size={22} />
          </span>
          <strong>Tu repositorio</strong>
          <small>Una versión del código</small>
        </div>
        <ArrowRight size={20} />
        <div>
          <span>
            <Workflow size={22} />
          </span>
          <strong>Codemagic</strong>
          <small>Compilación en la nube</small>
        </div>
        <ArrowRight size={20} />
        <div>
          <span>
            <Layers3 size={22} />
          </span>
          <strong>Tu aplicación</strong>
          <small>Artefactos para distribuir</small>
        </div>
      </div>
      <section className="builds-list">
        <div className="section-heading">
          <h2>
            Historial de builds{" "}
            <span className="count-pill">{builds.length}</span>
          </h2>
          {connected && (
            <button
              className="button text"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? <Spinner /> : <RefreshCw size={15} />}Actualizar
            </button>
          )}
        </div>
        {!connected ? (
          <Empty
            icon={<Layers3 size={30} />}
            title="Tu primera build te espera"
            action={
              <button className="button dark" onClick={onConnections}>
                Conectar Codemagic
                <ArrowRight size={16} />
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
              <button className="button light" onClick={() => void refresh()}>
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
          >
            Tus compilaciones aparecerán aquí con su estado y sus resultados.
          </Empty>
        ) : (
          <div className="build-table">
            <div className="build-table-head">
              <span>WORKFLOW</span>
              <span>ESTADO</span>
              <span>RAMA</span>
              <span>INICIO</span>
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
                  <GitBranch size={13} />
                  {build.branch || "—"}
                </span>
                <span>
                  {build.startedAt ? relativeDate(build.startedAt) : "—"}
                </span>
                <ArrowRight size={15} />
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
            {[
              "building",
              "queued",
              "preparing",
              "in_progress",
              "fetching",
              "testing",
              "publishing",
            ].includes(details.status) && (
              <button
                className="button light"
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
  return (
    <Tag tone={success ? "green" : error ? "red" : ""}>
      {success ? (
        <Check size={12} />
      ) : error ? (
        <CircleAlert size={12} />
      ) : (
        <Clock3 size={12} />
      )}
      {(
        {
          finished: "Completada",
          building: "Compilando",
          queued: "En cola",
          failed: "Fallida",
          canceled: "Cancelada",
          preparing: "Preparando",
        } as Record<string, string>
      )[status] || status}
    </Tag>
  );
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
  const [appId, setAppId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [branch, setBranch] = useState("main");
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
        <button className="button dark" disabled={busy}>
          {busy ? <Spinner /> : <Play size={15} />}Iniciar build
        </button>
      </form>
    </Modal>
  );
}
