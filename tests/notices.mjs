// Notifications bell: friend requests, accepted requests, invites and the premium warning, live.
// Needs `npm run dev` with dev login on. Usage: DB_PATH=... node tests/notices.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/notices';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);

async function signUp(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[1349]/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
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
const api = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}, [method, path, body]);
const badge = (page) => page.locator('.bell-badge');
const expectBadge = async (page, n, msg) => {
  await badge(page).filter({ hasText: String(n) }).waitFor({ timeout: 5000 }).then(() => check(true, msg), () => check(false, msg));
};

const ida = await signUp('Ida');
const noor = await signUp('Noor');
check(await badge(ida).isHidden(), 'no badge with nothing new');

// ---- Friend request ----
await api(noor, 'POST', '/api/friends', { handle: 'Ida' + suffix });
await expectBadge(ida, 1, 'a friend request lights the bell');
await ida.screenshot({ path: `${out}/00-badge.png`, clip: { x: 1100, y: 0, width: 180, height: 60 } });
await ida.locator('.bell-btn').click();
await ida.waitForSelector('.notices-pop:not([hidden]) .notice-row');
check((await ida.locator('.notice-row').first().innerText()).includes('Noor sent you a friend request'), 'the request is listed');
await ida.screenshot({ path: `${out}/01-request.png` });
await ida.locator('.notice-row .accept').click();
await ida.waitForSelector('.friends-list .friend-row:has-text("Noor")');
check(true, 'accepting from the bell makes friends');
check(await badge(ida).isHidden(), 'opening the bell clears the badge');
await expectBadge(noor, 1, 'the sender hears the request was accepted');
await noor.locator('.bell-btn').click();
check((await noor.locator('.notice-row').first().innerText()).includes('Ida accepted your friend request'), 'the acceptance is listed');
await noor.locator('.bell-btn').click();

// ---- Invite ----
const room = await api(ida, 'POST', '/api/rooms', { name: 'Studio', settings: { infinite: true }, share: { visibility: 'open', requireLogin: false, friendsCanJoin: true, approveJoins: false } });
const noorId = await noor.evaluate(() => window.doodlehive.ed.me.id);
await api(ida, 'POST', `/api/rooms/${room.id}/invite`, { user: noorId });
await expectBadge(noor, 1, 'an invite lights the bell');
await noor.locator('.invite-toast .icon-btn').click().catch(() => {});
await noor.locator('.bell-btn').click();
const inviteRow = noor.locator('.notice-row', { hasText: 'invited you to Studio' });
check((await inviteRow.count()) === 1, 'the invite is listed');
await inviteRow.locator('.btn', { hasText: 'Join' }).click();
await noor.waitForFunction(() => window.doodlehive.ed.room?.status === 'open', null, { timeout: 8000 });
check(true, 'Join from the bell opens the room');
await noor.locator('[aria-label="Menu"]').click();
await noor.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
await noor.waitForSelector('.home:not([hidden])');

// ---- Premium about to end ----
if (process.env.DB_PATH) {
  execSync(`npx tsx server/admin.ts premium Noor${suffix} 0.5`, { env: process.env, stdio: 'ignore' });
  await noor.evaluate(() => window.doodlehive.home.loadNotices());
  await expectBadge(noor, 1, 'a premium ending soon lights the bell');
  await noor.locator('.bell-btn').click();
  check((await noor.locator('.notice-row').first().innerText()).includes('premium runs out in 12 hours'), 'the premium warning says how long is left');
  await noor.screenshot({ path: `${out}/02-premium.png` });
  await noor.locator('.notices-pop .btn', { hasText: 'Clear' }).click();
  await noor.waitForSelector('.notices-empty');
  check(true, 'Clear empties the list');
} else console.log('skip premium warning (set DB_PATH to run the admin script)');

await browser.close();
if (errors.length) { console.log('page errors:', errors); failed++; }
process.exit(failed ? 1 : 0);
