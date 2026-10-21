// Sharing, friends joining from their list, live status, join approval and invites.
// Needs `npm run dev` with dev login on.
// Usage: node tests/share.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/share';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);

async function newPage(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[1349]/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return page;
}

async function signUp(name) {
  const page = await newPage(name);
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
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, path, body]);
const share = (page, id, s) => api(page, 'PATCH', '/api/rooms/' + id, { share: { visibility: 'open', requireLogin: false, friendsCanJoin: true, approveJoins: false, ...s } });
const status = (page) => page.evaluate(() => window.doodlehive.ed.room?.status ?? null);
const hanaRow = (page) => page.locator('.friends-list .friend-row', { hasText: 'Hana' });

// ---- Friends ----
const hana = await signUp('Hana');
const finn = await signUp('Finn');
const sam = await signUp('Sam');
await api(finn, 'POST', '/api/friends', { handle: 'Hana' + suffix });
const finnId = await finn.evaluate(() => window.doodlehive.ed.me.id);
await api(hana, 'POST', `/api/friends/${finnId}/accept`);
await hana.evaluate(() => window.doodlehive.home.loadFriends());
await finn.evaluate(() => window.doodlehive.home.loadFriends());
await hanaRow(finn).waitFor();

// ---- Live status ----
await finn.locator('.me-presence').click();
await finn.locator('.presence-pop .menu-item', { hasText: 'Do not disturb' }).click();
const finnRow = hana.locator('.friends-list .friend-row', { hasText: 'Finn' });
await finnRow.and(hana.locator('.dnd')).waitFor({ timeout: 5000 }).then(() => check(true, 'Hana sees Finn go Do not disturb live'), () => check(false, 'Hana sees Finn go Do not disturb live'));
await hana.screenshot({ path: `${out}/01-presence.png` });
await finn.locator('.me-presence').click();
await finn.locator('.presence-pop .menu-item', { hasText: 'Offline' }).click();
await finnRow.and(hana.locator('.offline')).waitFor({ timeout: 5000 }).then(() => check(true, 'Offline hides Finn'), () => check(false, 'Offline hides Finn'));
await finn.locator('.me-presence').click();
await finn.locator('.presence-pop .menu-item', { hasText: 'Online' }).click();
await finnRow.and(hana.locator('.online')).waitFor({ timeout: 5000 }).then(() => check(true, 'back Online'), () => check(false, 'back Online'));

// ---- Share a room for friends ----
await hana.locator('.create-tile').click();
await hana.locator('.home-card', { hasText: 'Shared room' }).click();
await hana.fill('#room-name', 'Ink club');
check(await hana.locator('.share-choice').count() === 3, 'new room asks who can join');
check(await hana.locator('#share-approveJoins').isVisible(), 'open link shows its switches');
await hana.locator('.share-choice[data-v="friends"]').click();
check(await hana.locator('#share-approveJoins').isHidden(), 'friends only hides them');
await hana.screenshot({ path: `${out}/02-new-room.png` });
await hana.getByRole('button', { name: 'Create room' }).click();
await hana.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
const roomId = await hana.evaluate(() => window.doodlehive.ed.room.id);
check(await hana.evaluate(() => window.doodlehive.ed.room.info.share.visibility) === 'friends', 'room is friends only');

await hanaRow(finn).locator('.join-btn').waitFor({ timeout: 5000 }).then(() => check(true, 'Finn sees a Join button on Hana'), () => check(false, 'Finn sees a Join button on Hana'));
await finn.screenshot({ path: `${out}/03-friend-join.png` });

await sam.goto(`${base}/app?room=${roomId}`);
await sam.waitForFunction(() => window.doodlehive.ed.room === null || window.doodlehive.ed.room?.status === 'closed', null, { timeout: 5000 }).catch(() => {});
check(await sam.locator('.toast', { hasText: 'friends can join' }).count() === 1, 'non-friend is turned away');

