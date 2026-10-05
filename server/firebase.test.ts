import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.APPBUILDER_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-firebase-test-"),
);
const firebase = await import("./firebase.js");

const root = "projects/demo/databases/(default)/documents/";

test("convierte valores de Firestore a JSON editable y de vuelta sin perder tipos", () => {
  const fields = {
    nombre: { stringValue: "Ana" },
    nivel: { integerValue: "12" },
    enorme: { integerValue: "9007199254740993" },
    ratio: { doubleValue: 0.5 },
    entero: { doubleValue: 3 },
    activo: { booleanValue: true },
    vacio: { nullValue: null },
    alta: { timestampValue: "2026-01-31T10:00:00Z" },
    avatar: { bytesValue: "aGVsbG8=" },
    amigo: { referenceValue: `${root}usuarios/luis` },
    casa: { geoPointValue: { latitude: 40.4, longitude: -3.7 } },
    etiquetas: {
      arrayValue: { values: [{ stringValue: "a" }, { integerValue: "1" }] },
    },
    perfil: { mapValue: { fields: { bio: { stringValue: "Hola" } } } },
  };
  const json = firebase.fromFields(fields, root);
  assert.deepEqual(json, {
    nombre: "Ana",
    nivel: 12,
    enorme: { $integer: "9007199254740993" },
    ratio: 0.5,
    entero: { $double: 3 },
    activo: true,
    vacio: null,
    alta: { $timestamp: "2026-01-31T10:00:00Z" },
    avatar: { $bytes: "aGVsbG8=" },
    amigo: { $reference: "usuarios/luis" },
    casa: { $geopoint: { latitude: 40.4, longitude: -3.7 } },
    etiquetas: ["a", 1],
    perfil: { bio: "Hola" },
  });
  const back = firebase.toFields(JSON.parse(JSON.stringify(json)), root);
  assert.deepEqual(back, {
    ...fields,
    entero: { doubleValue: 3 },
    etiquetas: {
      arrayValue: { values: [{ stringValue: "a" }, { integerValue: "1" }] },
    },
  });
  assert.throws(() => firebase.toFirestore({ $timestamp: "ayer" }, root));
  assert.throws(() =>
    firebase.toFirestore({ $geopoint: { latitude: "x" } }, root),
  );
});

test("valida rutas de colecciones y documentos", () => {
  assert.deepEqual(firebase.firestorePath("usuarios", "collection"), [
    "usuarios",
  ]);
  assert.deepEqual(firebase.firestorePath("/usuarios/ana/", "document"), [
    "usuarios",
    "ana",
  ]);
  assert.deepEqual(firebase.firestorePath("", "parent"), []);
  for (const [value, kind] of [
    ["usuarios/ana", "collection"],
    ["usuarios", "document"],
    ["usuarios//ana", "document"],
    ["usuarios/..", "document"],
    ["__privado__", "collection"],
    ["", "collection"],
  ] as const)
    assert.throws(() => firebase.firestorePath(value, kind), Error, value);
});
