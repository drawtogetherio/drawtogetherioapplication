// Admin dashboard: gated to admins; stats, user management, bans, the log.
// Needs `npm run dev` with dev login on. Usage: DB_PATH=... node tests/admin.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/admin';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);
if (!process.env.DB_PATH) { console.error('Set DB_PATH so the admin script can promote a test account.'); process.exit(1); }

async function signUp(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  // 400s and refused sockets are what the bans under test produce.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[01349]|WebSocket connection/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(base + '/app');
  await page.waitForURL(/\/login/);
  await page.fill('#dev-name', name + suffix);
  await page.getByRole('button', { name: 'Dev login' }).click();
  await page.waitForSelector('#display-name');
  await page.fill('#display-name', name);
  await page.getByRole('button', { name: 'Start drawing' }).click();
  await page.waitForSelector('.home:not([hidden])');
  return page;
}
const status = (page, path) => page.evaluate(async (p) => (await fetch(p)).status, path);
const tile = async (page, label) => Number((await page.locator('.stat-tile', { hasText: label }).locator('b').innerText()).replace(/,/g, ''));
const section = (page, name) => page.locator('.admin-nav button', { hasText: name }).click();

const ada = await signUp('Ada');
const bo = await signUp('Bo');

// ---- Gated ----
check((await status(bo, '/api/admin/stats')) === 404, 'the admin API is hidden from everyone else');
await bo.goto(base + '/admin');
await bo.waitForURL(/\/404/);
await bo.getByRole('heading', { name: 'Page not found' }).waitFor();
check(true, 'so is the page: it shows the 404 page');

execSync(`npx tsx server/admin.ts admin Ada${suffix} on`, { env: process.env, stdio: 'ignore' });
await ada.reload();
await ada.waitForSelector('.home:not([hidden])');
await ada.locator('.account-btn').click();
await ada.locator('.account-pop .menu-item', { hasText: 'Admin' }).click();
await ada.waitForSelector('.stat-tile');
check(true, 'admins get an Admin link in the account menu');
check((await tile(ada, 'Accounts')) >= 2 && (await tile(ada, 'Online')) >= 2, 'overview counts accounts and who is online');

// ---- Activity shows up ----
await bo.goto(base + '/app');
await bo.waitForSelector('.home:not([hidden])');
const room = await bo.evaluate(async () => (await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Stats room', settings: { infinite: true }, share: { visibility: 'open' } }) })).json());
await bo.goto(`${base}/app?room=${room.id}`);
await bo.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
const box = await bo.locator('canvas.stage').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await bo.mouse.move(cx - 100, cy); await bo.mouse.down(); await bo.mouse.move(cx + 100, cy, { steps: 20 }); await bo.mouse.up();
await bo.keyboard.press('Control+z');
await bo.waitForTimeout(300);
await section(ada, 'Users');
await section(ada, 'Overview');
await ada.waitForSelector('.stat-tile');
check((await tile(ada, 'Strokes')) >= 1 && (await tile(ada, 'Undos')) >= 1, 'strokes and undos in rooms are counted');
check((await tile(ada, 'In rooms')) >= 1 && (await ada.locator('.admin-table', { hasText: 'Stats room' }).count()) === 1, 'live rooms are listed');
await ada.screenshot({ path: `${out}/01-overview.png` });

// ---- Manage a person ----
await section(ada, 'Users');
await ada.fill('#q', 'Bo' + suffix);
const row = ada.locator('.admin-table tr', { hasText: '@bo' + suffix });
await row.waitFor();
check((await row.innerText()).includes('online'), 'search finds them, with an online flag');
await row.locator('[data-manage]').click();
await ada.locator('[data-premium="30"]').click();
await ada.waitForSelector('.admin-toast.show');
await ada.waitForFunction((s) => document.querySelector(`.admin-table tr[data-id] td:nth-child(3)`)?.textContent.includes('until'), suffix);
check(true, 'premium for 30 days shows in the table');
await ada.locator('[data-badge="supporter"]').check();
await ada.waitForTimeout(500);
const boMe = await bo.evaluate(async () => (await fetch('/api/me')).json());
check(boMe.premium && boMe.badges.join() === 'supporter', 'they get premium and the badge at once');
await ada.screenshot({ path: `${out}/02-manage.png` });

await ada.locator('[data-ban="1"]').click();
await ada.waitForSelector('.admin-table tr .flag.banned');
await bo.waitForFunction(() => window.doodlehive.ed.room?.status !== 'open', null, { timeout: 5000 }).then(() => check(true, 'a ban drops them from the room'), () => check(false, 'a ban drops them from the room'));
check((await status(bo, '/api/me')) === 401 || (await status(bo, '/api/me')) === 403, 'and signs them out');
await ada.locator('[data-ban="0"]').click();
await ada.waitForSelector('.admin-table tr[data-id]:not(:has(.flag.banned))');
check(true, 'unban works');

// ---- IP bans ----
await section(ada, 'IP bans');
await ada.fill('[name="ip"]', '203.0.113.9');
await ada.fill('[name="reason"]', 'spam');
await ada.locator('#ban-form button').click();
await ada.waitForSelector('.admin-table tr', { hasText: '203.0.113.9' });
check(true, 'an address can be banned');
await ada.fill('[name="ip"]', 'not-an-ip');
await ada.locator('#ban-form button').click();
await ada.waitForSelector('.admin-toast.bad.show');
check(true, 'a bad address is refused');
await ada.locator('[data-ip="203.0.113.9"]').click();
await ada.waitForSelector('.admin-page .fine');
check(true, 'and removed again');

// ---- Log and delete ----
await section(ada, 'Log');
await ada.waitForSelector('.admin-table');
const log = await ada.locator('.admin-table').innerText();
check(log.includes('premium 30') && log.includes('ban') && log.includes('@Ada' + suffix), 'the log records who did what');
await section(ada, 'Users');
await ada.fill('#q', 'Bo' + suffix);
await row.waitFor();
await row.locator('[data-manage]').click();
await ada.locator('[data-delete]').click();
await ada.waitForSelector('.admin-page .fine', { hasText: 'Nobody' });
check(true, 'an account can be deleted');
check((await ada.evaluate(async () => (await fetch('/api/admin/users/u_nope', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"admin":true}' })).status)) === 404, 'unknown ids are 404');

// ---- Guests are temporary ----
const g = await fetch(base + '/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Ghost' }) });
const ghost = await g.json();
check(!/Max-Age|Expires/i.test(g.headers.get('set-cookie') ?? ''), 'a guest cookie ends with the browser');
const db = new DatabaseSync(process.env.DB_PATH);
const exp = db.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').get(ghost.id).expires_at - Date.now();
check(exp > 2.9 * 36e5 && exp < 3.1 * 36e5, 'their session lasts three hours');
const sweep = () => ada.evaluate(async () => (await fetch('/api/admin/sweep', { method: 'POST' })).json());
await sweep();
check(db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(ghost.id).n === 1, 'a sweep keeps a guest whose session is live');
db.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run(ghost.id);
await section(ada, 'Overview');
await ada.waitForSelector('#sweep');
await ada.locator('#sweep').click();
await ada.locator('.admin-toast.show', { hasText: 'Removed' }).waitFor();
const toastText = await ada.locator('.admin-toast').innerText(), left = db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(ghost.id).n;
check(toastText.includes('Removed 1 guest') && left === 0, `and removes one whose session ran out (${toastText}, left ${left})`);
db.close();

await browser.close();
if (errors.length) { console.log('page errors:', errors); failed++; }
process.exit(failed ? 1 : 0);
