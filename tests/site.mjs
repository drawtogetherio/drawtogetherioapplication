// Landing page, login page, and the /app home (friends, recent canvases, create new).
// Needs `npm run dev` with dev login on; DB_PATH must match the server's database (for the premium step).
// Usage: DB_PATH=... node tests/site.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/site';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);

async function newPage(name, viewport = { width: 1280, height: 820 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[134]/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return page;
}

async function signUp(page, name, status) {
  await page.goto(base + '/app');
  await page.waitForURL(/\/login/);
  await page.fill('#dev-name', name + suffix);
  await page.getByRole('button', { name: 'Dev login' }).click();
  await page.waitForURL(/\/app/);
  await page.waitForSelector('#display-name');
  await page.fill('#display-name', name);
  if (status) await page.fill('#status', status);
  await page.getByRole('button', { name: 'Start drawing' }).click();
  await page.waitForSelector('.home:not([hidden])');
  return page.evaluate(() => window.doodlehive.ed.me.handle);
}

// ---- Landing ----
const visitor = await newPage('visitor');
await visitor.goto(base + '/');
check(await visitor.getByRole('heading', { name: 'Drawing together with friends' }).isVisible(), 'landing headline');
check(await visitor.locator('a.btn', { hasText: 'Open in browser' }).first().getAttribute('href') === '/app', 'Open in browser goes to /app');
check(await visitor.locator('.btn', { hasText: 'Download for Mac' }).count() >= 1 && await visitor.locator('.btn', { hasText: 'Download for Windows' }).count() >= 1, 'Mac and Windows download buttons');
await visitor.screenshot({ path: `${out}/01-landing.png`, fullPage: true });
const phone = await newPage('phone', { width: 390, height: 844 });
await phone.goto(base + '/');
await phone.screenshot({ path: `${out}/02-landing-phone.png`, fullPage: true });
check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on a phone');
await visitor.locator('header a', { hasText: 'Log in' }).click();
await visitor.waitForURL(/\/login/);
await visitor.waitForSelector('#dev-name');
await visitor.screenshot({ path: `${out}/03-login.png` });

// ---- Sign up + home ----
const ren = await newPage('ren');
const renHandle = await signUp(ren, 'Ren', 'Sketching dragons');
check(await ren.locator('.create-tile').isVisible(), 'home shows a Create new tile first');
check(await ren.locator('.plus-btn').isVisible(), 'home has a + button');

// Create a private canvas, draw, come back home: the tile has a thumbnail.
await ren.locator('.create-tile').click();
await ren.locator('.home-card', { hasText: 'Draw alone' }).click();
await ren.fill('#room-name', 'Dragon sketch');
await ren.getByRole('button', { name: 'Create canvas' }).click();
await ren.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
check(await ren.evaluate(() => window.doodlehive.ed.room.info.private), 'Draw alone makes a private canvas');
check(await ren.locator('.share-btn').isVisible(), 'private canvas shows a Share button');
const box = await ren.locator('canvas.stage').boundingBox();
await ren.mouse.move(box.x + 300, box.y + 300); await ren.mouse.down();
for (let i = 0; i < 25; i++) await ren.mouse.move(box.x + 300 + i * 14, box.y + 300 + Math.sin(i / 3) * 60);
await ren.mouse.up();
await ren.locator('button.brand').click();
await ren.waitForSelector('.home:not([hidden]) .project-tile img', { timeout: 8000 })
  .then(() => check(true, 'canvas thumbnail on the home screen'), () => check(false, 'canvas thumbnail on the home screen'));
check(await ren.locator('.project-tile .tile-name', { hasText: 'Dragon sketch' }).count() === 1, 'recent canvas listed by name');

// ---- Friends ----
const bob = await newPage('bob');
await signUp(bob, 'Bob', '');
await bob.fill('.add-friend input', '@' + renHandle);
await bob.locator('.add-friend button').click();
await bob.waitForSelector('.friend-row.sent');
check(true, 'Bob sent a request');
await ren.evaluate(() => window.doodlehive.home.loadFriends());
await ren.waitForSelector('.friend-row.request:not(.sent)');
await ren.locator('.friend-row.request .accept').click();
await ren.waitForSelector('.friends-list .friend-row');
await bob.evaluate(() => window.doodlehive.home.loadFriends());
await bob.waitForSelector('.friends-list .friend-row.online');
check(await bob.locator('.friends-list .friend-row', { hasText: 'Sketching dragons' }).count() === 1, 'Bob sees Ren online with her status');

// ---- Premium extras ----
if (process.env.DB_PATH) {
  execSync(`npx tsx server/admin.ts premium ${renHandle} 30`, { stdio: 'ignore' });
  await ren.evaluate(async () => {
    const r = await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gradient: ['#ff7eb3', '#7c5cff'] }) });
    if (!r.ok) throw new Error('gradient save failed');
  });
  await bob.evaluate(() => window.doodlehive.home.loadFriends());
  await bob.waitForSelector('.friends-list .friend-row.has-gradient');
  check(await bob.locator('.friends-list .friend-row .badges svg').count() >= 1, 'premium friend shows the star and gradient');
  // Plain users can't set a gradient.
  const status = await bob.evaluate(async () => (await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gradient: ['#000000', '#ffffff'] }) })).status);
  check(status === 403, 'gradient is premium-only on the server');
}
await bob.screenshot({ path: `${out}/04-home-friends.png` });
await ren.evaluate(() => window.doodlehive.home.loadFriends());
await ren.screenshot({ path: `${out}/05-home-ren.png` });

// A private canvas can't be opened by someone else.
const roomId = await ren.evaluate(async () => (await (await fetch('/api/projects')).json())[0].id);
await bob.goto(`${base}/app?room=${roomId}`);
await bob.waitForSelector('.home:not([hidden])', { timeout: 6000 }).then(() => check(true, 'private canvas stays private'), () => check(false, 'private canvas stays private'));

console.log(errors.length ? 'Errors:\n' + errors.join('\n') : 'No page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
