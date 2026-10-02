import { httpError } from "./workspace.js";

export type RepositoryAddress = {
  /** Clone URL without credentials. */
  url: string;
  /** Short label such as owner/repo. */
  label: string;
  /** Suggested project name. */
  name: string;
  github: boolean;
};

const segmentPattern = /^[\w.~-]+$/;

/**
 * Accepts https URLs, GitHub browser URLs and the owner/repo shorthand.
 * Local paths are only accepted when a caller opts in (tests clone fixtures).
 */
export function normalizeRepositoryUrl(
  input: unknown,
  options: { allowLocalSources?: boolean } = {},
): RepositoryAddress {
  if (typeof input !== "string" || !input.trim())
    throw httpError(400, "Indica la dirección del repositorio.");
  let value = input.trim();
  if (value.length > 500 || /[\s\x00-\x1f\x7f]/.test(value))
    throw httpError(400, "La dirección del repositorio no es válida.");
  if (options.allowLocalSources && !/^[a-z][a-z\d+.-]*:\/\//i.test(value))
    return {
      url: value,
      label: value.split(/[\\/]/).filter(Boolean).pop() || value,
      name: (value.split(/[\\/]/).filter(Boolean).pop() || "repositorio")
        .replace(/\.git$/i, "")
        .slice(0, 80),
      github: false,
    };
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}`;
  else if (/^(www\.)?github\.com\//i.test(value)) value = `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw httpError(
      400,
      "Usa una dirección HTTPS, por ejemplo https://github.com/usuario/proyecto.",
    );
  }
  if (parsed.protocol !== "https:")
    throw httpError(
      400,
      "Solo se pueden importar repositorios por HTTPS, por ejemplo https://github.com/usuario/proyecto.",
    );
  if (parsed.username || parsed.password)
    throw httpError(
      400,
      "No incluyas usuario ni contraseña en la dirección. Conecta GitHub en Conexiones para los repositorios privados.",
    );
  if (parsed.search || parsed.hash)
    throw httpError(
      400,
      "Quita los parámetros de la dirección del repositorio.",
    );
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || !segmentPattern.test(segment),
    )
  )
    throw httpError(
      400,
      "La dirección debe apuntar a un repositorio, por ejemplo https://github.com/usuario/proyecto.",
    );
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "github.com") {
    // Browser URLs such as /owner/repo/tree/main still identify owner/repo.
    const owner = segments[0]!;
    const repository = segments[1]!.replace(/\.git$/i, "");
    if (!repository)
      throw httpError(400, "La dirección del repositorio no es válida.");
    return {
      url: `https://github.com/${owner}/${repository}.git`,
      label: `${owner}/${repository}`,
      name: repository.slice(0, 80),
      github: true,
    };
  }
  const path = "/" + segments.join("/");
  const name = segments[segments.length - 1]!.replace(/\.git$/i, "");
  return {
    url: `${parsed.origin}${path}`,
    label: `${host}${path.replace(/\.git$/i, "")}`,
    name: (name || "repositorio").slice(0, 80),
    github: false,
  };
}

export function isGitHubUrl(url: string): boolean {
  return /^https:\/\/(www\.)?github\.com\//i.test(url);
}

/** Removes any credentials a remote URL may carry before it is shown or stored. */
export function publicRemoteUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return trimmed.replace(/\/\/[^/@]*@/, "//");
    }
  }
  return trimmed;
}

/** owner/repo for GitHub-style remotes, otherwise the last two path segments. */
export function remoteLabel(url: string): string {
  const clean = publicRemoteUrl(url)
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "");
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(clean);
  const path = scp
    ? scp[1]!
    : clean.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+\/?/i, "");
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || clean;
}

/** Browser link for common hosts; undefined when the remote has no web page. */
export function remoteWebUrl(url: string): string | undefined {
  const clean = publicRemoteUrl(url).replace(/\.git\/?$/i, "");
  const scp = /^git@([\w.-]+):(.+)$/.exec(clean);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return /^https:\/\//i.test(clean) ? clean : undefined;
}
