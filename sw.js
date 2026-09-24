const CACHE = "cotrux-pages-root-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./apps/controller/app.css",
  "./apps/controller/app.js",
  "./apps/controller/icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      const cache = await caches.open(CACHE);
      cache.put(event.request, response.clone());
      return response;
    } catch {
      return (await caches.match(event.request)) || Response.error();
    }
  })());
});
