import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();
export function serverUrl() {
  return isNative
    ? localStorage.getItem("appbuilder.server") ||
        import.meta.env.VITE_APPBUILDER_SERVER_URL ||
        ""
    : "";
}
const TOKEN_KEY = "appbuilder.token";
/** The native app keeps its access key per session, or on the device if asked. */
function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setServer(url: string, token: string, remember = true) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:")
    throw new Error("Utiliza una dirección HTTPS para tu servidor.");
  localStorage.setItem("appbuilder.server", parsed.origin);
  sessionStorage.setItem(TOKEN_KEY, token);
  // iOS may close the app in the background; a remembered key survives that.
  if (remember) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function forgetToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* Storage can be unavailable; nothing to forget then. */
  }
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = isNative ? storedToken() : null;
  const response = await fetch(`${serverUrl()}/api${path}`, {
    ...options,
    credentials: isNative ? "omit" : "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-AppBuilder-Client": "studio",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response
    .json()
    .catch(() => ({ error: "El servidor no responde con datos válidos." }));
  // An older server answers new features with a generic "unknown route".
  if (response.status === 404 && data.error === "Esta operación no existe.")
    throw new ApiError(
      "Tu servidor todavía no tiene esta función: está ejecutando una versión anterior. Reinícialo en el ordenador para usar las novedades.",
      404,
    );
  if (!response.ok)
    throw new ApiError(
      data.error || "No se pudo completar la operación.",
      response.status,
    );
  return data as T;
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Ha ocurrido un error inesperado.";
}
