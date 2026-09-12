/**
 * Service worker: makes the app work with no network.
 *
 *  shell    -> precached on install, served from cache first
 *  data     -> stale-while-revalidate, so a new sync shows up next open
 *  images   -> cache first, trimmed to a fixed number of entries
 *  audio    -> never touched here; offline audio is stored as a Blob in
 *              IndexedDB and played through a blob: URL, which keeps HTTP Range
 *              seeking intact (a cached 200 cannot answer a Range request).
 */
// Bump on every shell change: `activate` drops caches that do not start with the
// current VERSION, so an installed PWA picks the new assets up on next launch
// instead of serving one stale load first.
const VERSION = "nil-v8";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const IMG = `${VERSION}-img`;

const SHELL_FILES = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "player.js",
  "segment.js",
  "store.js",
  "config.js",
  "manifest.webmanifest",
  "icon.svg",
];

const IMG_LIMIT = 90;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.allSettled(SHELL_FILES.map((f) => c.add(new Request(f, { cache: "reload" }))));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trim(cacheName, limit) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  if (keys.length <= limit) return;
  for (const k of keys.slice(0, keys.length - limit)) await c.delete(k);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // version.json must always come from the network: it is how the page discovers
  // that this worker is serving a stale shell. Caching it would blind the check.
  // Returning without respondWith() lets the browser handle it normally.
  if (url.pathname.endsWith("version.json")) return;

  // navigations: cached shell, refreshed in the background
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put("index.html", fresh.clone());
        return fresh;
      } catch {
        return (await caches.match("index.html")) || (await caches.match("./")) ||
               new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // our own static assets
  if (url.origin === location.origin) {
    if (url.pathname.includes("/data/s/") || url.pathname.endsWith("index.json")) {
      event.respondWith((async () => {
        const c = await caches.open(DATA);
        const hit = await c.match(req);
        const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })
          .catch(() => null);
        return hit || (await net) || new Response("{}", { status: 503 });
      })());
      return;
    }
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) {
        fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); }).catch(() => {});
        return hit;
      }
      try { return await fetch(req); }
      catch { return new Response("Offline", { status: 503 }); }
    })());
    return;
  }

  // article images
  if (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(url.pathname)) {
    event.respondWith((async () => {
      const c = await caches.open(IMG);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok) { c.put(req, r.clone()); trim(IMG, IMG_LIMIT); }
        return r;
      } catch {
        return new Response("", { status: 504 });
      }
    })());
    return;
  }

  // audio: straight to the network so Range requests and the fresh signed
  // redirect keep working
});
