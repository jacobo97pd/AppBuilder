import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { createCoreRouter } from "./core.js";
import { createIntegrationsRouter, redactSecrets } from "./integrations.js";
import { configureJobRedaction } from "./jobs.js";
import { createPreviewRouter } from "./preview.js";
import { APP_VERSION } from "../version.js";

const nativeOrigins = new Set([
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
]);
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createApp(
  options: { accessToken?: string; publicOrigin?: string } = {},
) {
  const app = express();
  configureJobRedaction(redactSecrets);
  const configuredToken =
    options.accessToken ?? process.env.APPBUILDER_ACCESS_TOKEN;
  const configuredOrigin =
    options.publicOrigin ?? process.env.APPBUILDER_PUBLIC_ORIGIN;
  let publicOrigin: string | undefined;
  if (configuredOrigin) {
    const parsed = new URL(configuredOrigin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new Error(
        "APPBUILDER_PUBLIC_ORIGIN debe ser un origen HTTPS sin credenciales ni rutas.",
      );
    }
    if (!configuredToken)
      throw new Error(
        "Configura APPBUILDER_ACCESS_TOKEN antes de habilitar un origen público.",
      );
    publicOrigin = parsed.origin;
  }
  const localToken = randomBytes(32).toString("hex");
  const publicHost = publicOrigin ? new URL(publicOrigin).host : undefined;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Cache-Control",
      req.path.startsWith("/api") ? "no-store" : "no-cache",
    );
    let requestUrl: URL;
    const host = req.headers.host;
    if (!host || !/^[a-z\d.:[\]-]+$/i.test(host))
      return res.status(400).json({ error: "Host no válido." });
    try {
      requestUrl = new URL(`http://${host}`);
    } catch {
      return res.status(400).json({ error: "Host no válido." });
    }
    if (
      !loopback.has(requestUrl.hostname) &&
      host.toLowerCase() !== publicHost?.toLowerCase()
    ) {
      return res.status(403).json({
        error: "Configura APPBUILDER_PUBLIC_ORIGIN para este dominio.",
      });
    }
    const origin = req.headers.origin;
    const sameOrigin =
      !origin ||
      origin === publicOrigin ||
      origin === `http://${req.headers.host}` ||
      origin === `https://${req.headers.host}`;
    const native = !!origin && nativeOrigins.has(origin);
    if (origin && !sameOrigin && !native)
      return res.status(403).json({ error: "Origen no permitido." });
    if (native) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-AppBuilder-Client",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS",
      );
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    if (
      req.path.startsWith("/api") &&
      req.headers["sec-fetch-site"] === "cross-site" &&
      !native
    ) {
      return res
        .status(403)
        .json({ error: "Acceso entre sitios no permitido." });
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  const authenticated = (req: Request) => {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (bearer && configuredToken && equal(bearer, configuredToken))
      return true;
    // Native clients must authenticate explicitly, never with ambient cookies.
    if (req.headers.origin && nativeOrigins.has(req.headers.origin))
      return false;
    const cookie = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("appbuilder_session="))
      ?.slice("appbuilder_session=".length);
    return !!cookie && equal(cookie, localToken);
  };
  const setSession = (res: Response) =>
    res.setHeader(
      "Set-Cookie",
      `appbuilder_session=${localToken}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400${publicOrigin?.startsWith("https:") ? "; Secure" : ""}`,
    );
  app.get("/api/session", (req, res) => {
    const isNative =
      req.headers.origin && nativeOrigins.has(req.headers.origin);
    const localAddress = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (
      !configuredToken &&
      !isNative &&
      (localAddress === "127.0.0.1" || localAddress === "::1")
    ) {
      setSession(res);
      return res.json({
        authenticated: true,
        mode: "local",
        execution: "host",
        version: APP_VERSION,
      });
    }
    res.json({
      authenticated: authenticated(req),
      mode: configuredToken ? "remote" : "local",
      execution: "host",
      version: APP_VERSION,
    });
  });
  const attempts = new Map<string, { count: number; until: number }>();
  app.post("/api/session", (req, res) => {
    if (req.headers["x-appbuilder-client"] !== "studio")
      return res.status(403).json({ error: "Falta la cabecera del cliente." });
    const ip = req.ip ?? "local";
    const record = attempts.get(ip);
    if (record && record.until > Date.now() && record.count >= 10)
      return res
        .status(429)
        .json({ error: "Demasiados intentos. Espera un minuto." });
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!configuredToken || !equal(token, configuredToken)) {
      attempts.set(ip, {
        count: record && record.until > Date.now() ? record.count + 1 : 1,
        until: Date.now() + 60_000,
      });
      return res
        .status(401)
        .json({ error: "La clave de acceso no es válida." });
    }
    attempts.delete(ip);
    setSession(res);
    res.json({
      authenticated: true,
      mode: "remote",
      execution: "host",
      version: APP_VERSION,
    });
  });
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!authenticated(req))
      return res
        .status(401)
        .json({ error: "Conecta tu servidor para continuar." });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-appbuilder-client"] !== "studio"
    ) {
      return res.status(403).json({ error: "Falta la cabecera del cliente." });
    }
    next();
  });
  app.use("/api", createCoreRouter());
  app.use("/api", createIntegrationsRouter());
  app.use("/api", createPreviewRouter());
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Esta operación no existe." });
  });
  const dist = path.resolve("dist");
  if (existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist, { index: false }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.join(dist, "index.html")),
    );
  }
  app.use(
    (
      error: Error & { status?: number; statusCode?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const status = error.status ?? error.statusCode ?? 500;
      res
        .status(status >= 400 && status < 600 ? status : 500)
        .json({ error: error.message || "No se pudo completar la operación." });
    },
  );
  return app;
}
