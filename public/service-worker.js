// public/service-worker.js
const CACHE_NAME = "cpq-cache-v4";

// Only pre-cache the app shell — sheets data is cached at runtime on first load.
// Keeping external URLs out of PRECACHE_URLS prevents a single fetch failure
// from aborting the entire SW install (cache.addAll is all-or-nothing).
const PRECACHE_URLS = [
  "/camo-cpq/",
  "/camo-cpq/index.html",
  "/camo-cpq/favicon-32x32.png",
];

// Install: pre-cache app shell
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

// Activate: clear old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => key !== CACHE_NAME && caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// Fetch: network-first, fall back to cache
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.status === 200) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (request.mode === "navigate") {
          return caches.match("/camo-cpq/index.html");
        }
        return Response.error();
      }
    })()
  );
});
