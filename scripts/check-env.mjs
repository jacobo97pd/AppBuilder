import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const options = new Set(process.argv.slice(2));
const supportedOptions = new Set(["--android", "--ios", "--require-server"]);
let errors = 0;

if (existsSync(resolve(".env"))) process.loadEnvFile(resolve(".env"));

function report(status, message) {
  console.log(
    `${status === "ok" ? "[OK]" : status === "error" ? "[ERROR]" : "[INFO]"} ${message}`,
  );
  if (status === "error") errors += 1;
}

function commandVersion(command, args, label, required = false) {
  // All commands and arguments originate in this file, never from user input.
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    shell: process.platform === "win32" && command === "npm",
  });
  if (result.status === 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .trim()
      .split(/\r?\n/)[0];
    report("ok", `${label}: ${output}`);
    return true;
  }
  report(
    required ? "error" : "info",
    `${label}: no disponible en PATH${required ? "" : " (opcional)"}.`,
  );
  return false;
}

for (const option of options) {
  if (!supportedOptions.has(option))
    report("error", `Opción no reconocida: ${option}`);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
report(
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12) ? "ok" : "error",
  `Node.js ${process.versions.node}; se requiere 22.12 o superior.`,
);
commandVersion("npm", ["--version"], "npm", true);
commandVersion("git", ["--version"], "Git", true);

if (!existsSync(resolve("node_modules"))) {
  report("info", "Dependencias pendientes: ejecuta npm ci.");
}

const configuredUrl = (
  process.env.APPBUILDER_SERVER_URL || process.env.VITE_APPBUILDER_SERVER_URL
)?.trim();
if (configuredUrl) {
  try {
    const url = new URL(configuredUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("invalid server URL");
    }
    report(
      "ok",
      "URL del servidor nativo: origen HTTPS válido (valor oculto).",
    );
  } catch {
    report(
      "error",
      "APPBUILDER_SERVER_URL / VITE_APPBUILDER_SERVER_URL debe ser la raíz HTTPS, sin credenciales, parámetros ni fragmentos.",
    );
  }
} else {
  report(
    options.has("--require-server") ? "error" : "info",
    "URL del servidor nativo no definida: la app abrirá la configuración de conexión.",
  );
}

if (options.has("--android")) {
  commandVersion("java", ["-version"], "Java (se recomienda JDK 21)", true);
  const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  report(
    androidSdk && existsSync(androidSdk) ? "ok" : "error",
    "Android SDK: configura ANDROID_HOME con la ruta de un SDK instalado.",
  );
  report(
    existsSync(resolve("android")) ? "ok" : "info",
    existsSync(resolve("android"))
      ? "Proyecto Android presente."
      : "Proyecto Android pendiente: npx cap add android.",
  );
}

if (options.has("--ios")) {
  if (process.platform !== "darwin") {
    report(
      "error",
      "La compilación local de iOS requiere macOS y Xcode. Usa el workflow ios-simulator de Codemagic.",
    );
  } else {
    commandVersion("xcodebuild", ["-version"], "Xcode", true);
  }
  report(
    existsSync(resolve("ios")) ? "ok" : "info",
    existsSync(resolve("ios"))
      ? "Proyecto iOS presente."
      : "Proyecto iOS pendiente: npx cap add ios.",
  );
}

report(
  "info",
  "El diagnóstico no consulta ni imprime las claves de tus proveedores.",
);
process.exitCode = errors > 0 ? 1 : 0;
