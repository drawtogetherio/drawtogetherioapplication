// Free accounts keep canvases on this device; sharing opens a live-only room that closes after the host leaves.
// Needs the dev server with EPHEMERAL_GRACE_MS=1500 and DB_PATH set. Usage: DB_PATH=... node tests/local.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/local';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const admin = (args) => execSync(`npx tsx server/admin.ts ${args}`, { stdio: 'pipe', env: process.env }).toString();

async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404)/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.goto(base + '/app');
  await page.waitForURL(/\/login/);
  const handle = name + Math.floor(Math.random() * 1e6);
  await page.fill('#dev-name', handle);
  await page.getByRole('button', { name: 'Dev login' }).click();
  await page.waitForSelector('#display-name');
  await page.fill('#display-name', name);
  await page.getByRole('button', { name: 'Start drawing' }).click();
  await page.waitForSelector('.home:not([hidden])');
  return [page, handle];
}

const dh = (page, fn) => page.evaluate((src) => new Function('dh', `return (${src})(dh)`)(window.doodlehive), fn.toString());
const strokes = (page) => dh(page, (dh) => dh.ed.doc.log.filter((op) => op.t === 'stroke').length);
async function stroke(page, y) {
  const box = await page.locator('canvas.stage').boundingBox();
  await page.mouse.move(box.x + 200, box.y + y); await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 200 + i * 12, box.y + y + Math.sin(i / 2) * 20);
  await page.mouse.up();
  await page.waitForTimeout(150);
}
const projects = (page) => page.evaluate(async () => (await (await fetch('/api/projects')).json()).length);

// ---- Ren (free) draws alone: nothing reaches the server ----
const [ren] = await person('Ren');
await ren.locator('.create-tile').click();
check((await ren.locator('.home-card', { hasText: 'Draw alone' }).textContent()).includes('on this device'), 'Draw alone says the canvas stays on this device');
await ren.locator('.home-card', { hasText: 'Draw alone' }).click();
await ren.fill('#room-name', 'Fox study');
await ren.getByRole('button', { name: 'Create canvas' }).click();
await ren.waitForFunction(() => window.doodlehive.session.local && !window.doodlehive.ed.room);
check(/\?canvas=c[a-z0-9]+/.test(ren.url()), 'a device canvas has its own link');
check(await ren.locator('.share-btn').isVisible(), 'the dock offers Share');
check((await ren.locator('.save-badge.cache .save-pill').textContent()).trim() === 'In Cache', 'the bar warns the drawing is only in cache');
await ren.locator('.save-badge').hover();
check(await ren.locator('.save-badge .hint', { hasText: 'your browser may clear it' }).isVisible(), 'hovering explains and offers the app');
await ren.screenshot({ path: `${out}/00-cache-hint.png` });
await ren.mouse.move(400, 400);
await stroke(ren, 300);
await stroke(ren, 360);
check(await projects(ren) === 0, 'nothing stored on the server');
await ren.reload();
await ren.waitForFunction(() => window.doodlehive?.session.local && window.doodlehive.ed.doc.log.length > 1);
check(await strokes(ren) === 2, 'reload reopens the canvas with both strokes');
await ren.locator('[aria-label=\"Menu\"]').click(); await ren.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
await ren.waitForSelector('.home:not([hidden]) .project-tile img');
check(await ren.locator('.tile-meta', { hasText: 'On this device' }).count() === 1, 'home shows it as on this device, with a thumbnail');
check(await ren.locator('.tile-meta .save-mark.cache').count() === 1, 'the tile carries the cache warning too');
await ren.screenshot({ path: `${out}/01-home-local.png` });

// ---- Share it: a live-only room seeded with the drawing ----
await ren.locator('.tile-open').click();
await ren.waitForFunction(() => window.doodlehive.session.local && window.doodlehive.ed.doc.log.length > 2);
await ren.locator('.share-btn').click();
await ren.locator('.share-choice[data-v="open"]').click();
await ren.getByRole('dialog').getByRole('button', { name: 'Share' }).click();
await ren.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
const info = await dh(ren, (dh) => dh.ed.room.info);
check(info.ephemeral && (await strokes(ren)) === 2, 'sharing opens a live-only room with the drawing in it');
check((await dh(ren, (dh) => dh.session.local.meta.room)) === info.id, 'the device copy remembers its room');
check(await projects(ren) === 0, 'live-only rooms are not listed as server canvases');
await ren.locator('button[aria-label="Menu"]').click();
check(await ren.locator('.menu-item', { hasText: 'Stop sharing' }).isVisible(), 'the menu offers Stop sharing');
await ren.keyboard.press('Escape');

