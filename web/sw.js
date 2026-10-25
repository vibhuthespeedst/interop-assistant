// Service worker: keeps the app and all its data available offline.
// A new version only takes over once every file is saved, so offline never ends up half-filled.
importScripts("sw-version.js"); // sets self.DATA_VERSION; a new value means a new version

const CACHE = `interop-mapper-${self.DATA_VERSION}`;
const SHELL = [
  "./", "index.html", "theme.js", "tokens.css", "style.css", "app.js", "lib.js", "codegen.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "data/files.json",
  "fonts/literata-roman.woff2", "fonts/literata-italic.woff2", "fonts/atkinson-next.woff2",
  "fonts/atkinson-mono.woff2", "fonts/OFL.txt",
];

async function broadcast(message) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true, type: "window" })) {
    client.postMessage(message);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const manifest = await (await fetch("data/files.json", { cache: "no-cache" })).json();
    const all = [...new Set([...SHELL, ...manifest.files])];
    for (let i = 0; i < all.length; i += 40) {
      const batch = all.slice(i, i + 40);
      // no-cache: revalidate with the server so files from different versions never mix
      await cache.addAll(batch.map((url) => new Request(url, { cache: "no-cache" })));
      await broadcast({ type: "progress", done: Math.min(i + 40, all.length), total: all.length });
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("interop-mapper-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// Cache first; anything not cached yet comes from the network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const hit = await caches.match(event.request, { cacheName: CACHE, ignoreSearch: true });
    return hit || fetch(event.request);
  })());
});
