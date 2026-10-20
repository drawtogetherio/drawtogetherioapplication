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
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[1349]/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return page;
}

async function signUp(page, name, status) {
  await page.goto(base + '/app');
  await page.waitForURL(/\/login/);
  await page.fill('#dev-name', name + suffix);
  await page.getByRole('button', { name: 'Dev login' }).click();
  await page.waitForURL(/\/app/);
  await page.waitForSelector('#display-name');
  // Dev login stands in for Discord: the handle starts as the login name.
  check(await page.inputValue('#handle') === name + suffix, `${name}: handle suggested from the login name`);
  await page.fill('#display-name', name);
  if (status) await page.fill('#status', status);
  await page.getByRole('button', { name: 'Start drawing' }).click();
  await page.waitForSelector('.home:not([hidden])');
  return page.evaluate(() => window.doodlehive.ed.me.handle);
}

// ---- Landing ----
const visitor = await newPage('visitor');
await visitor.goto(base + '/');
await visitor.getByRole('heading', { name: 'Drawing together with friends' }).waitFor().then(() => check(true, 'landing headline'), () => check(false, 'landing headline'));
check(await visitor.locator('a.btn', { hasText: 'Open in browser' }).first().getAttribute('href') === '/app', 'Open in browser goes to /app');
check(await visitor.locator('header').count() === 0, 'no top nav bar');
check(await visitor.locator('.btn', { hasText: 'Download for Mac' }).count() >= 1 && await visitor.locator('.btn', { hasText: 'Download for Windows' }).count() >= 1, 'Mac and Windows download buttons');
await visitor.screenshot({ path: `${out}/01-landing.png`, fullPage: true });
const phone = await newPage('phone', { width: 390, height: 844 });
await phone.goto(base + '/');
await phone.screenshot({ path: `${out}/02-landing-phone.png`, fullPage: true });
check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on a phone');
await visitor.locator('.account-line a', { hasText: 'Log in' }).click();
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

// ---- Picture cropping ----
// 400×200 picture: left half red, right half blue. Dragging it all the way right keeps only red.
const png = Buffer.from(await ren.evaluate(async () => {
  const c = new OffscreenCanvas(400, 200); const x = c.getContext('2d');
  x.fillStyle = '#ff0000'; x.fillRect(0, 0, 200, 200); x.fillStyle = '#0000ff'; x.fillRect(200, 0, 200, 200);
  return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
}));
await ren.locator('.account-btn').click();
await ren.getByRole('button', { name: 'Edit profile' }).click();
await ren.setInputFiles('#avatar-file', { name: 'halves.png', mimeType: 'image/png', buffer: png });
const stage = await ren.locator('.crop-stage').boundingBox();
await ren.mouse.move(stage.x + 60, stage.y + 140); await ren.mouse.down();
await ren.mouse.move(stage.x + 260, stage.y + 140, { steps: 8 }); await ren.mouse.up();
await ren.screenshot({ path: `${out}/06-crop.png` });
await ren.getByRole('button', { name: 'Use picture' }).click();
await ren.waitForSelector('.avatar-edit img');
const px = await ren.evaluate(async () => {
  const b = await (await fetch(document.querySelector('.avatar-edit img').src)).blob();
  const bmp = await createImageBitmap(b); const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0); return [...x.getImageData(110, 64, 1, 1).data];
});
check(px[0] > 200 && px[2] < 60, 'cropped picture keeps the part chosen (' + px.slice(0, 3) + ')');

// ---- Handles ----
const handleState = () => ren.locator('.handle-state').textContent();
await ren.fill('#handle', '.nope');
check(/Periods/.test(await handleState()), 'bad handle explained');
await ren.fill('#handle', 'ren.draws' + suffix);
await ren.waitForFunction(() => /available/.test(document.querySelector('.handle-state').textContent));
check(true, 'free handle shows as available');
await ren.locator('#handle').scrollIntoViewIfNeeded();
await ren.screenshot({ path: `${out}/06b-handle.png` });
await ren.getByRole('button', { name: 'Save' }).click();
await ren.waitForFunction((h) => window.doodlehive.ed.me.handle === h, 'ren.draws' + suffix);
const renHandle2 = 'ren.draws' + suffix;
check(true, 'Ren picked a custom handle');

