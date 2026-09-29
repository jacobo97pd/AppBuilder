import { defineConfig } from "@playwright/test";
import path from "node:path";

// Every run gets a dedicated directory; E2E must never open the user's projects.
const dataDirectory = path.resolve(
  ".cache",
  "e2e-data",
  `${Date.now()}-${process.pid}`,
);
const baseURL = "http://127.0.0.1:4317";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "es-ES",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: "node node_modules/tsx/dist/cli.mjs server/index.ts",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      HOST: "127.0.0.1",
      PORT: "4317",
      NODE_ENV: "test",
      APPBUILDER_DATA_DIR: dataDirectory,
      APPBUILDER_ACCESS_TOKEN: "",
      APPBUILDER_PUBLIC_ORIGIN: "",
      APPBUILDER_VAULT_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      CODEMAGIC_API_TOKEN: "",
      APPLE_ISSUER_ID: "",
      APPLE_KEY_ID: "",
      APPLE_PRIVATE_KEY: "",
      GOOGLE_SERVICE_ACCOUNT_JSON: "",
      GITHUB_TOKEN: "",
    },
  },
});
