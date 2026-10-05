import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { appleToken, IntegrationError } from "./integrations.js";
import { getProject, httpError, projectDir, writeFile } from "./workspace.js";

const APPLE_API = "https://api.appstoreconnect.apple.com";

/** App Store Connect request that keeps Apple's own error detail. */
async function apple(pathname: string, init: RequestInit = {}): Promise<any> {
  let response: Response;
  try {
    response = await fetch(APPLE_API + pathname, {
      ...init,
      headers: {
        Authorization: `Bearer ${await appleToken()}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(
      "No se pudo contactar con App Store Connect.",
      502,
    );
  }
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* Apple answered without JSON; the status explains enough. */
  }
  if (!response.ok) {
    const detail = (body.errors ?? [])
      .map((item: any) => item.detail || item.title)
      .filter(Boolean)
      .join(" ");
    throw new IntegrationError(
      `App Store Connect respondió ${response.status}${detail ? `: ${detail}` : "."}`,
      response.status === 401 || response.status === 403 ? 422 : 502,
    );
  }
  return body;
}

export function validBundleId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value.trim()) ||
    value.trim().length > 155
  )
    throw httpError(
      400,
      "Escribe un Bundle ID válido, por ejemplo com.tuempresa.tuapp.",
    );
  return value.trim();
}

type Certificate = {
  id: string;
  name: string;
  type: string;
  expires: string | null;
  valid: boolean;
};

async function findBundle(bundleId: string) {
  const result = await apple(
    `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`,
  );
  // The filter also matches longer identifiers (extensions); keep the exact one.
  return (result.data ?? []).find(
    (item: any) => item.attributes?.identifier === bundleId,
  );
}

async function distributionCertificates(): Promise<Certificate[]> {
  const result = await apple(
    "/v1/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=50",
  );
  const now = Date.now();
  return (result.data ?? [])
    .map((item: any) => {
      const expires = item.attributes?.expirationDate ?? null;
      return {
        id: String(item.id),
        name: String(
          item.attributes?.displayName ||
            item.attributes?.name ||
            "Certificado",
        ),
        type: String(item.attributes?.certificateType ?? ""),
        expires,
        valid: !expires || Date.parse(expires) > now,
      };
    })
    .sort((a: Certificate, b: Certificate) =>
      String(b.expires).localeCompare(String(a.expires)),
    );
}

/** Everything an iOS release needs for one bundle id, read-only. */
export async function checkIosSetup(bundleIdInput: unknown) {
  const bundleId = validBundleId(bundleIdInput);
  const [bundle, certificates, apps] = await Promise.all([
    findBundle(bundleId),
    distributionCertificates(),
    apple(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=10`),
  ]);
  const app = (apps.data ?? []).find(
    (item: any) => item.attributes?.bundleId === bundleId,
  );
  let profiles: {
    id: string;
    name: string;
    type: string;
    state: string;
    expires: string | null;
  }[] = [];
  if (bundle) {
    const result = await apple(`/v1/bundleIds/${bundle.id}/profiles?limit=50`);
    profiles = (result.data ?? []).map((item: any) => ({
      id: String(item.id),
      name: String(item.attributes?.name ?? "Perfil"),
      type: String(item.attributes?.profileType ?? ""),
      state: String(item.attributes?.profileState ?? ""),
      expires: item.attributes?.expirationDate ?? null,
    }));
  }
  return {
    bundleId,
    bundle: bundle
      ? { id: String(bundle.id), name: String(bundle.attributes?.name ?? "") }
      : null,
    app: app
      ? {
          id: String(app.id),
          name: String(app.attributes?.name ?? ""),
          sku: String(app.attributes?.sku ?? ""),
        }
      : null,
    certificates,
    profiles,
  };
}

export async function registerBundleId(
  bundleIdInput: unknown,
  nameInput: unknown,
) {
  const bundleId = validBundleId(bundleIdInput);
  if (await findBundle(bundleId))
    throw httpError(409, "Ese Bundle ID ya está registrado en tu cuenta.");
  const name =
    typeof nameInput === "string" && nameInput.trim()
      ? nameInput
          .trim()
          .replace(/[^\w\s.-]/g, "")
          .slice(0, 60) || "App"
      : bundleId.split(".").pop() || "App";
  const result = await apple("/v1/bundleIds", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "bundleIds",
        attributes: { identifier: bundleId, name, platform: "IOS" },
      },
    }),
  });
  return { id: String(result.data?.id), name };
}

/** App Store profile for the bundle, signed by the newest valid distribution certificate. */
export async function createAppStoreProfile(bundleIdInput: unknown) {
  const bundleId = validBundleId(bundleIdInput);
  const bundle = await findBundle(bundleId);
  if (!bundle) throw httpError(409, "Registra primero el Bundle ID.");
  const certificate = (await distributionCertificates()).find(
    (item) => item.valid,
  );
  if (!certificate)
    throw httpError(
      409,
      "No hay un certificado de distribución válido. Créalo una vez (Codemagic puede generarlo) y vuelve a intentarlo.",
    );
  const name = `AppBuilder ${bundleId} App Store ${new Date().toISOString().slice(0, 10)}`;
  const result = await apple("/v1/profiles", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "profiles",
        attributes: { name, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundle.id } },
          certificates: {
            data: [{ type: "certificates", id: certificate.id }],
          },
        },
      },
    }),
  });
  return { id: String(result.data?.id), name, certificate: certificate.name };
}

function readText(file: string): string {
  try {
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return "";
    return fs.readFileSync(file, "utf8").slice(0, 2_000_000);
  } catch {
    return "";
  }
}

