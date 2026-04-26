/* Service worker for offline-first PWA.
   Note: for a simple static app we precache core shell assets and cache-first them. */

const CACHE = "budget-buddy-v1";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/db.js",
  "/insights.js",
  "/manifest.webmanifest",
  "/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;

  // Only handle same-origin. (OCR libraries are fetched from a CDN; let the browser handle those.)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      // Cache static-ish assets; avoid caching html navigations aggressively if you later add server routes.
      if (res.ok && (req.destination === "script" || req.destination === "style" || req.destination === "image" || url.pathname.endsWith(".webmanifest"))) {
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});