const [bob] = await person('Bob');
await bob.goto(`${base}/app?room=${info.id}`);
await bob.waitForFunction(() => window.doodlehive?.ed.room?.status === 'open');
await stroke(bob, 420);
await ren.waitForFunction(() => window.doodlehive.ed.doc.log.filter((op) => op.t === 'stroke').length === 3);
await stroke(ren, 480);
await bob.waitForFunction(() => window.doodlehive.ed.doc.log.filter((op) => op.t === 'stroke').length === 4);
await bob.waitForFunction(() => window.doodlehive.session.local);
check(true, 'a member keeps a copy of the room on their device too');
await bob.screenshot({ path: `${out}/02-member.png` });

// ---- The host leaves: the room closes after the grace period ----
await ren.locator('[aria-label=\"Menu\"]').click(); await ren.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
await ren.waitForSelector('.home:not([hidden])');
await bob.waitForFunction(() => !window.doodlehive.ed.room && window.doodlehive.session.local, null, { timeout: 8000 });
check(await bob.locator('.toast', { hasText: 'The host left' }).count() > 0, 'the member is told the host left and the copy stays');
check(/\?canvas=/.test(bob.url()) && (await strokes(bob)) === 4, 'the member carries on with the full drawing on their device');
await bob.screenshot({ path: `${out}/03-member-after-close.png` });
const gone = await ren.evaluate(async (id) => (await fetch('/api/rooms/' + id)).status, info.id);
check(gone === 404, 'the room is gone from the server');
await ren.locator('.tile-open').click();
await ren.waitForFunction(() => window.doodlehive.session.local && !window.doodlehive.ed.room && window.doodlehive.ed.doc.log.length > 4);
check(await strokes(ren) === 4 && !(await dh(ren, (dh) => dh.session.local.meta.room)), 'the host’s copy has everyone’s strokes and no room link');
await ren.locator('[aria-label=\"Menu\"]').click(); await ren.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
await bob.locator('[aria-label=\"Menu\"]').click(); await bob.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
await bob.waitForSelector('.home:not([hidden]) .project-tile');
check(await bob.locator('.tile-name', { hasText: 'Fox study' }).count() === 1, 'the member’s home lists the copy');

// ---- Premium: canvases live on the server ----
const [pia, piaHandle] = await person('Pia');
admin(`premium ${piaHandle} forever`);
await pia.reload();
await pia.waitForSelector('.home:not([hidden])');
await pia.locator('.create-tile').click();
check((await pia.locator('.home-card', { hasText: 'Draw alone' }).textContent()).includes('your account'), 'premium Draw alone saves to the account');
await pia.locator('.home-card', { hasText: 'Draw alone' }).click();
await pia.fill('#room-name', 'Cloud piece');
await pia.getByRole('button', { name: 'Create canvas' }).click();
await pia.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
check(!(await dh(pia, (dh) => dh.ed.room.info.ephemeral)) && !(await dh(pia, (dh) => dh.session.local)), 'premium canvases stay on the server');
check(await pia.locator('.save-badge.cloud').isVisible() && (await pia.locator('.save-badge.cache').count()) === 0, 'a cloud icon shows the drawing is safe');
await pia.locator('.save-badge').hover();
await pia.screenshot({ path: `${out}/05-cloud.png` });
await stroke(pia, 300);
check(await projects(pia) === 1, 'listed as a server canvas');

// ---- Premium ends: the old server canvas moves to the device when opened ----
admin(`premium ${piaHandle} off`);
await pia.goto(base + '/app');
await pia.waitForSelector('.home:not([hidden]) .project-tile');
check(await pia.locator('.tile-meta', { hasText: 'On the server' }).count() === 1, 'a free account sees the old canvas as on the server');
await pia.locator('.tile-open').click();
await pia.waitForFunction(() => window.doodlehive.ed.room?.status === 'open' && window.doodlehive.session.local);
await pia.waitForFunction(() => window.doodlehive.ed.room.info.ephemeral);
check(await projects(pia) === 0 && (await strokes(pia)) === 1, 'opening it moves the drawing to the device');
await pia.locator('[aria-label=\"Menu\"]').click(); await pia.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
await pia.waitForSelector('.home:not([hidden]) .tile-meta', { hasText: 'On this device' });
check(true, 'it now shows as on this device');
await pia.screenshot({ path: `${out}/04-moved.png` });

if (errors.length) { console.log('page errors:'); for (const e of errors) console.log('  ' + e); failed++; }
await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