/** Reads the bundle id and display name an iOS project already declares. */
export function iosProjectInfo(projectId: string) {
  getProject(projectId);
  const directory = projectDir(projectId);
  const pubspec = readText(path.join(directory, "pubspec.yaml"));
  const flutter = /sdk:\s*flutter\b/.test(pubspec);
  const pbxproj =
    [
      path.join(directory, "ios", "Runner.xcodeproj", "project.pbxproj"),
      path.join(directory, "ios", "App", "App.xcodeproj", "project.pbxproj"),
    ]
      .map(readText)
      .find(Boolean) ?? "";
  const bundleId =
    [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([A-Za-z0-9.-]+)"?;/g)]
      .map((match) => match[1]!)
      .find((value) => !/tests?$/i.test(value)) ?? "";
  const plist = readText(path.join(directory, "ios", "Runner", "Info.plist"));
  const display =
    /<key>CFBundleDisplayName<\/key>\s*<string>([^<$]+)<\/string>/.exec(
      plist,
    )?.[1];
  const appName =
    display?.trim() ||
    /^name:\s*([A-Za-z0-9_]+)/m.exec(pubspec)?.[1]?.replace(/_/g, " ") ||
    "";
  return {
    flutter,
    bundleId,
    appName,
    hasCodemagic: fs.existsSync(path.join(directory, "codemagic.yaml")),
    integration: defaultIntegration(),
  };
}

/** The App Store Connect integration name AppBuilder's own workflow uses. */
function defaultIntegration(): string {
  const own = readText(path.resolve("codemagic.yaml"));
  return /app_store_connect:\s*([^\n#]+)/.exec(own)?.[1]?.trim() || "";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Codemagic workflows for a Flutter app: signed iOS upload and a debug APK. */
export function flutterCodemagicYaml(options: {
  appName: string;
  bundleId: string;
  integration: string;
  appleId?: string;
}): string {
  const name = options.appName || "App";
  const buildNumber = options.appleId
    ? `--build-number=$(($(app-store-connect get-latest-app-store-build-number "$APP_STORE_APPLE_ID") + 1))`
    : "";
  return `# Generado por AppBuilder. Codemagic lee este archivo de la raíz del repositorio.
workflows:
  ios-release:
    name: ${yamlString(`${name} · iOS App Store`)}
    instance_type: mac_mini_m2
    max_build_duration: 60
    integrations:
      app_store_connect: ${yamlString(options.integration)}
    environment:
      flutter: stable
      xcode: latest
      cocoapods: default
      ios_signing:
        distribution_type: app_store
        bundle_identifier: ${options.bundleId}
${options.appleId ? `      vars:\n        APP_STORE_APPLE_ID: ${options.appleId}\n` : ""}    scripts:
      - name: Dependencias de Flutter
        script: flutter pub get
      - name: Pods de iOS
        script: find . -name "Podfile" -execdir pod install \\;
      - name: Perfiles de firma
        script: xcode-project use-profiles
      - name: Compilar IPA
        script: |
          flutter build ipa --release ${buildNumber} \\
            --export-options-plist=/Users/builder/export_options.plist
    artifacts:
      - build/ios/ipa/*.ipa
      - /tmp/xcodebuild_logs/*.log
    publishing:
      app_store_connect:
        auth: integration
        # Sube a App Store Connect/TestFlight sin enviar a revisión.
        submit_to_testflight: false

  android-debug:
    name: ${yamlString(`${name} · Android debug`)}
    instance_type: linux_x2
    max_build_duration: 45
    environment:
      flutter: stable
    scripts:
      - name: Dependencias de Flutter
        script: flutter pub get
      - name: Compilar APK
        script: flutter build apk --debug
    artifacts:
      - build/app/outputs/flutter-apk/*.apk
`;
}

export function writeCodemagicConfig(
  projectId: string,
  input: {
    bundleId?: unknown;
    appName?: unknown;
    integration?: unknown;
    appleId?: unknown;
    overwrite?: unknown;
  },
) {
  const info = iosProjectInfo(projectId);
  if (!info.flutter)
    throw httpError(
      400,
      "Por ahora la configuración automática es para apps de Flutter.",
    );
  if (info.hasCodemagic && input.overwrite !== true)
    throw httpError(409, "El proyecto ya tiene un codemagic.yaml.");
  const integration =
    typeof input.integration === "string" ? input.integration.trim() : "";
  if (!integration || integration.length > 120 || /[\n\r"]/.test(integration))
    throw httpError(
      400,
      "Indica el nombre de tu integración de App Store Connect en Codemagic.",
    );
  const appleId =
    typeof input.appleId === "string" && /^\d{6,15}$/.test(input.appleId)
      ? input.appleId
      : undefined;
  const content = flutterCodemagicYaml({
    appName:
      typeof input.appName === "string"
        ? input.appName.replace(/["\n\r]/g, "").slice(0, 60)
        : info.appName,
    bundleId: validBundleId(input.bundleId ?? info.bundleId),
    integration,
    appleId,
  });
  writeFile(projectId, "codemagic.yaml", content);
  return { path: "codemagic.yaml", appleId: appleId ?? null };
}

export function createAppleRouter(): Router {
  const router = Router();
  router.post("/apple/setup/check", async (req, res) =>
    res.json(await checkIosSetup(req.body?.bundleId)),
  );
  router.post("/apple/setup/bundle", async (req, res) =>
    res
      .status(201)
      .json(await registerBundleId(req.body?.bundleId, req.body?.name)),
  );
  router.post("/apple/setup/profile", async (req, res) =>
    res.status(201).json(await createAppStoreProfile(req.body?.bundleId)),
  );
  router.get("/projects/:id/ios", (req, res) =>
    res.json(iosProjectInfo(req.params.id)),
  );
  router.post("/projects/:id/codemagic", (req, res) =>
    res.status(201).json(writeCodemagicConfig(req.params.id, req.body ?? {})),
  );
  return router;
}
