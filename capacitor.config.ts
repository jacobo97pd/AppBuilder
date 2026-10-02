import type { CapacitorConfig } from "@capacitor/cli";

// Package the UI; the native setup screen connects it to an HTTPS backend.
// APPBUILDER_SERVER_URL is a build input mapped to VITE_APPBUILDER_SERVER_URL
// by Codemagic. No server, workspace, access token or provider key is bundled.

const config: CapacitorConfig = {
  appId: "dev.appbuilder.studio",
  appName: "AppBuilder",
  webDir: "dist",
  backgroundColor: "#f6f6fb",
  server: {
    androidScheme: "https",
    cleartext: false,
    errorPath: "offline.html",
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#f6f6fb",
  },
  ios: {
    backgroundColor: "#f6f6fb",
    contentInset: "automatic",
  },
};

export default config;