// ---- Unlisted: online, but no Join ----
await share(hana, roomId, { visibility: 'unlisted' });
await hanaRow(finn).locator('.join-btn').waitFor({ state: 'detached', timeout: 5000 }).then(() => check(true, 'unlisted: no Join button'), () => check(false, 'unlisted: no Join button'));
check(await hanaRow(finn).evaluate((el) => el.classList.contains('online')), 'unlisted: still shows online');

// ---- Open link, friends can't join from list ----
await share(hana, roomId, { friendsCanJoin: false });
await finn.waitForTimeout(800);
check(await hanaRow(finn).locator('.join-btn').count() === 0, 'open without friends-can-join: no Join button');
await share(hana, roomId, {});
await hanaRow(finn).locator('.join-btn').waitFor({ timeout: 5000 }).then(() => check(true, 'open: Join button back'), () => check(false, 'open: Join button back'));

// ---- Logged-in only ----
await share(hana, roomId, { requireLogin: true });
const guest = await newPage('guest');
await guest.goto(`${base}/app?room=${roomId}`);
await guest.waitForURL(/\/login/);
await guest.fill('#guest-name', 'Gus');
await guest.getByRole('button', { name: 'Join as guest' }).click();
await guest.locator('.toast', { hasText: 'Log in' }).waitFor({ timeout: 5000 }).then(() => check(true, 'guest blocked by logged-in only'), () => check(false, 'guest blocked by logged-in only'));

// ---- Approve joins ----
await share(hana, roomId, { approveJoins: true });
await sam.goto(`${base}/app?room=${roomId}`);
await sam.waitForFunction(() => window.doodlehive.ed.room?.status === 'waiting');
check(await sam.locator('.modal', { hasText: 'Waiting to join' }).isVisible(), 'Sam waits for the host');
const req = hana.locator('.join-request', { hasText: 'wants to join the session' });
await req.waitFor({ timeout: 5000 }).then(() => check(true, 'host sees the join request in chat'), () => check(false, 'host sees the join request in chat'));
await hana.screenshot({ path: `${out}/04-join-request.png` });
await sam.screenshot({ path: `${out}/05-waiting.png` });
await req.locator('.allow').click();
await sam.waitForFunction(() => window.doodlehive.ed.room?.status === 'open', null, { timeout: 5000 }).then(() => check(true, 'Allow lets Sam in'), () => check(false, 'Allow lets Sam in'));
check(await req.count() === 0, 'request line goes away');

await share(hana, roomId, { approveJoins: true });
await guest.goto(`${base}/app?room=${roomId}`);
await guest.waitForFunction(() => window.doodlehive.ed.room?.status === 'waiting');
await req.waitFor();
await req.locator('.deny').click();
await guest.locator('.toast', { hasText: 'didn’t let you in' }).waitFor({ timeout: 5000 }).then(() => check(true, 'Deny turns the guest away'), () => check(false, 'Deny turns the guest away'));
check(await guest.evaluate(() => window.doodlehive.ed.room) === null, 'guest is back home');

// ---- Invite from the canvas ----
await hana.getByRole('button', { name: 'Invite friends' }).click();
const inviteRow = hana.locator('.invite-pop .invite-row', { hasText: 'Finn' });
await inviteRow.waitFor();
await hana.screenshot({ path: `${out}/06-invite.png` });
await inviteRow.getByRole('button', { name: 'Invite' }).click();
await finn.locator('.invite-toast', { hasText: 'Ink club' }).waitFor({ timeout: 5000 }).then(() => check(true, 'Finn gets the invite'), () => check(false, 'Finn gets the invite'));
await finn.screenshot({ path: `${out}/07-invited.png` });
await finn.locator('.invite-toast').getByRole('button', { name: 'Join' }).click();
await finn.waitForFunction(() => window.doodlehive.ed.room?.status === 'open', null, { timeout: 5000 }).then(() => check(true, 'invited friend skips approval'), () => check(false, 'invited friend skips approval'));

// Non-hosts don't get the invite button.
check(await sam.getByRole('button', { name: 'Invite friends' }).count() === 0, 'only the host can invite');

await browser.close();
if (errors.length) { console.log('Page errors:\n' + errors.join('\n')); failed++; } else console.log('No page errors');
process.exit(failed ? 1 : 0);
