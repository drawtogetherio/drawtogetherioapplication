// The app shell offline: pages and hashed assets are cached at install, pages refresh from the
// network when it answers, and /api, /ws, /auth and the like never touch the cache.
// Built into dist/sw.js by vite.config.ts, which fills in the precache list.
declare const __PRECACHE__: string[];
declare const __VERSION__: string;
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = 'doodlehive-' + __VERSION__;
const PAGES: [RegExp, string][] = [[/^\/app(\/|$)/, '/app.html'], [/^\/login\/?$/, '/login.html'], [/^\/admin(\/|$)/, '/admin.html'], [/^\/$/, '/index.html']];
const LIVE = /^\/(api|ws|auth|avatars|thumbs|og)(\/|$)/;

sw.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(__PRECACHE__)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => sw.clients.claim()));
});

sw.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || LIVE.test(url.pathname)) return;
  if (req.mode === 'navigate') { e.respondWith(page(req, url.pathname)); return; }
  if (url.pathname.startsWith('/assets/')) { e.respondWith(cached(req)); return; }
  e.respondWith(fresh(req));
});

/** Pages: the network, else the cached copy of that page. */
async function page(req: Request, p: string) {
  try {
    const r = await fetch(req);
    if (r.ok) return r;
    return (await fallback(p)) ?? r;
  } catch (err) {
    return (await fallback(p)) ?? Response.error();
  }
}
const fallback = (p: string) => caches.match(PAGES.find(([re]) => re.test(p))?.[1] ?? '/404.html');

/** Hashed assets never change: the cache, else the network, kept for next time. */
async function cached(req: Request) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) (await caches.open(CACHE)).put(req, r.clone());
  return r;
}

/** Icons and the manifest: the network, else the cache. */
async function fresh(req: Request) {
  try {
    const r = await fetch(req);
    if (r.ok) (await caches.open(CACHE)).put(req, r.clone());
    return r;
  } catch {
    return (await caches.match(req)) ?? Response.error();
  }
}
