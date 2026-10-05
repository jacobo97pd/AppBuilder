import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Database,
  FileJson,
  FolderTree,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { api, errorMessage, post } from "./api";
import type { Connection, ToastFn } from "./types";
import { Empty, Modal, relativeDate, Spinner } from "./ui";

type FirestoreDocument = {
  id: string;
  path: string;
  missing: boolean;
  createTime: string | null;
  updateTime: string | null;
  data: Record<string, unknown>;
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function preview(data: Record<string, unknown>): string {
  const entries = Object.entries(data).slice(0, 3);
  if (!entries.length) return "Sin campos";
  return entries
    .map(([key, value]) => {
      const text =
        typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
      return `${key}: ${text.length > 40 ? text.slice(0, 40) + "…" : text}`;
    })
    .join(" · ");
}

export function FirebasePage({
  connections,
  notify,
  onConnections,
}: {
  connections: Connection[];
  notify: ToastFn;
  onConnections: () => void;
}) {
  const connected = connections.some(
    (c) => c.id === "firebase" && c.status === "connected",
  );
  const [projectId, setProjectId] = useState("");
  // The document whose subcollections are listed ("" is the database root).
  const [parent, setParent] = useState("");
  const [collection, setCollection] = useState("");
  const [documentPath, setDocumentPath] = useState("");
  const [collections, setCollections] = useState<string[] | null>(null);
  const [documents, setDocuments] = useState<FirestoreDocument[] | null>(null);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const loadCollections = useCallback(async (from: string) => {
    setLoading("collections");
    setError("");
    try {
      const result = await api<{ collections: string[] }>(
        `/firebase/collections?parent=${encodeURIComponent(from)}`,
      );
      setCollections(result.collections);
    } catch (e) {
      setError(errorMessage(e));
      setCollections([]);
    } finally {
      setLoading("");
    }
  }, []);
  const loadDocuments = useCallback(
    async (path: string, pageToken = "") => {
      setLoading("documents");
      try {
        const result = await api<{
          documents: FirestoreDocument[];
          nextPageToken: string | null;
        }>(
          `/firebase/documents?collection=${encodeURIComponent(path)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
        );
        setDocuments((current) =>
          pageToken && current
            ? [...current, ...result.documents]
            : result.documents,
        );
        setNextPage(result.nextPageToken);
      } catch (e) {
        notify(errorMessage(e), "error");
        if (!pageToken) setDocuments([]);
      } finally {
        setLoading("");
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!connected) return;
    api<{ projectId: string }>("/firebase")
      .then((result) => setProjectId(result.projectId))
      .catch((e) => setError(errorMessage(e)));
  }, [connected]);
  useEffect(() => {
    if (connected) void loadCollections(parent);
  }, [connected, parent, loadCollections]);
  useEffect(() => {
    setDocuments(null);
    setNextPage(null);
    if (connected && collection) void loadDocuments(collection);
  }, [connected, collection, loadDocuments]);

  function openCollection(name: string) {
    setCollection(parent ? `${parent}/${name}` : name);
    setDocumentPath("");
  }
  function openSubcollection(document: string, name: string) {
    setParent(document);
    setCollection(`${document}/${name}`);
    setDocumentPath("");
  }
  /** Breadcrumb click: depth counts path segments to keep. */
  function goTo(depth: number) {
    const segments = (documentPath || collection || parent)
      .split("/")
      .filter(Boolean);
    const target = segments.slice(0, depth).join("/");
    if (!target) {
      setParent("");
      setCollection("");
      setDocumentPath("");
    } else if (depth % 2 === 1) {
      setParent(segments.slice(0, depth - 1).join("/"));
      setCollection(target);
      setDocumentPath("");
    } else {
      setParent(segments.slice(0, depth - 2).join("/"));
      setCollection(segments.slice(0, depth - 1).join("/"));
      setDocumentPath(target);
    }
  }
  const view = documentPath
    ? "document"
    : collection
      ? "documents"
      : "collections";
  const crumbs = (documentPath || collection || parent)
    .split("/")
    .filter(Boolean);
  return (
    <main className="dashboard firebase-page">
      <div className="section-page-heading">
        <div>
          <div className="eyebrow">
            <Database size={14} /> Firebase · Firestore
          </div>
          <h1>
            Tus datos, a mano<span className="accent-period">.</span>
          </h1>
          <p>
            Explora colecciones, edita documentos y corrige datos de tu app sin
            salir del estudio.
          </p>
        </div>
        {projectId && (
          <span className="secure-badge">
            <Database size={16} />
            {projectId}
          </span>
        )}
      </div>
      {!connected ? (
        <section className="builds-list">
          <Empty
            icon={<Database size={30} />}
            title="Conecta tu proyecto de Firebase"
            action={
              <button className="button primary" onClick={onConnections}>
                Conectar Firebase
                <ArrowRight size={17} />
              </button>
            }
          >
            Añade el JSON de una cuenta de servicio de tu proyecto para ver y
            editar Firestore desde aquí.
          </Empty>
        </section>
      ) : (
        <>
          <nav className="firebase-breadcrumbs" aria-label="Ruta en Firestore">
            <button onClick={() => goTo(0)}>
              <Database size={15} /> {projectId || "Base de datos"}
            </button>
            {crumbs.map((segment, index) => (
              <span key={index}>
                <ChevronRight size={14} />
                <button onClick={() => goTo(index + 1)}>
                  {index % 2 === 0 ? (
                    <FolderTree size={14} />
                  ) : (
                    <FileJson size={14} />
                  )}
                  {segment}
                </button>
              </span>
            ))}
          </nav>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className={`firebase-layout view-${view}`}>
            <section className="firebase-column collections">
              <header>
                <strong>{parent ? "Subcolecciones" : "Colecciones"}</strong>
                <button
                  className="icon-button"
                  aria-label="Actualizar colecciones"
                  title="Actualizar colecciones"
                  onClick={() => void loadCollections(parent)}
                >
                  {loading === "collections" ? (
                    <Spinner />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                </button>
              </header>
              <div className="firebase-list">
                {collections === null ? (
                  <p className="firebase-empty">
                    <Spinner /> Cargando…
                  </p>
                ) : collections.length ? (
                  collections.map((name) => {
                    const path = parent ? `${parent}/${name}` : name;
                    return (
                      <button
                        key={name}
                        className={`firebase-item ${collection === path ? "active" : ""}`}
                        onClick={() => openCollection(name)}
                      >
                        <FolderTree size={16} />
                        <span>{name}</span>
                        <ChevronRight size={15} />
                      </button>
                    );
                  })
                ) : (
                  <p className="firebase-empty">
                    {parent
                      ? "Este documento no tiene subcolecciones."
                      : "Firestore está vacío."}
                  </p>
                )}
              </div>
            </section>
            <section className="firebase-column documents">
              <header>
                <button
                  className="icon-button firebase-back"
                  aria-label="Volver a las colecciones"
                  onClick={() => setCollection("")}
                >
                  <ArrowLeft size={17} />
                </button>
                <strong>
                  {collection ? collection.split("/").pop() : "Documentos"}
                </strong>
                {collection && (
                  <button
                    className="button small secondary"
                    onClick={() => setCreating(true)}
                  >
                    <Plus size={15} /> Nuevo
                  </button>
                )}
              </header>
              <div className="firebase-list">
                {!collection ? (
                  <p className="firebase-empty">
                    Elige una colección para ver sus documentos.
                  </p>
                ) : documents === null ? (
                  <p className="firebase-empty">
                    <Spinner /> Cargando…
                  </p>
                ) : documents.length ? (
                  <>
                    {documents.map((document) => (
                      <button
                        key={document.path}
                        className={`firebase-item document ${documentPath === document.path ? "active" : ""}`}
                        onClick={() => setDocumentPath(document.path)}
                      >
                        <FileJson size={16} />
                        <span>
                          <strong>{document.id}</strong>
                          <small>
                            {document.missing
                              ? "Solo contiene subcolecciones"
                              : preview(document.data)}
                          </small>
                        </span>
                      </button>
                    ))}
                    {nextPage && (
                      <button
                        className="button ghost small firebase-more"
                        disabled={loading === "documents"}
                        onClick={() => void loadDocuments(collection, nextPage)}
                      >
                        {loading === "documents" ? <Spinner /> : null}
                        Cargar más
                      </button>
                    )}
                  </>
                ) : (
                  <p className="firebase-empty">Esta colección está vacía.</p>
                )}
              </div>
            </section>
            <section className="firebase-column editor">
              {documentPath ? (
                <DocumentEditor
                  key={documentPath}
                  path={documentPath}
                  notify={notify}
                  onBack={() => setDocumentPath("")}
                  onSubcollection={(name) =>
                    openSubcollection(documentPath, name)
                  }
                  onChanged={() => void loadDocuments(collection)}
                  onDeleted={() => {
                    setDocumentPath("");
                    void loadDocuments(collection);
                  }}
                />
              ) : (
                <Empty
                  icon={<FileJson size={28} />}
                  title="Ningún documento abierto"
                >
                  Selecciona un documento para ver y editar sus campos.
                </Empty>
              )}
            </section>
          </div>
        </>
      )}
      {creating && (
        <NewDocument
          collection={collection}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            notify("Documento creado.");
            void loadDocuments(collection);
            setDocumentPath(created.path);
          }}
        />
      )}
    </main>
  );
}

function DocumentEditor({
  path,
  notify,
  onBack,
  onSubcollection,
  onChanged,
  onDeleted,
}: {
  path: string;
  notify: ToastFn;
  onBack: () => void;
  onSubcollection: (name: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [document, setDocument] = useState<FirestoreDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [subcollections, setSubcollections] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    let stopped = false;
    Promise.all([
      api<FirestoreDocument>(
        `/firebase/document?path=${encodeURIComponent(path)}`,
      ).catch(() => null),
      api<{ collections: string[] }>(
        `/firebase/collections?parent=${encodeURIComponent(path)}`,
      ).catch(() => ({ collections: [] })),
    ]).then(([loaded, children]) => {
      if (stopped) return;
      setDocument(loaded);
      setDraft(pretty(loaded?.data ?? {}));
      setSubcollections(children.collections);
    });
    return () => {
      stopped = true;
    };
  }, [path]);
  const dirty = document !== null && draft !== pretty(document.data);
  async function save() {
    let data: unknown;
    try {
      data = JSON.parse(draft);
    } catch {
      setError("El JSON no es válido. Revisa comas, comillas y llaves.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api<FirestoreDocument>("/firebase/document", {
        method: "PUT",
        body: JSON.stringify({ path, data }),
      });
      setDocument(saved);
      setDraft(pretty(saved.data));
      notify("Documento guardado en Firestore.");
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api(`/firebase/document?path=${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      notify("Documento eliminado.");
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <div className="firebase-editor">
      <header>
        <button
          className="icon-button firebase-back"
          aria-label="Volver a los documentos"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </button>
        <div>
          <strong>{path.split("/").pop()}</strong>
          <small>
            {document?.updateTime
              ? `Actualizado ${relativeDate(document.updateTime).toLowerCase()}`
              : document === null
                ? "Cargando…"
                : "Sin guardar todavía"}
          </small>
        </div>
      </header>
      {subcollections.length > 0 && (
        <div className="firebase-subcollections">
          <span>Subcolecciones</span>
          {subcollections.map((name) => (
            <button key={name} onClick={() => onSubcollection(name)}>
              <FolderTree size={14} /> {name}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="firebase-json"
        aria-label="Campos del documento en JSON"
        spellCheck={false}
        autoCapitalize="off"
        value={draft}
        disabled={document === null || busy}
        onChange={(e) => setDraft(e.target.value)}
      />
      <p className="firebase-hint">
        Fechas como <code>{'{"$timestamp": "2026-01-31T10:00:00Z"}'}</code> y
        referencias como <code>{'{"$reference": "usuarios/ana"}'}</code>.
        Guardar reemplaza el documento completo.
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="firebase-actions">
        {confirming ? (
          <>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? <Spinner /> : <Trash2 size={15} />} Sí, eliminar
            </button>
          </>
        ) : (
          <>
            <button
              className="button danger-outline"
              disabled={busy || document === null}
              onClick={() => setConfirming(true)}
            >
              <Trash2 size={15} /> Eliminar
            </button>
            <button
              className="button primary"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy ? <Spinner /> : <Save size={15} />} Guardar
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function NewDocument({
  collection,
  onClose,
  onCreated,
}: {
  collection: string;
  onClose: () => void;
  onCreated: (document: FirestoreDocument) => void;
}) {
  const [id, setId] = useState("");
  const [draft, setDraft] = useState('{\n  "nombre": ""\n}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Nuevo documento"
      subtitle={`En la colección ${collection}`}
      onClose={onClose}
    >
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          let data: unknown;
          try {
            data = JSON.parse(draft);
          } catch {
            setError("El JSON no es válido.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            onCreated(
              await post<FirestoreDocument>("/firebase/documents", {
                collection,
                id: id.trim(),
                data,
              }),
            );
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        <label>
          ID del documento
          <input
            autoComplete="off"
            autoCapitalize="off"
            placeholder="Déjalo vacío para generar uno automático"
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <label>
          Campos (JSON)
          <textarea
            className="firebase-json"
            rows={10}
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? <Spinner /> : <Plus size={16} />} Crear documento
        </button>
      </form>
    </Modal>
  );
}
