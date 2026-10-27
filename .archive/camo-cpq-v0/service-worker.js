const CACHE_NAME = "cpq-cache-v2";
const urlsToCache = [
  "/",
  "/index.html",
  "/styles/style.css",
  "/app.js",
  "/manifest.json",
  "/assets/favicon.svg",
];

// Install: pre-cache essential files
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

// Activate: clear old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => key !== CACHE_NAME && caches.delete(key)))
    )
  );
});

// Fetch: try network first, fallback to cache, update cache when online
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Successful network request → update cache
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
          console.log(`Service Worker: Updated cache → ${event.request.url}`);
          return networkResponse;
        });
      })
      .catch(() => {
        // Network failed → fallback to cache
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            console.log(`Service Worker: Loaded from cache → ${event.request.url}`);
            return cachedResponse;
          }
          // For navigation requests fallback to index.html
          if (event.request.mode === "navigate") {
            return caches.match("/index.html");
          }
        });
      })
  );
});