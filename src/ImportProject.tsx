import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  Download,
  FolderGit2,
  Lock,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
} from "lucide-react";
import { api, errorMessage, post } from "./api";
import type { Connection, GithubRepo, Job, Project } from "./types";
import { relativeDate, Spinner } from "./ui";

// Above this size a full clone is slow; suggest the light import instead.
const LARGE_REPOSITORY_KB = 200 * 1024;

function suggestedName(address: string): string {
  return (
    address
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? ""
  ).slice(0, 80);
}

function formatSize(kb: number): string {
  return kb >= 1024 * 1024
    ? `${(kb / 1024 / 1024).toFixed(1)} GB`
    : `${Math.max(1, Math.round(kb / 1024))} MB`;
}

function lastLine(output: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ""
  );
}

export function GithubImport({
  connections,
  onImported,
  onConnections,
}: {
  connections: Connection[];
  onImported: (project: Project) => Promise<void>;
  onConnections: () => void;
}) {
  const connected = connections.some(
    (c) => c.id === "github" && c.status === "connected",
  );
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [branch, setBranch] = useState("");
  const [light, setLight] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const handled = useRef("");
  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    setReposError("");
    try {
      setRepos((await api<{ repos: GithubRepo[] }>("/github/repos")).repos);
    } catch (e) {
      setReposError(errorMessage(e));
    } finally {
      setLoadingRepos(false);
    }
  }, []);
  useEffect(() => {
    if (connected) void loadRepos();
  }, [connected, loadRepos]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setInterval(() => {
      api<Job>(`/jobs/${job.id}`)
        .then(setJob)
        .catch(() => {
          /* Keep the last known progress across brief disconnects. */
        });
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!job || job.status !== "succeeded" || handled.current === job.id)
      return;
    handled.current = job.id;
    api<Project[]>("/projects")
      .then((projects) => {
        const project = projects.find((item) => item.id === job.projectId);
        if (project) return onImported(project);
        setError(
          "El proyecto se importó pero no aparece todavía. Vuelve a tu lista de proyectos.",
        );
      })
      .catch((e) => setError(errorMessage(e)));
  }, [job, onImported]);

  function choose(repo: GithubRepo) {
    setSelected(repo);
    setUrl(repo.cloneUrl);
    setBranch("");
    if (!nameEdited) setName(suggestedName(repo.name));
    setLight((repo.sizeKb ?? 0) > LARGE_REPOSITORY_KB);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await post<{ project: Project; job: Job }>(
        "/projects/import",
        {
          url: url.trim(),
          name: name.trim() || undefined,
          branch: branch.trim() || undefined,
          light,
        },
      );
      setJob(result.job);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (job)
    return (
      <ImportProgress
        job={job}
        error={error}
        onUpdate={setJob}
        onRetry={() => {
          setJob(null);
          setError("");
        }}
      />
    );
  const filtered = (repos ?? []).filter((repo) =>
    repo.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const large = (selected?.sizeKb ?? 0) > LARGE_REPOSITORY_KB;
  return (
    <form className="stack-form" onSubmit={submit}>
      {connected ? (
        <div className="field-group">
          <span className="field-label">Tus repositorios</span>
          <label className="search-input">
            <Search size={17} />
            <input
              aria-label="Buscar en tus repositorios"
              placeholder="Busca en tus repositorios…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Actualizar repositorios"
              title="Actualizar repositorios"
              disabled={loadingRepos}
              onClick={() => void loadRepos()}
            >
              {loadingRepos ? <Spinner /> : <RefreshCw size={15} />}
            </button>
          </label>
          <div className="repo-list" role="listbox" aria-label="Repositorios">
            {loadingRepos && !repos ? (
              <p className="repo-empty">
                <Spinner /> Cargando tus repositorios…
              </p>
            ) : reposError ? (
              <p className="repo-empty error">{reposError}</p>
            ) : filtered.length ? (
              filtered.slice(0, 60).map((repo) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected?.id === repo.id}
                  className={`repo-option ${selected?.id === repo.id ? "selected" : ""}`}
                  key={repo.id}
                  onClick={() => choose(repo)}
                >
                  <FolderGit2 size={18} />
                  <span>
                    <strong>{repo.name}</strong>
                    <small>
                      {repo.description ||
                        `Rama ${repo.branch}${repo.updatedAt ? ` · ${relativeDate(repo.updatedAt)}` : ""}`}
                    </small>
                  </span>
                  {repo.private && (
                    <Lock
                      size={14}
                      aria-label="Privado"
                      className="repo-private"
                    />
                  )}
                </button>
              ))
            ) : (
              <p className="repo-empty">
                {query
                  ? `Ningún repositorio coincide con «${query}».`
                  : "No hay repositorios en esta cuenta."}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="notice import-connect">
          <Plug size={17} />
          <div>
            <p>
              <strong>
                Conecta GitHub para elegir entre tus repositorios.
              </strong>{" "}
              Mientras tanto puedes pegar la dirección: funcionan los
              repositorios públicos y los privados a los que ya accedes con Git
              en el ordenador del servidor.
            </p>
            <button
              type="button"
              className="button ghost small"
              onClick={onConnections}
            >
              Conectar GitHub
            </button>
          </div>
        </div>
      )}
      <label>
        {connected ? "O pega la dirección" : "Dirección del repositorio"}
        <input
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://github.com/usuario/proyecto o usuario/proyecto"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setSelected(null);
            if (!nameEdited) setName(suggestedName(e.target.value));
          }}
        />
      </label>
      <label>
        Nombre en tu estudio
        <input
          autoComplete="off"
          maxLength={80}
          placeholder="Se toma del repositorio"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
        />
      </label>
      <details className="import-options" open={large || undefined}>
        <summary>Opciones avanzadas</summary>
        <label>
          Rama
          <input
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={
              selected
                ? `Por defecto: ${selected.branch}`
                : "La rama principal del repositorio"
            }
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={light}
            onChange={(e) => setLight(e.target.checked)}
          />
          <span>
            <strong>Descarga ligera</strong>
            <small>
              Solo la última versión y sin los archivos grandes de Git LFS.
              Ideal para repositorios grandes, como juegos: editas el código y
              subes los cambios igual.
              {large && selected?.sizeKb
                ? ` Este repositorio ocupa ${formatSize(selected.sizeKb)}.`
                : ""}
            </small>
          </span>
        </label>
      </details>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>
          <ShieldCheck size={15} /> Se clona en tu servidor, no en este
          dispositivo.
        </span>
        <button className="button primary" disabled={busy || !url.trim()}>
          {busy ? <Spinner /> : <Download size={17} />} Importar proyecto
        </button>
      </div>
    </form>
  );
}

