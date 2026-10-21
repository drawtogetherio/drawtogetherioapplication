// Spectator links: watch and chat, nothing else. Protocol checks against the API, then the UI.
// Needs `npm run dev` with dev login on. Usage: node tests/spectate.mjs [http://localhost:5173] [http://localhost:8787]
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import fs from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const api = (process.argv[3] ?? 'http://localhost:8787').replace(/\/$/, '');
const out = 'test-results/spectate';
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Protocol ----
async function login(name) {
  const r = await fetch(api + '/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: api }, body: JSON.stringify({ name: name + suffix }) });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const me = await (await fetch(api + '/api/me', { headers: { Cookie: cookie } })).json();
  const call = (method, path, body) => fetch(api + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: api }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { cookie, id: me.id, call };
}

function connect(user, roomId, watch) {
  const ws = new WebSocket(`${api.replace('http', 'ws')}/ws/${roomId}${watch === undefined ? '' : '?watch=' + watch}`, { headers: { Cookie: user.cookie, Origin: api } });
  const messages = [];
  let closeCode = null;
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  ws.on('close', (code) => { closeCode = code; });
  ws.on('error', () => {});
  const next = (type, pred = () => true, ms = 4000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), ms);
    const look = () => { const i = messages.findIndex((m) => m.type === type && pred(m)); if (i >= 0) { clearTimeout(t); res(messages.splice(i, 1)[0]); return true; } return false; };
    if (!look()) ws.on('message', function h() { if (look()) ws.off('message', h); });
  });
  const opened = new Promise((res) => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('unexpected-response', () => res(false)); });
  const send = (m) => ws.send(JSON.stringify(m));
  return { ws, messages, next, opened, send, closed: () => closeCode };
}

const owner = await login('Owner');
const viewer = await login('Viewer');
const other = await login('Other');
const room = await (await owner.call('POST', '/api/rooms', { name: 'Watch me', settings: { infinite: true }, share: { visibility: 'open' } })).json();

const o = connect(owner, room.id);
await o.opened;
const ow = await o.next('welcome');
const key = ow.room.watchKey;
check(/^[a-z0-9]{16}$/.test(key ?? '') && ow.spectator === false, 'owner gets the watch key');
check(!('watchKey' in (await (await owner.call('GET', '/api/rooms/' + room.id)).json())), 'room info over http has no key');

const v = connect(viewer, room.id, key);
await v.opened;
const vw = await v.next('welcome');
check(vw.spectator === true && vw.room.watchKey === undefined, 'watch link joins as spectator without the key');
check(vw.members.find((m) => m.id === viewer.id)?.role === 'spectator', 'spectator role in the member list');
check(!vw.ops.some((op) => op.t === 'folder.add' && op.folder.owner === viewer.id), 'no folder is made for a spectator');
await o.next('chat', (m) => m.msg.system && m.msg.text.endsWith('is watching'));
check(true, 'room hears who is watching');

const ownFolder = ow.ops.find((op) => op.t === 'folder.add' && op.folder.owner === owner.id).folder.id;
const brush = { size: 10, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: 1, pressureFlow: 0, minSize: 0.1, smoothing: 0.3 };
v.send({ type: 'op', op: { t: 'layer.add', id: 'sp1', parent: ownFolder, index: 0, layer: { id: 'spl', name: 'L', visible: true, opacity: 1, blend: 'normal', alphaLock: false } } });
const rej = await v.next('reject');
check(rej.opId === 'sp1' && /Spectators/.test(rej.reason), 'spectator edits are refused');
v.send({ type: 'live', live: { stroke: 's1', layer: 'x', erase: false, brush, color: '#000000', pts: [0, 0, 1] } });
v.send({ type: 'cursor', x: 1, y: 1, drawing: false });
v.send({ type: 'chat', text: 'nice line' });
const chat = await o.next('chat', (m) => m.msg.text === 'nice line');
check(chat.msg.from === viewer.id, 'spectator chat reaches the room');
check(!o.messages.some((m) => m.type === 'live' || m.type === 'cursor'), 'spectator strokes and cursors go nowhere');

o.send({ type: 'op', op: { t: 'layer.add', id: 'o1', parent: ownFolder, index: 0, layer: { id: 'oly', name: 'L', visible: true, opacity: 1, blend: 'normal', alphaLock: false } } });
o.send({ type: 'op', op: { t: 'stroke', id: 'o2', layer: 'oly', erase: false, brush, color: '#000000', pts: [0, 0, 1, 5, 5, 1] } });
await v.next('op', (m) => m.op.id === 'o2');
check(true, 'spectator sees the drawing live');

const bad = connect(other, room.id, key.split('').reverse().join(''));
await bad.opened;
const badErr = await bad.next('error').catch(() => null);
await wait(200);
check(badErr && bad.closed() === 4003, 'wrong key is turned away');
const malformed = connect(other, room.id, 'nope');
check((await malformed.opened) === false, 'malformed key never upgrades');

