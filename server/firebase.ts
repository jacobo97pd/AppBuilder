import { Router } from "express";
import {
  googleAccessToken,
  IntegrationError,
  parseServiceAccount,
  providerRequest,
  readCredentials,
} from "./integrations.js";

export const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

type FirestoreValue = Record<string, any>;
type Fields = Record<string, FirestoreValue>;

function firebaseProject(): { projectId: string; json: string } {
  const json = readCredentials("firebase").serviceAccountJson;
  const projectId = parseServiceAccount(json).project_id;
  if (!projectId)
    throw new IntegrationError(
      "La cuenta de servicio no indica el project_id de Firebase.",
    );
  return { projectId, json };
}

function databaseName(projectId: string): string {
  return `projects/${projectId}/databases/(default)`;
}

/**
 * Splits a slash path into Firestore segments. Collection paths have an odd
 * number of segments and document paths an even one.
 */
export function firestorePath(
  value: unknown,
  kind: "collection" | "document" | "parent",
): string[] {
  if (typeof value !== "string")
    throw new IntegrationError("Indica la ruta en Firestore.");
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    if (kind === "parent") return [];
    throw new IntegrationError("Indica la ruta en Firestore.");
  }
  const segments = trimmed.split("/");
  if (
    trimmed.length > 6_000 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /^__.*__$/.test(segment) ||
        /[\x00-\x1f]/.test(segment),
    )
  )
    throw new IntegrationError("La ruta de Firestore no es válida.");
  const even = segments.length % 2 === 0;
  if (kind === "collection" && even)
    throw new IntegrationError("La ruta debe apuntar a una colección.");
  if ((kind === "document" || kind === "parent") && !even)
    throw new IntegrationError("La ruta debe apuntar a un documento.");
  return segments;
}

const encodePath = (segments: string[]) =>
  segments.map((segment) => encodeURIComponent(segment)).join("/");

