import "dotenv/config";
import { createApp } from "./app.js";
import { cleanupInterruptedImports, ensureSeedProject } from "./workspace.js";
import { shutdownJobs } from "./jobs.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4310);
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  if (
    !process.env.APPBUILDER_ACCESS_TOKEN ||
    process.env.APPBUILDER_ACCESS_TOKEN.length < 32 ||
    !process.env.APPBUILDER_PUBLIC_ORIGIN?.startsWith("https://")
  ) {
    throw new Error(
      "El acceso remoto requiere APPBUILDER_ACCESS_TOKEN de al menos 32 caracteres y APPBUILDER_PUBLIC_ORIGIN con HTTPS.",
    );
  }
}
cleanupInterruptedImports();
ensureSeedProject();
const server = createApp().listen(port, host, () => {
  console.log(`AppBuilder disponible en http://${host}:${port}`);
  console.log(
    "Entorno personal: los comandos se ejecutan con los permisos de este usuario.",
  );
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    try {
      await shutdownJobs();
      process.exit(0);
    } catch {
      console.error(
        "No se pudo confirmar la detención de todas las tareas. Revisa los procesos del servidor.",
      );
      process.exit(1);
    }
  });