await owner.call('PATCH', '/api/rooms/' + room.id, { share: { visibility: 'private', requireLogin: false, friendsCanJoin: true, approveJoins: false } });
const vr = await v.next('room', (m) => m.room.private);
check(vr.room.watchKey === undefined && v.closed() === null, 'spectator stays when the canvas goes private');
const orr = await o.next('room', (m) => m.room.private);
check(orr.room.watchKey === key, 'owner keeps the key in room updates');
const drawer = connect(other, room.id);
await drawer.opened;
await drawer.next('error');
const watcher = connect(other, room.id, key);
await watcher.opened;
check((await watcher.next('welcome')).spectator === true, 'private canvas: draw link closed, watch link open');
watcher.ws.close();

o.send({ type: 'kick', user: viewer.id });
await v.next('kicked');
await wait(200);
check(v.closed() === 4003, 'spectators can be removed');
const again = connect(viewer, room.id, key);
await again.opened;
const againErr = await again.next('error');
check(/removed/.test(againErr.message), 'removed spectators can’t come back for a while');

await owner.call('PATCH', '/api/rooms/' + room.id, { share: { visibility: 'open', requireLogin: false, friendsCanJoin: true, approveJoins: false } });
const member = connect(other, room.id);
await member.opened;
check((await member.next('welcome')).room.watchKey === undefined, 'plain members never see the key');
member.ws.close();
o.ws.close();

// ---- UI ----
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
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
const call = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}, [method, path, body]);

const ada = await signUp('Ada');
const uiRoom = await call(ada, 'POST', '/api/rooms', { name: 'Studio', settings: { infinite: true }, share: { visibility: 'open', requireLogin: false, friendsCanJoin: true, approveJoins: false } });
await ada.goto(`${base}/app?room=${uiRoom.id}`);
await ada.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
await ada.locator('.room-dock [aria-label="Share links"]').click();
await ada.waitForSelector('.share-links');
const labels = await ada.locator('.share-links .link-label').allInnerTexts();
check(labels.length === 3 && /^Draw link/.test(labels[0]) && /^Room code/.test(labels[1]) && /^Watch link/.test(labels[2]), 'share window lists draw link, room code and watch link');
const inputs = ada.locator('.share-links input');
check((await inputs.nth(1).inputValue()) === uiRoom.id, 'room code is the room id');
const watchLink = await inputs.nth(2).inputValue();
check(watchLink.startsWith(`${base}/app?room=${uiRoom.id}&watch=`), 'watch link points at this room');
await ada.screenshot({ path: `${out}/01-share-links.png` });
await ada.locator('.modal-head .icon-btn').click();

const vee = await signUp('Vee');
await vee.goto(watchLink);
await vee.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
await vee.waitForSelector('body.spectating');
check(await vee.locator('.watch-tag').isVisible(), 'spectator sees the Watching tag');
check(!(await vee.locator('[aria-label="Export (Ctrl+Shift+E)"]').isVisible()) && !(await vee.locator('.sidebar').isVisible()) && !(await vee.locator('.tool').first().isVisible()), 'spectator has no tools, undo or export');
await vee.keyboard.press('Control+Shift+E');
await vee.keyboard.press('l');
await vee.waitForTimeout(300);
check((await vee.locator('.modal').count()) === 0 && !(await vee.locator('.layers-pop').isVisible()), 'export and layer shortcuts do nothing');
check(await vee.evaluate(() => { const d = window.doodlehive.ed.doc; const n = d.log.length; window.doodlehive.ed.undo(); return d.log.length === n; }), 'undo is inert');
await vee.locator('.room-dock [aria-label="Share links"]').click();
await vee.waitForSelector('.share-links');
check((await vee.locator('.share-links .link-label').allInnerTexts()).join() .startsWith('Watch link'), 'spectators only get the watch link');
await vee.locator('.modal-head .icon-btn').click();
const menuItems = async (page) => { await page.locator('[aria-label="Menu"]').click(); const t = await page.locator('.menu-pop .menu-item').allInnerTexts(); await page.locator('[aria-label="Menu"]').click(); return t; };
check(!(await menuItems(vee)).some((t) => /Export/.test(t)), 'menu has no export for spectators');

await vee.keyboard.press('Enter');
await vee.fill('#chat-input', 'love the colours');
await vee.keyboard.press('Enter');
await ada.waitForSelector('.chat-msg:has-text("love the colours")', { timeout: 4000 }).then(() => check(true, 'spectator chat shows for the artist'), () => check(false, 'spectator chat shows for the artist'));
await vee.screenshot({ path: `${out}/02-spectator.png` });

await ada.locator('.members-btn').click();
check(await ada.locator('.member-row', { hasText: 'Vee' }).locator('small').innerText() === 'watching', 'member list marks spectators');
await ada.locator('.member-row', { hasText: 'Vee' }).click();
check((await ada.locator('.modal .btn', { hasText: 'Make host' }).count()) === 0, 'spectators can’t be made hosts');
await ada.locator('.modal .btn.danger').click();
await ada.locator('.modal .btn.primary', { hasText: 'Remove' }).click();
await vee.waitForSelector('text=A host removed you', { timeout: 4000 }).then(() => check(true, 'spectator sees they were removed'), () => check(false, 'spectator sees they were removed'));
check((await vee.locator('.modal .btn', { hasText: 'Export a copy' }).count()) === 0, 'no export offer on the way out');

await browser.close();
if (errors.length) { console.log('page errors:', errors); failed++; }
process.exit(failed ? 1 : 0);
