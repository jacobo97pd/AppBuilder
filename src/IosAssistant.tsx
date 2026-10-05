import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BadgeCheck,
  CircleAlert,
  FileCode2,
  Fingerprint,
  KeyRound,
  ScrollText,
  Search,
  Store,
} from "lucide-react";
import { api, errorMessage, post } from "./api";
import type { Connection, Project, ToastFn } from "./types";
import { Modal, Spinner, Tag } from "./ui";

type IosInfo = {
  flutter: boolean;
  bundleId: string;
  appName: string;
  hasCodemagic: boolean;
  integration: string;
};
type IosCheck = {
  bundleId: string;
  bundle: { id: string; name: string } | null;
  app: { id: string; name: string; sku: string } | null;
  certificates: {
    id: string;
    name: string;
    type: string;
    expires: string | null;
    valid: boolean;
  }[];
  profiles: {
    id: string;
    name: string;
    type: string;
    state: string;
    expires: string | null;
  }[];
};

const day = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("es", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(value))
    : "sin fecha";

export function IosAssistant({
  projects,
  connections,
  notify,
  onClose,
  onConnections,
}: {
  projects: Project[];
  connections: Connection[];
  notify: ToastFn;
  onClose: () => void;
  onConnections: () => void;
}) {
  const appleReady = connections.some(
    (c) => c.id === "apple" && c.status === "connected",
  );
  const [projectId, setProjectId] = useState("");
  const [info, setInfo] = useState<IosInfo | null>(null);
  const [bundleId, setBundleId] = useState("");
  const [appName, setAppName] = useState("");
  const [integration, setIntegration] = useState("");
  const [result, setResult] = useState<IosCheck | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [replace, setReplace] = useState(false);
  useEffect(() => {
    setInfo(null);
    setReplace(false);
    if (!projectId) return;
    api<IosInfo>(`/projects/${projectId}/ios`)
      .then((value) => {
        setInfo(value);
        if (value.bundleId) setBundleId(value.bundleId);
        if (value.appName) setAppName(value.appName);
        if (value.integration)
          setIntegration((current) => current || value.integration);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [projectId]);
  async function run<T>(
    name: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    setBusy(name);
    setError("");
    try {
      return await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  const check = () =>
    run("check", async () =>
      setResult(await post<IosCheck>("/apple/setup/check", { bundleId })),
    );
  const validCertificates = result?.certificates.filter((c) => c.valid) ?? [];
  const storeProfile = result?.profiles.find(
    (p) => p.type === "IOS_APP_STORE" && p.state === "ACTIVE",
  );
  return (
    <Modal
      wide
      title="Asistente de publicación iOS"
      subtitle="Comprueba y prepara en App Store Connect todo lo que necesita una app para subir builds."
      onClose={onClose}
    >
      {!appleReady ? (
        <div className="notice">
          <KeyRound size={17} />
          <div>
            <p>
              Conecta <strong>App Store Connect</strong> con una clave de API
              (rol App Manager o Admin) para que el asistente pueda trabajar.
            </p>
            <button className="button ghost small" onClick={onConnections}>
              Ir a Conexiones
            </button>
          </div>
        </div>
      ) : (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <div className="form-columns">
            <label>
              Proyecto (opcional)
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Sin proyecto</option>
                {projects.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bundle ID
              <input
                required
                autoCapitalize="off"
                spellCheck={false}
                placeholder="com.tuempresa.tuapp"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
              />
            </label>
          </div>
          {info && !info.bundleId && (
            <small className="field-hint">
              No se encontró un Bundle ID en el proyecto; escríbelo arriba.
            </small>
          )}
          <button
            className="button primary"
            disabled={!!busy || !bundleId.trim()}
          >
            {busy === "check" ? <Spinner /> : <Search size={16} />} Comprobar en
            App Store Connect
          </button>
        </form>
      )}
      {error && (
        <div className="inline-error ios-error" role="alert">
          {error}
        </div>
      )}
      {result && (
        <ol className="ios-steps">
          <li className={result.bundle ? "done" : ""}>
            <Fingerprint size={19} />
            <div>
              <strong>Identificador de la app (Bundle ID)</strong>
              <p>
                {result.bundle
                  ? `${result.bundleId} está registrado${result.bundle.name ? ` como «${result.bundle.name}»` : ""}.`
                  : `${result.bundleId} no está registrado en tu cuenta de Apple Developer.`}
              </p>
            </div>
            {result.bundle ? (
              <Tag tone="success">Listo</Tag>
            ) : (
              <button
                className="button small primary"
                disabled={!!busy}
                onClick={() =>
                  void run("bundle", async () => {
                    await post("/apple/setup/bundle", {
                      bundleId,
                      name: appName,
                    });
                    notify("Bundle ID registrado en Apple Developer.");
                    await check();
                  })
                }
              >
                {busy === "bundle" ? <Spinner /> : null} Registrar
              </button>
            )}
          </li>
          <li className={validCertificates.length ? "done" : "warning"}>
            <BadgeCheck size={19} />
            <div>
              <strong>Certificado de distribución</strong>
              <p>
                {validCertificates.length
                  ? `${validCertificates.length} ${validCertificates.length === 1 ? "válido" : "válidos"}; el más reciente caduca el ${day(validCertificates[0]!.expires)}. Un mismo certificado firma todas tus apps.`
                  : "No hay ninguno válido. Créalo una sola vez desde Codemagic (Team settings → Code signing identities → Generate certificate); sirve para todas tus apps."}
              </p>
            </div>
            <Tag tone={validCertificates.length ? "success" : "warning"}>
              {validCertificates.length ? "Listo" : "Falta"}
            </Tag>
          </li>
          <li className={storeProfile ? "done" : ""}>
            <ScrollText size={19} />
            <div>
              <strong>Perfil de App Store</strong>
              <p>
                {storeProfile
                  ? `«${storeProfile.name}», activo hasta el ${day(storeProfile.expires)}.`
                  : "Hace falta un perfil de tipo App Store que una el Bundle ID con el certificado."}
              </p>
            </div>
            {storeProfile ? (
              <Tag tone="success">Listo</Tag>
            ) : (
              <button
                className="button small primary"
                disabled={!!busy || !result.bundle || !validCertificates.length}
                title={
                  !result.bundle
                    ? "Registra antes el Bundle ID"
                    : !validCertificates.length
                      ? "Necesitas un certificado de distribución válido"
                      : undefined
                }
                onClick={() =>
                  void run("profile", async () => {
                    await post("/apple/setup/profile", { bundleId });
                    notify("Perfil de App Store creado.");
                    await check();
                  })
                }
              >
                {busy === "profile" ? <Spinner /> : null} Crear perfil
              </button>
            )}
          </li>
          <li className={result.app ? "done" : "warning"}>
            <Store size={19} />
            <div>
              <strong>App en App Store Connect</strong>
              <p>
                {result.app
                  ? `«${result.app.name}» · Apple ID ${result.app.id}.`
                  : `Apple no permite crearla por API. Créala una vez en App Store Connect (Apps → «+» → Nueva app) eligiendo el Bundle ID ${result.bundleId}, y vuelve a comprobar.`}
              </p>
            </div>
            {result.app ? (
              <Tag tone="success">Listo</Tag>
            ) : (
              <a
                className="button small secondary"
                href="https://appstoreconnect.apple.com/apps"
                target="_blank"
                rel="noreferrer"
              >
                Abrir <ArrowUpRight size={14} />
              </a>
            )}
          </li>
          {projectId && info?.flutter && (
            <li className="codemagic">
              <FileCode2 size={19} />
              <div>
                <strong>Configuración de Codemagic</strong>
                <p>
                  Genera un <code>codemagic.yaml</code> para esta app de
                  Flutter: firma automática, IPA para App Store Connect
                  {result.app ? " con número de build automático" : ""} y APK de
                  prueba.
                </p>
                <label className="ios-integration">
                  Nombre de tu integración de App Store Connect en Codemagic
                  <input
                    value={integration}
                    placeholder="Codemagic AppBuilder"
                    onChange={(e) => setIntegration(e.target.value)}
                  />
                </label>
                {info.hasCodemagic && (
                  <label className="checkbox-row compact">
                    <input
                      type="checkbox"
                      checked={replace}
                      onChange={(e) => setReplace(e.target.checked)}
                    />
                    <span>
                      Reemplazar el codemagic.yaml que ya tiene el proyecto
                    </span>
                  </label>
                )}
              </div>
              <button
                className="button small primary"
                disabled={
                  !!busy ||
                  !integration.trim() ||
                  (info.hasCodemagic && !replace)
                }
                onClick={() =>
                  void run("codemagic", async () => {
                    await post(`/projects/${projectId}/codemagic`, {
                      bundleId,
                      appName,
                      integration,
                      appleId: result.app?.id,
                      overwrite: replace,
                    });
                    setInfo({ ...info, hasCodemagic: true });
                    setReplace(false);
                    notify(
                      "codemagic.yaml añadido al proyecto. Guárdalo con un commit y súbelo a GitHub desde Cambios.",
                    );
                  })
                }
              >
                {busy === "codemagic" ? <Spinner /> : null}
                {info.hasCodemagic ? "Reemplazar" : "Generar"}
              </button>
            </li>
          )}
        </ol>
      )}
      {result && (
        <div className="notice">
          <CircleAlert size={17} />
          <p>
            Después: en Codemagic añade el repositorio una sola vez y lanza el
            workflow <strong>ios-release</strong>. La build aparecerá en
            TestFlight cuando Apple la procese.
          </p>
        </div>
      )}
    </Modal>
  );
}