async function firestore(path: string, init: RequestInit = {}): Promise<any> {
  const { projectId, json } = firebaseProject();
  const token = await googleAccessToken(json, FIRESTORE_SCOPE);
  return providerRequest(
    `https://firestore.googleapis.com/v1/${databaseName(projectId)}/documents${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    },
  );
}

/** Firestore typed value → editable JSON. Types JSON cannot express keep a $marker. */
export function fromFirestore(
  value: FirestoreValue,
  documentsRoot = "",
): unknown {
  if (!value || typeof value !== "object") return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("integerValue" in value) {
    const number = Number(value.integerValue);
    return Number.isSafeInteger(number)
      ? number
      : { $integer: String(value.integerValue) };
  }
  if ("doubleValue" in value) {
    const number = Number(value.doubleValue);
    // 3.0 would read back as an integer; keep it a double explicitly.
    return Number.isFinite(number) && !Number.isInteger(number)
      ? number
      : {
          $double: Number.isFinite(number) ? number : String(value.doubleValue),
        };
  }
  if ("stringValue" in value) return String(value.stringValue);
  if ("timestampValue" in value) return { $timestamp: value.timestampValue };
  if ("bytesValue" in value) return { $bytes: value.bytesValue };
  if ("referenceValue" in value) {
    const reference = String(value.referenceValue);
    return {
      $reference:
        documentsRoot && reference.startsWith(documentsRoot)
          ? reference.slice(documentsRoot.length)
          : reference,
    };
  }
  if ("geoPointValue" in value)
    return {
      $geopoint: {
        latitude: value.geoPointValue.latitude ?? 0,
        longitude: value.geoPointValue.longitude ?? 0,
      },
    };
  if ("arrayValue" in value)
    return (value.arrayValue?.values ?? []).map((item: FirestoreValue) =>
      fromFirestore(item, documentsRoot),
    );
  if ("mapValue" in value)
    return fromFields(value.mapValue?.fields ?? {}, documentsRoot);
  return null;
}

export function fromFields(
  fields: Fields,
  documentsRoot = "",
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      fromFirestore(value, documentsRoot),
    ]),
  );
}

const markers = new Set([
  "$timestamp",
  "$double",
  "$integer",
  "$bytes",
  "$reference",
  "$geopoint",
]);

/** Editable JSON → Firestore typed value, the inverse of fromFirestore. */
export function toFirestore(
  value: unknown,
  documentsRoot = "",
): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new IntegrationError("Los números deben ser finitos.");
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value))
    return {
      arrayValue: {
        values: value.map((item) => toFirestore(item, documentsRoot)),
      },
    };
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && markers.has(entries[0]![0])) {
      const [marker, inner] = entries[0]!;
      if (marker === "$timestamp") {
        if (typeof inner !== "string" || Number.isNaN(Date.parse(inner)))
          throw new IntegrationError("$timestamp necesita una fecha ISO 8601.");
        return { timestampValue: inner };
      }
      if (marker === "$double")
        // Firestore's JSON form spells non-finite doubles as strings.
        return {
          doubleValue: ["NaN", "Infinity", "-Infinity"].includes(String(inner))
            ? String(inner)
            : Number(inner),
        };
      if (marker === "$integer") {
        if (typeof inner !== "string" && typeof inner !== "number")
          throw new IntegrationError("$integer necesita un número.");
        if (!/^-?\d+$/.test(String(inner)))
          throw new IntegrationError("$integer necesita un número entero.");
        return { integerValue: String(inner) };
      }
      if (marker === "$bytes") {
        if (typeof inner !== "string")
          throw new IntegrationError("$bytes necesita texto en base64.");
        return { bytesValue: inner };
      }
      if (marker === "$reference") {
        if (typeof inner !== "string")
          throw new IntegrationError(
            "$reference necesita la ruta de un documento.",
          );
        const path = inner.startsWith("projects/")
          ? inner
          : documentsRoot + firestorePath(inner, "document").join("/");
        return { referenceValue: path };
      }
      const point = inner as { latitude?: unknown; longitude?: unknown };
      if (
        typeof point?.latitude !== "number" ||
        typeof point?.longitude !== "number"
      )
        throw new IntegrationError("$geopoint necesita latitude y longitude.");
      return {
        geoPointValue: { latitude: point.latitude, longitude: point.longitude },
      };
    }
    return {
      mapValue: {
        fields: toFields(value as Record<string, unknown>, documentsRoot),
      },
    };
  }
  throw new IntegrationError("El documento contiene un valor no admitido.");
}

export function toFields(
  data: Record<string, unknown>,
  documentsRoot = "",
): Fields {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      toFirestore(value, documentsRoot),
    ]),
  );
}

function documentsRootFor(projectId: string): string {
  return `${databaseName(projectId)}/documents/`;
}

function summarize(document: any, root: string) {
  const name = String(document.name ?? "");
  const path = name.startsWith(root) ? name.slice(root.length) : name;
  return {
    id: path.split("/").pop() ?? path,
    path,
    // Documents that only hold subcollections have no fields of their own.
    missing: !document.fields && !document.createTime,
    createTime: document.createTime ?? null,
    updateTime: document.updateTime ?? null,
    data: fromFields(document.fields ?? {}, root),
  };
}

function documentData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IntegrationError("El documento debe ser un objeto JSON.");
  if (JSON.stringify(value).length > 900_000)
    throw new IntegrationError(
      "El documento supera el tamaño máximo de Firestore.",
    );
  return value as Record<string, unknown>;
}

export function createFirebaseRouter(): Router {
  const router = Router();
  router.get("/firebase", async (_req, res) => {
    const { projectId } = firebaseProject();
    res.json({ projectId });
  });
  router.get("/firebase/collections", async (req, res) => {
    const parent = firestorePath(req.query.parent ?? "", "parent");
    const result = await firestore(
      `${parent.length ? "/" + encodePath(parent) : ""}:listCollectionIds`,
      { method: "POST", body: JSON.stringify({ pageSize: 300 }) },
    );
    res.json({
      collections: (result.collectionIds ?? []).sort((a: string, b: string) =>
        a.localeCompare(b),
      ),
    });
  });
  router.get("/firebase/documents", async (req, res) => {
    const collection = firestorePath(req.query.collection, "collection");
    const { projectId } = firebaseProject();
    const query = new URLSearchParams({ pageSize: "50", showMissing: "true" });
    if (typeof req.query.pageToken === "string" && req.query.pageToken)
      query.set("pageToken", req.query.pageToken);
    const result = await firestore(`/${encodePath(collection)}?${query}`);
    const root = documentsRootFor(projectId);
    res.json({
      documents: (result.documents ?? []).map((item: any) =>
        summarize(item, root),
      ),
      nextPageToken: result.nextPageToken ?? null,
    });
  });
  router.get("/firebase/document", async (req, res) => {
    const path = firestorePath(req.query.path, "document");
    const { projectId } = firebaseProject();
    res.json(
      summarize(
        await firestore(`/${encodePath(path)}`),
        documentsRootFor(projectId),
      ),
    );
  });
  router.put("/firebase/document", async (req, res) => {
    const path = firestorePath(req.body?.path, "document");
    const { projectId } = firebaseProject();
    const root = documentsRootFor(projectId);
    // Without an update mask Firestore replaces the whole document.
    const result = await firestore(`/${encodePath(path)}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: toFields(documentData(req.body?.data), root),
      }),
    });
    res.json(summarize(result, root));
  });
  router.post("/firebase/documents", async (req, res) => {
    const collection = firestorePath(req.body?.collection, "collection");
    const { projectId } = firebaseProject();
    const root = documentsRootFor(projectId);
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (id) firestorePath(`${collection.join("/")}/${id}`, "document");
    const result = await firestore(
      `/${encodePath(collection)}${id ? `?documentId=${encodeURIComponent(id)}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({
          fields: toFields(documentData(req.body?.data), root),
        }),
      },
    );
    res.status(201).json(summarize(result, root));
  });
  router.delete("/firebase/document", async (req, res) => {
    const path = firestorePath(req.query.path, "document");
    await firestore(`/${encodePath(path)}`, { method: "DELETE" });
    res.json({ ok: true });
  });
  return router;
}
