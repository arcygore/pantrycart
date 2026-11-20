const CACHE_NAME = "pantrycart-__BUILD_ID__";
const SHELL_ASSETS = [
  "/",
  "/static/css/styles.css",
  "/static/css/planner.css",
  "/static/css/recipes.css",
  "/static/js/app.js",
  "/static/js/api.js",
  "/static/js/utils.js",
  "/static/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/api/")) {
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: "no-cache" }).catch(() => caches.match(event.request))
  );
});
