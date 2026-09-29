/* Only public, fixed assets enter this cache. Project files, API responses,
 * auth state and the application bundle must always come from the network. */
const CACHE_NAME = "appbuilder-offline-v1";
const OFFLINE_URL = "/offline.html";
const STATIC_URLS = [OFFLINE_URL, "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("appbuilder-offline-") && name !== CACHE_NAME,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Never intercept runner previews, API, terminal streams or project assets.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/preview" || url.pathname.startsWith("/preview/"))
    return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const offline = await caches.match(OFFLINE_URL, {
            cacheName: CACHE_NAME,
          });
          return (
            offline ??
            new Response(
              "Sin conexión. Vuelve a conectarte para abrir AppBuilder.",
              {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
              },
            )
          );
        }
      })(),
    );
    return;
  }

  if (STATIC_URLS.includes(url.pathname) && url.search === "") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await caches.match(request, { cacheName: CACHE_NAME });
          return cached ?? Response.error();
        }
      })(),
    );
  }
});
