/* Readapaper offline service worker (vanilla, no build step).
 *
 * Strategies (GET, same-origin only):
 * - `_next/static`, icons, manifest, fonts/images: cache-first
 * - `/api/articles*`: network-first, cache fallback (offline library reads)
 * - navigations: network-first, cache fallback, `/offline` fallback
 * - everything else same-origin GET: network-first, cache fallback
 *
 * POST/PUT/DELETE (saves, progress) always hit the network — progress writes
 * made while offline are queued client-side in localStorage
 * (see lib/offline-queue.ts) and replayed on reconnect.
 *
 * Proactive warming (see lib/offline-cache.ts): the library page fetches `/`
 * plus every `/a/[id]` document while online so unopened articles are already
 * cached. On-demand visits cache the same way.
 */

const CACHE = "readapaper-v2";
const OFFLINE_URL = "/offline";
const PRECACHE_URLS = [OFFLINE_URL, "/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url))))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.ico" ||
    /\.(svg|png|jpg|jpeg|webp|gif|woff2?)$/.test(pathname)
  );
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return res;
}

async function networkFirst(request, fallback) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallback) {
      const fb = await caches.match(fallback);
      if (fb) return fb;
    }
    throw new Error("offline");
  }
}

/**
 * Prefetch a document's static assets (`/_next/static/...` CSS/JS) so pages
 * cached without ever being rendered — e.g. via proactive warming — still
 * have their stylesheets offline. Best effort; never blocks the response.
 */
async function warmDocumentAssets(response, origin) {
  try {
    const contentType = response.headers ? response.headers.get("content-type") : "";
    if (contentType && !contentType.includes("text/html")) return;
    const html = await response.clone().text();
    const urls = [
      ...new Set(Array.from(html.matchAll(/\/_next\/static\/[A-Za-z0-9._\-/]+/g), (m) => m[0])),
    ].slice(0, 50);
    if (!urls.length) return;
    const cache = await caches.open(CACHE);
    await Promise.allSettled(
      urls.map(async (pathname) => {
        const req = new Request(origin + pathname);
        if (await cache.match(req)) return;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res);
      })
    );
  } catch {
    // best effort only
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (url.pathname.startsWith("/api/articles")) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    const page = networkFirst(request, OFFLINE_URL);
    // Keep the worker alive until the document's assets are prefetched.
    event.waitUntil(page.then((res) => warmDocumentAssets(res, url.origin)).catch(() => undefined));
    event.respondWith(page);
    return;
  }

  event.respondWith(networkFirst(request));
});
