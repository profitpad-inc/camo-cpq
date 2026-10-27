// v2/service-worker.js
//
// Lives one directory above cpq/ (not inside it) so its default scope is
// "/sales.californiamobility.com/" instead of "/sales.californiamobility.com/cpq/".
// A service worker only ever intercepts requests whose URL starts with its
// scope string; "/cpq" (no trailing slash) does NOT start with "/cpq/", so a
// SW scoped to "/cpq/" silently never sees — and can't offline-serve — a
// visit to the no-slash URL, only "/cpq/" itself. Scoping one level higher
// covers both, since both start with "/sales.californiamobility.com/". See
// the registration call in cpq/app.js, which points here with an absolute
// path for the same reason: a relative "./service-worker.js" resolves
// differently depending on whether the *page's own* URL has a trailing
// slash, so it can silently 404 rather than always finding this file.
const CACHE_NAME = "cpq-v2-cache-v6";

// Only pre-cache the app shell — sheets data is cached at runtime on first load.
// Keeping external URLs out of PRECACHE_URLS prevents a single fetch failure
// from aborting the entire SW install (cache.addAll is all-or-nothing).
const PRECACHE_URLS = [
  "./cpq/",
  "./cpq/index.html",
  "./cpq/styles.css",
  "./cpq/app.js",
  "./cpq/vendor/flatpickr.min.css",
  "./cpq/vendor/flatpickr.min.js",
  "./globals/global.css",
  "https://4185119.fs1.hubspotusercontent-na2.net/hubfs/4185119/Favicon%20CM.png",
  "https://4185119.fs1.hubspotusercontent-na2.net/hubfs/4185119/california%20mobility%20horizontal%20white%20background.png",
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
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          request.url.startsWith("http")
        ) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (request.mode === "navigate") {
          return caches.match("./cpq/index.html");
        }
        return Response.error();
      }
    })()
  );
});