function ImportProgress({
  job,
  error,
  onUpdate,
  onRetry,
}: {
  job: Job;
  error: string;
  onUpdate: (job: Job) => void;
  onRetry: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const running = job.status === "running";
  const lines = job.output.trim().split("\n").slice(-12).join("\n");
  const title = running
    ? `${job.title.replace(/^Importar /, "Importando ")}…`
    : job.status === "succeeded"
      ? "Proyecto importado"
      : job.status === "cancelled"
        ? "Importación cancelada"
        : "No se pudo importar el repositorio";
  return (
    <div className="import-progress" aria-live="polite">
      <div className={`import-progress-head ${job.status}`}>
        {running ? (
          <Spinner />
        ) : job.status === "succeeded" ? (
          <CircleCheck size={20} />
        ) : (
          <CircleAlert size={20} />
        )}
        <div>
          <strong>{title}</strong>
          <small>
            {running
              ? "Puedes cerrar esta ventana: la importación sigue en segundo plano y el proyecto aparecerá en tu lista."
              : job.status === "succeeded"
                ? "Abriendo tu proyecto…"
                : job.status === "failed"
                  ? lastLine(job.output)
                  : "No se ha guardado nada en tu servidor."}
          </small>
        </div>
      </div>
      <pre className="import-log">{lines}</pre>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span />
        {running ? (
          <button
            type="button"
            className="button secondary"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                onUpdate(await post<Job>(`/jobs/${job.id}/cancel`));
              } catch {
                setCancelling(false);
              }
            }}
          >
            {cancelling ? <Spinner /> : <Square size={14} />} Cancelar
          </button>
        ) : job.status !== "succeeded" ? (
          <button type="button" className="button primary" onClick={onRetry}>
            Volver a intentar
          </button>
        ) : null}
      </div>
    </div>
  );
}
