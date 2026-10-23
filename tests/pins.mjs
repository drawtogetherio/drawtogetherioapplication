// Pinned canvases: up to five of your own saved canvases on your profile card, thumbnails public, private ones hidden. Needs the server with dev login.
// Usage: node tests/pins.mjs [http://localhost:8787]
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);
const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const login = async (name) => { const r = await call('POST', '/auth/dev', { name }); const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; await call('PATCH', '/api/me', { done: true }, cookie); return { cookie, me: await r.json() }; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBABIBA/0t7cyoAAAAAElFTkSuQmCC', 'base64');

const ren = await login('Ren' + suffix), sam = await login('Sam' + suffix);
// Free accounts' rooms end with the session, so only a premium account has canvases to pin (needs DB_PATH to match the server's).
execSync(`npx tsx server/admin.ts premium ${ren.me.handle} 30`, { stdio: 'ignore' });
const room = async (who, name, visibility = 'open') => (await call('POST', '/api/rooms', { name, settings: { infinite: true }, share: { visibility } }, who.cookie)).json();
const rooms = [];
for (let i = 1; i <= 6; i++) rooms.push(await room(ren, 'Canvas ' + i));
const secret = await room(ren, 'Secret', 'private');
const sams = await room(sam, 'Sam’s');
for (const r of [rooms[0], rooms[1], secret]) await fetch(`${base}/api/rooms/${r.id}/thumb`, { method: 'PUT', headers: { Cookie: ren.cookie, Origin: base }, body: png });

let r = await call('PATCH', '/api/me', { pinned: rooms.map((x) => x.id) }, ren.cookie);
check(r.status === 400, 'six pins are refused');
r = await call('PATCH', '/api/me', { pinned: [sams.id] }, ren.cookie);
check(r.status === 400, 'someone else’s canvas cannot be pinned');
r = await call('PATCH', '/api/me', { pinned: [rooms[1].id, secret.id, rooms[0].id] }, ren.cookie);
check(r.ok, 'pinning three of your own works ' + (r.ok ? '' : await r.text()));
let profile = await (await call('GET', `/api/users/${ren.me.id}`, undefined, sam.cookie)).json();
check(profile.pinned.map((c) => c.name).join(',') === 'Canvas 2,Canvas 1', 'the card lists them in pin order and leaves the private one out');
check(profile.pinned[0].thumb === `/pins/${rooms[1].id}?v=1`, 'with a public thumbnail link');
r = await fetch(base + profile.pinned[0].thumb);
check(r.ok && Buffer.from(await r.arrayBuffer()).equals(png) && (r.headers.get('cache-control') ?? '').startsWith('public'), 'the pinned thumbnail needs no login');
check((await fetch(`${base}/pins/${rooms[2].id}`)).status === 404, 'an unpinned canvas’s thumbnail stays private');
check((await fetch(`${base}/pins/${secret.id}`)).status === 404, 'so does a pinned private one');
await call('PATCH', `/api/rooms/${rooms[1].id}`, { share: { visibility: 'private' } }, ren.cookie);
profile = await (await call('GET', `/api/users/${ren.me.id}`, undefined, sam.cookie)).json();
check(profile.pinned.length === 1 && (await fetch(`${base}/pins/${rooms[1].id}`)).status === 404, 'making a pinned canvas private hides it');
await call('PATCH', `/api/rooms/${rooms[1].id}`, { share: { visibility: 'open' } }, ren.cookie);

// Friends, so Sam can open Ren's card from the home screen.
await call('POST', '/api/friends', { handle: ren.me.handle }, sam.cookie);
await call('POST', '/api/friends', { handle: sam.me.handle }, ren.cookie);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
const open = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await ctx.addCookies([{ name: 'dw_session', value: who.cookie.split('=')[1], url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/app`);
  await page.waitForSelector('.me-pic');
  return page;
};
const renPage = await open(ren);
await renPage.locator('.me-pic').click();
await renPage.getByRole('button', { name: 'Edit profile' }).click();
await renPage.waitForSelector('.pin-list');
check(await renPage.locator('.pin-chip').count() === 2, 'the profile dialog shows the current pins');
await renPage.locator('[aria-label="Pin a canvas"]').click();
await renPage.waitForSelector('.pin-choices');
const choices = await renPage.locator('.pin-choices .profile-pin').count();
check(choices === 4, `the picker offers the unpinned public canvases (${choices})`);
await renPage.locator('.pin-choices .profile-pin', { hasText: 'Canvas 5' }).click();
await renPage.locator('.pin-chip [aria-label="Unpin Canvas 2"]').click();
check(await renPage.locator('.pin-chip').count() === 2, 'pins can be added and removed before saving');
await renPage.getByRole('button', { name: 'Save', exact: true }).click();
await renPage.waitForSelector('.profile-form', { state: 'detached' });
profile = await (await call('GET', `/api/users/${ren.me.id}`, undefined, sam.cookie)).json();
check(profile.pinned.map((c) => c.name).join(',') === 'Canvas 1,Canvas 5', 'saving keeps the new set');

const samPage = await open(sam);
await samPage.locator('.friends-list .friend-row', { hasText: 'Ren' }).click();
await samPage.waitForSelector('.profile-card .profile-pin');
check(await samPage.locator('.profile-card .profile-pin').count() === 2, 'a friend’s card shows the pinned thumbnails');
await samPage.locator('.profile-card .profile-pin', { hasText: 'Canvas 1' }).click();
await samPage.waitForSelector('.lightbox img');
check(await samPage.locator('.lightbox-name').innerText() === 'Canvas 1', 'clicking one enlarges it');
await samPage.screenshot({ path: 'test-results/pins-lightbox.png' });
await samPage.keyboard.press('Escape');
check(await samPage.locator('.lightbox').count() === 0 && await samPage.locator('.profile-card').count() === 1, 'Escape closes the picture but keeps the card');
await browser.close();
check(!errors.length, 'no page errors ' + errors.join(' | '));

if (failed) process.exit(1);
console.log('all passed');
