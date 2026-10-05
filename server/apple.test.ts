import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.APPBUILDER_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-apple-test-"),
);
const workspace = await import("./workspace.js");
const apple = await import("./apple.js");

function flutterProject(): string {
  const { project, directory } = workspace.reserveImportedProject({
    name: "Juego",
    url: "https://github.com/a/juego.git",
  });
  fs.mkdirSync(path.join(directory, "ios", "Runner.xcodeproj"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(directory, "ios", "Runner"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "pubspec.yaml"),
    "name: imperio_juego\ndependencies:\n  flutter:\n    sdk: flutter\n",
  );
  fs.writeFileSync(
    path.join(directory, "ios", "Runner.xcodeproj", "project.pbxproj"),
    'PRODUCT_BUNDLE_IDENTIFIER = com.jacobo.imperio.RunnerTests;\nPRODUCT_BUNDLE_IDENTIFIER = com.jacobo.imperio;\nPRODUCT_BUNDLE_IDENTIFIER = "com.jacobo.imperio";\n',
  );
  fs.writeFileSync(
    path.join(directory, "ios", "Runner", "Info.plist"),
    "<dict><key>CFBundleDisplayName</key>\n<string>Imperio</string></dict>",
  );
  workspace.completeImportedProject(project.id, "main");
  return project.id;
}

test("valida Bundle IDs", () => {
  assert.equal(apple.validBundleId(" com.jacobo.app "), "com.jacobo.app");
  for (const bad of ["app", "com..app", "com.app/../x", "com.app;rm", ""])
    assert.throws(() => apple.validBundleId(bad), Error, bad);
});

test("detecta el Bundle ID y el nombre de una app Flutter", () => {
  const id = flutterProject();
  const info = apple.iosProjectInfo(id);
  assert.equal(info.flutter, true);
  assert.equal(info.bundleId, "com.jacobo.imperio");
  assert.equal(info.appName, "Imperio");
  assert.equal(info.hasCodemagic, false);
});

test("genera codemagic.yaml para Flutter sin pisar uno existente", () => {
  const id = flutterProject();
  const written = apple.writeCodemagicConfig(id, {
    bundleId: "com.jacobo.imperio",
    appName: "Imperio",
    integration: "Codemagic AppBuilder",
    appleId: "1234567890",
  });
  assert.equal(written.appleId, "1234567890");
  const yaml = workspace.readFile(id, "codemagic.yaml").content;
  assert.match(yaml, /bundle_identifier: com\.jacobo\.imperio/);
  assert.match(yaml, /app_store_connect: "Codemagic AppBuilder"/);
  assert.match(yaml, /APP_STORE_APPLE_ID: 1234567890/);
  assert.match(yaml, /get-latest-app-store-build-number/);
  assert.match(yaml, /flutter build apk --debug/);
  assert.throws(
    () =>
      apple.writeCodemagicConfig(id, {
        bundleId: "com.jacobo.imperio",
        integration: "Codemagic AppBuilder",
      }),
    (error: Error & { status?: number }) => error.status === 409,
  );
  assert.throws(
    () =>
      apple.writeCodemagicConfig(id, {
        bundleId: "com.jacobo.imperio",
        integration: 'malo"\ninyectado: true',
        overwrite: true,
      }),
    (error: Error & { status?: number }) => error.status === 400,
  );
  const plain = apple.flutterCodemagicYaml({
    appName: "Imperio",
    bundleId: "com.jacobo.imperio",
    integration: "Codemagic AppBuilder",
  });
  assert.doesNotMatch(plain, /APP_STORE_APPLE_ID/);
});