// ---- Friends ----
const bob = await newPage('bob');
await signUp(bob, 'Bob', '');
await bob.locator('.account-btn').click();
await bob.getByRole('button', { name: 'Edit profile' }).click();
await bob.fill('#handle', renHandle2.toUpperCase());
await bob.waitForFunction(() => /taken/.test(document.querySelector('.handle-state').textContent));
check(true, 'taken handle is flagged (case-insensitive)');
await bob.getByRole('button', { name: 'Save' }).click();
await bob.waitForSelector('.field-error:has-text("taken")');
check(true, 'server refuses a taken handle');
await bob.locator('.modal [title="Close"]').click();
await bob.fill('.add-friend input', '@' + renHandle2);
await bob.locator('.add-friend button').click();
await bob.waitForSelector('.friend-row.sent');
check(true, 'Bob sent a request');
await ren.evaluate(() => window.doodlehive.home.loadFriends());
await ren.waitForSelector('.friend-row.request:not(.sent)');
await ren.locator('.friend-row.request .accept').click();
await ren.waitForSelector('.friends-list .friend-row');
await bob.evaluate(() => window.doodlehive.home.loadFriends());
await bob.waitForSelector('.friends-list .friend-row.online');
check(await bob.locator('.friends-list .friend-row', { hasText: 'Sketching dragons' }).count() === 1, 'Bob sees Ren online with the status message');

// ---- Premium extras ----
if (process.env.DB_PATH) {
  execSync(`npx tsx server/admin.ts premium ${renHandle2} 30`, { stdio: 'ignore' });
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

// ---- Guests ----
// Ren shares her canvas; Kai joins from the link without Discord and gets a random handle.
const roomId0 = await ren.evaluate(async () => (await (await fetch('/api/projects')).json())[0].id);
await ren.evaluate((id) => fetch('/api/rooms/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: false }) }), roomId0);
const kai = await newPage('kai');
await kai.goto(`${base}/app?room=${roomId0}`);
await kai.waitForURL(/\/login/);
await kai.fill('#guest-name', 'Kai');
await kai.screenshot({ path: `${out}/07-guest-login.png` });
await kai.getByRole('button', { name: 'Join as guest' }).click();
await kai.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
const kaiMe = await kai.evaluate(() => window.doodlehive.ed.me);
check(kaiMe.guest && /^[A-Z][a-z]+[A-Z][a-z]+\d*$/.test(kaiMe.handle), 'guest joins the room with a random handle: @' + kaiMe.handle);
const guestCreate = await kai.evaluate(async () => (await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', settings: { infinite: true } }) })).status);
check(guestCreate === 403, 'guests can’t make canvases');
const guestHandle = await kai.evaluate(async () => (await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'kai_custom' }) })).status);
check(guestHandle === 403, 'guests can’t pick a custom handle');
await kai.locator('button.brand').click();
await kai.waitForSelector('.guest-card');
check(await kai.locator('.friends-panel').isHidden(), 'guest home has no friends list');
await kai.screenshot({ path: `${out}/08-guest-home.png` });
await ren.evaluate((id) => fetch('/api/rooms/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: true }) }), roomId0);

// A private canvas can't be opened by someone else.
const roomId = await ren.evaluate(async () => (await (await fetch('/api/projects')).json())[0].id);
await bob.goto(`${base}/app?room=${roomId}`);
await bob.waitForSelector('.home:not([hidden])', { timeout: 6000 }).then(() => check(true, 'private canvas stays private'), () => check(false, 'private canvas stays private'));

console.log(errors.length ? 'Errors:\n' + errors.join('\n') : 'No page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
