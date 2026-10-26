// Installable app: manifest, icons, and the service worker keeping the app shell offline.
// Usage: node tests/pwa.mjs http://localhost:4180   (a production build served statically)
import { chromium } from '@playwright/test';

const base = (process.argv[2] ?? 'http://localhost:4180').replace(/\/$/, '');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await ctx.newPage();
const errors = [];
let failed = 0;
page.on('pageerror', (e) => errors.push(e.message));
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };

const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
check(manifest.start_url === '/app' && manifest.display === 'standalone' && manifest.icons.length === 3, 'manifest names the app, starts at /app, standalone, three icons');
for (const i of manifest.icons) check((await fetch(base + i.src)).status === 200, `icon ${i.src} is served`);
const sw = await (await fetch(base + '/sw.js')).text();
check(sw.includes('"/app.html"') && sw.includes('/assets/'), 'sw.js lists the pages and hashed assets to keep offline');

await page.goto(base + '/app.html');
check(await page.locator('link[rel="manifest"]').count() === 1, 'the app page links the manifest');
const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.ready;
  await new Promise((res) => (navigator.serviceWorker.controller ? res() : navigator.serviceWorker.addEventListener('controllerchange', res, { once: true })));
  const keys = await caches.keys();
  const c = await caches.open(keys.find((k) => k.startsWith('doodlehive-')));
  const have = await Promise.all(['/app.html', '/index.html', '/login.html', '/manifest.webmanifest'].map(async (p) => !!(await c.match(p))));
  return { scope: r.scope, keys, have };
});
check(reg.scope === base + '/' && reg.keys.length === 1, `the service worker controls the site (${reg.keys})`);
check(reg.have.every(Boolean), 'pages and the manifest are precached');

// Offline: the app still opens, from the cache, at its pretty address too.
await ctx.setOffline(true);
await page.goto(base + '/app');
await page.waitForFunction(() => !!window.doodlehive, null, { timeout: 15000 }).then(() => check(true, 'offline, /app loads from the cache'), () => check(false, 'offline, /app loads from the cache'));
const apiBlocked = await page.evaluate(() => fetch('/api/me').then((r) => r.status, () => 'network error'));
check(apiBlocked === 'network error', `API calls are never answered from the cache (${apiBlocked})`);
await ctx.setOffline(false);
await page.goto(base + '/app.html');
await page.waitForFunction(() => !!window.doodlehive);
check(true, 'back online, the page loads again');

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `FAIL ${failed}` : 'ok');
process.exit(failed ? 1 : 0);
