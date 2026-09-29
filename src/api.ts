import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();
export function serverUrl() {
  return isNative
    ? localStorage.getItem("appbuilder.server") ||
        import.meta.env.VITE_APPBUILDER_SERVER_URL ||
        ""
    : "";
}
export function setServer(url: string, token: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:")
    throw new Error("Utiliza una dirección HTTPS para tu servidor.");
  localStorage.setItem("appbuilder.server", parsed.origin);
  sessionStorage.setItem("appbuilder.token", token);
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
  const token = isNative ? sessionStorage.getItem("appbuilder.token") : null;
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
