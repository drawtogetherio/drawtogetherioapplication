// Cloud storage: free accounts keep canvases on the server up to a cap; nearing it warns, and a save that
// doesn't fit offers to move canvases to the device or to files. Premium has no cap.
// Needs the dev server (dev login) with DB_PATH set. Usage: DB_PATH=... node tests/storage.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/storage';
fs.mkdirSync(out, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH);
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const admin = (args) => execSync(`npx tsx server/admin.ts ${args}`, { stdio: 'pipe', env: process.env }).toString();
const MB = 1024 * 1024;
const setCap = (mb) => db.prepare(`INSERT INTO site (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  .run(JSON.stringify({ earlyBadge: true, freeCloudMB: mb }));

async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404|413)/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
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
const storage = (page) => page.evaluate(async () => (await fetch('/api/storage')).json());
const home = async (page) => {
  await page.locator('[aria-label="Menu"]').click();
  await page.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
  await page.waitForSelector('.home:not([hidden])');
};
async function create(page, name) {
  await page.locator('.start-btn', { hasText: 'Draw alone' }).click();
  await page.fill('#room-name', name);
  await page.getByRole('button', { name: 'Create canvas' }).click();
}
const openStorage = async (page) => {
  await page.locator('.me-pic').click();
  await page.locator('.account-pop .menu-item', { hasText: 'Preferences' }).click();
  await page.locator('.pref-group[data-group="Storage"]').click();
  await page.waitForSelector('.pref-page .storage-meter');
};
const closeModal = (page) => page.locator('.modal-head .icon-btn').last().click();

setCap(1);
const [ren, renHandle] = await person('Ren');
const renId = db.prepare('SELECT id FROM users WHERE handle = ?').get(renHandle).id;

// ---- A free account's new canvas goes to the cloud ----
await ren.locator('.create-tile').click();
check((await ren.locator('.home-card', { hasText: 'Draw alone' }).textContent()).includes('saved to your account'), 'Draw alone says it saves to the account');
await ren.keyboard.press('Escape'); await closeModal(ren).catch(() => {});
await create(ren, 'Fox study');
await ren.waitForFunction(() => window.doodlehive.ed.room?.info && !window.doodlehive.ed.room.info.ephemeral && window.doodlehive.ed.room.status === 'open');
check(/\?room=/.test(ren.url()), 'it opens as a cloud canvas');
await stroke(ren, 300); await stroke(ren, 360);
await ren.waitForTimeout(400);
let st = await storage(ren);
const fox = st.canvases[0];
check(st.cap === MB && st.canvases.length === 1 && fox.name === 'Fox study' && fox.bytes > 0, `storage counts it (${fox?.bytes} B of ${st.cap})`);
const real = db.prepare(`SELECT (SELECT sum(length(CAST(op AS BLOB))) FROM room_ops WHERE room_id = r.id) AS ops, r.bytes FROM rooms r WHERE id = ?`).get(fox.id);
check(real.bytes === real.ops, `bytes kept up to date as ops are written (${real.bytes} = ${real.ops})`);
check(await ren.locator('.save-badge.cloud').isVisible() && !(await ren.locator('.save-badge.near, .save-badge.full').count()), 'the bar shows the cloud, no warning yet');

// ---- Nearly full: the home screen and the canvas warn ----
await home(ren);
check(await ren.locator('.home-sec', { hasText: 'My canvases' }).locator('.tile-name', { hasText: 'Fox study' }).isVisible(), 'the canvas is on the home screen');
check(await ren.locator('.storage-warn').isHidden(), 'no storage warning under 80%');
db.prepare('UPDATE rooms SET bytes = ? WHERE id = ?').run(Math.round(0.85 * MB), fox.id);
await ren.reload(); await ren.waitForSelector('.home:not([hidden])');
await ren.waitForSelector('.storage-warn.near:not([hidden])');
check((await ren.locator('.storage-warn').textContent()).includes('nearly full'), 'home warns when nearly full');
await ren.screenshot({ path: `${out}/01-home-near.png` });
await ren.locator('.project-tile .tile-open', { hasText: 'Fox study' }).first().click();
await ren.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
await ren.waitForSelector('.save-badge.near');
check((await ren.locator('.save-badge .save-pill').textContent()).includes('% full'), 'the canvas bar shows how full the cloud is');
await ren.locator('.save-badge .save-pill').click();
await ren.screenshot({ path: `${out}/02-canvas-near.png` });
await home(ren);

// ---- Preferences → Storage lists the biggest canvases ----
await create(ren, 'Small sketch');
await ren.waitForFunction(() => window.doodlehive.ed.room?.info?.name === 'Small sketch' && window.doodlehive.ed.room.status === 'open');
await stroke(ren, 300);
await home(ren);
await openStorage(ren);
const names = await ren.locator('.pref-page .storage-row .storage-name strong').allTextContents();
check(names.join() === 'Fox study,Small sketch', `biggest first: ${names.join(', ')}`);
check((await ren.locator('.pref-page .storage-text').textContent()).includes('of 1.0 MB used'), 'the meter shows the cap');
await ren.screenshot({ path: `${out}/03-prefs-storage.png` });
await closeModal(ren);

// ---- Full: a new canvas offers to move canvases off the cloud ----
db.prepare('UPDATE rooms SET bytes = ? WHERE id = ?').run(Math.round(1.1 * MB), fox.id);
await ren.reload(); await ren.waitForSelector('.storage-warn.full:not([hidden])');
check((await ren.locator('.storage-warn').textContent()).includes('is full'), 'home says the cloud is full');
await create(ren, 'Third');
await ren.waitForSelector('.storage-free .storage-row');
check((await ren.locator('.modal-head h2').last().textContent()) === 'Your cloud storage is full', 'saving shows the free-up picker');
await ren.screenshot({ path: `${out}/04-free-up.png` });
// Cancel keeps the new canvas dialog open.
await closeModal(ren);
check(await ren.locator('#room-name').isVisible(), 'closing the picker goes back to the new canvas dialog');
await ren.getByRole('button', { name: 'Create canvas' }).click();
await ren.waitForSelector('.storage-free .storage-row');
await ren.locator('.storage-free label', { hasText: 'Fox study' }).locator('input').check();
check((await ren.locator('.storage-free > small').first().textContent()).includes('picked'), 'the picker sums what is picked');
await ren.getByRole('button', { name: 'Move and save' }).click();
await ren.waitForFunction(() => window.doodlehive.ed.room?.info?.name === 'Third' && window.doodlehive.ed.room.status === 'open', null, { timeout: 15000 });
check(true, 'after moving one off, the new canvas saves to the cloud');
st = await storage(ren);
check(!st.canvases.some((c) => c.name === 'Fox study') && st.canvases.some((c) => c.name === 'Third'), 'Fox study left the cloud');
await home(ren);
const foxTile = ren.locator('.home-sec', { hasText: 'My canvases' }).locator('.project-tile', { hasText: 'Fox study' });
check(await foxTile.locator('.save-mark.cache').isVisible(), 'Fox study is now a device canvas');
await foxTile.locator('.tile-open').click();
await ren.waitForFunction(() => window.doodlehive.session.local && !window.doodlehive.ed.room && window.doodlehive.ed.doc.log.length > 1);
check(await strokes(ren) >= 1 || (await dh(ren, (dh) => dh.ed.doc.log.some((op) => op.t === 'tiles'))), 'and opens with its drawing');
await home(ren);

// ---- Save as file from Preferences, then remove from the cloud ----
await openStorage(ren);
const row = ren.locator('.pref-page .storage-row', { hasText: 'Small sketch' });
const [dl] = await Promise.all([ren.waitForEvent('download'), row.getByRole('button', { name: /Save as file/ }).click()]);
check(dl.suggestedFilename() === 'Small sketch.hivecanvas', `downloads ${dl.suggestedFilename()}`);
await row.getByRole('button', { name: 'Remove from cloud' }).click();
await ren.waitForFunction(() => ![...document.querySelectorAll('.pref-page .storage-name strong')].some((e) => e.textContent === 'Small sketch'));
check(true, 'removing it takes it off the list');
await closeModal(ren);

// ---- Admin changes the cap; premium has none ----
admin(`admin ${renHandle} on`);
const patched = await ren.evaluate(async () => (await fetch('/api/admin/site', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ freeCloudMB: 3 }) })).json());
check(patched.freeCloudMB === 3 && (await storage(ren)).cap === 3 * MB, 'an admin sets the free cap from the Site page');
admin(`premium ${renHandle} forever`);
await ren.reload(); await ren.waitForSelector('.home:not([hidden])');
st = await storage(ren);
check(st.cap === null, 'premium has no cap');
await openStorage(ren);
check((await ren.locator('.pref-page .storage-text').textContent()).includes('no cap'), 'Storage says there is no cap');
await closeModal(ren);
void renId;

check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
process.exit(failed ? 1 : 0);
