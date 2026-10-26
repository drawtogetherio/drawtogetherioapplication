// Brush images on the server: upload and fetch by content id, room strokes need them, and a tip drawn by one person shows for another.
// Needs `npm run dev` with dev login on. Usage: node tests/assets.mjs [http://localhost:5173] [http://localhost:8787]
import { chromium } from '@playwright/test';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const api = (process.argv[3] ?? 'http://localhost:8787').replace(/\/$/, '');
const out = 'test-results/assets';
fs.mkdirSync(out, { recursive: true });
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);

/** A greyscale PNG made here: `at(x, y)` gives 0..255. */
function png(w, h, at) {
  const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = at(x, y); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);

async function login(name) {
  const r = await fetch(api + '/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: api }, body: JSON.stringify({ name: name + suffix }) });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}
const put = (cookie, id, buf) => fetch(`${api}/api/brush-assets/${id}`, { method: 'PUT', headers: { 'Content-Type': 'image/png', Origin: api, ...(cookie ? { Cookie: cookie } : {}) }, body: buf });

// ---- HTTP: content-addressed upload and fetch ----
const artist = await login('Artist'), friend = await login('Friend');
const bar = png(64, 16, () => 255), barId = idOf(bar);
check((await put('', barId, bar)).status === 401, 'uploading needs a session');
check((await put(artist, 'f'.repeat(32), bar)).status === 400, 'an id that isn’t the image’s hash is refused');
check((await put(artist, barId, bar)).status === 200, 'a 64×16 PNG uploads under its hash');
const got = await fetch(`${api}/api/brush-assets/${barId}`, { headers: { Origin: api } });
check(got.status === 200 && got.headers.get('cache-control')?.includes('immutable') && Buffer.from(await got.arrayBuffer()).equals(bar), 'anyone fetches it back byte for byte, cacheable forever');
check((await fetch(`${api}/api/brush-assets/${'0'.repeat(32)}`)).status === 404, 'an unknown id is 404');
const big = png(300, 300, () => 255);
check((await put(artist, idOf(big), big)).status === 400, 'a 300 px image is refused');
const noise = crypto.randomBytes(256 * 256), huge = png(256, 256, (x, y) => noise[y * 256 + x]);
check([400, 413].includes((await put(artist, idOf(huge), huge)).status), `a noisy 256 px PNG over 64 KB is refused (${huge.length} bytes)`);
check((await put(friend, barId, bar)).status === 200, 'uploading the same image again is fine');

// ---- Room: strokes may only use images the server has ----
function connect(cookie, roomId) {
  const ws = new WebSocket(`${api.replace('http', 'ws')}/ws/${roomId}`, { headers: { Cookie: cookie, Origin: api } });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const next = (type, pred = () => true) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), 4000);
    const look = () => { const i = messages.findIndex((m) => m.type === type && pred(m)); if (i >= 0) { clearTimeout(t); res(messages.splice(i, 1)[0]); return true; } return false; };
    if (!look()) ws.on('message', function h() { if (look()) ws.off('message', h); });
  });
  return { ws, next, send: (m) => ws.send(JSON.stringify(m)), opened: new Promise((res) => ws.on('open', res)) };
}
const room = await (await fetch(api + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: artist, Origin: api }, body: JSON.stringify({ name: 'Tips', settings: { infinite: true }, share: { visibility: 'open' } }) })).json();
const a = connect(artist, room.id), f = connect(friend, room.id);
await a.opened; await f.opened;
const welcome = await a.next('welcome');
await f.next('welcome');
const folder = welcome.ops.find((o) => o.t === 'folder.add' && o.folder.owner === welcome.you).folder.id;
const brush = { size: 40, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: 0, pressureFlow: 0, minSize: 0.1, smoothing: 0 };
a.send({ type: 'op', op: { t: 'layer.add', id: 'l1', parent: folder, index: 0, layer: { id: 'ly', name: 'L', visible: true, opacity: 1, blend: 'normal', alphaLock: false } } });
a.send({ type: 'op', op: { t: 'stroke', id: 's1', layer: 'ly', erase: false, color: '#000000', brush: { ...brush, shape: barId }, pts: [0, 0, 1] } });
check((await f.next('op', (m) => m.op.id === 's1')).op.brush.shape === barId, 'a stroke with an uploaded tip reaches the others');
a.send({ type: 'op', op: { t: 'stroke', id: 's2', layer: 'ly', erase: false, color: '#000000', brush: { ...brush, dual: '1'.repeat(32) }, pts: [0, 0, 1] } });
check(/image/.test((await a.next('reject', (m) => m.opId === 's2')).reason), 'a stroke naming an image the server lacks is refused');
a.send({ type: 'op', op: { t: 'stroke', id: 's3', layer: 'ly', erase: false, color: '#000000', brush: { ...brush, shape: 'not-an-id' }, pts: [0, 0, 1] } });
check((await a.next('reject', (m) => m.opId === 's3')).reason === 'Unknown edit', 'a malformed image id is an invalid edit');
a.ws.close(); f.ws.close();

// ---- Two people in a room: a tip picked in the editor shows up for the other ----
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
async function signUp(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
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
const ana = await signUp('Ana'), ben = await signUp('Ben');
const made = await ana.evaluate(async () => (await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tip room', settings: { infinite: true }, share: { visibility: 'open' } }) })).json());
for (const p of [ana, ben]) { await p.goto(`${base}/app?room=${made.id}`); await p.waitForFunction(() => window.doodlehive.ed.room?.status === 'open'); }
const ed = (page, fn, arg) => page.evaluate(([src, a]) => new Function('ed', 'a', `return (${src})(ed, a)`)(window.doodlehive.ed, a), [fn.toString(), arg]);
// Ana makes a brush with a bar-shaped tip through the editor.
const file = { name: 'bar.png', mimeType: 'image/png', buffer: png(64, 16, () => 255) };
await ana.keyboard.press('b');
await ana.locator('.topbar [aria-label^="Brush (B)"]').click();
await ana.waitForSelector('.brush-library');
await ana.getByRole('tab', { name: 'Pen', exact: true }).click();
await ana.locator('.brush-row', { hasText: 'Ink Pen' }).hover();
await ana.locator('[aria-label="More for Ink Pen"]').click();
await ana.locator('.brush-menu .menu-item', { hasText: 'Clone' }).click();
await ana.waitForSelector('.brush-edit');
await ana.locator('.brush-edit .segmented button', { hasText: 'Image…' }).click();
await ana.locator('.brush-edit .asset-file').setInputFiles(file);
await ana.waitForSelector('.brush-edit .asset-thumb');
await ana.locator('.modal-actions .btn.primary').click();
await ana.waitForSelector('.brush-edit', { state: 'detached' });
await ana.keyboard.press('Escape');
const tipId = await ed(ana, (e) => e.prefs.customBrushes[0].params.shape);
check(/^[0-9a-f]{32}$/.test(tipId) && (await fetch(`${api}/api/brush-assets/${tipId}`)).status === 200, 'saving the brush put its image on the server');
const layer = await ed(ana, (e) => e.activeLayer);
await ed(ana, (e, o) => e.run([{ t: 'stroke', id: 'tip-dot', layer: e.activeLayer, erase: false, brush: o, color: '#000000', pts: [100, 100, 1] }], 'stroke'), { ...brush, shape: tipId });
await ben.waitForFunction(() => window.doodlehive.ed.doc.log.some((o) => o.id === 'tip-dot'), null, { timeout: 8000 }).then(() => check(true, 'Ben receives the stroke'), () => check(false, 'Ben receives the stroke'));
const shape = await ed(ben, (e, l) => {
  const c = document.createElement('canvas'); c.width = c.height = 100;
  const g = c.getContext('2d'); g.translate(-50, -50); e.doc.layer(l).surface.drawTo(g, { x: 50, y: 50, w: 100, h: 100 });
  const d = g.getImageData(0, 0, 100, 100).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 40) continue; const x = (i / 4) % 100, y = Math.floor(i / 4 / 100); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { w: x1 - x0, h: y1 - y0 };
}, layer);
check(shape.w >= 38 && shape.h <= 12, `Ben's canvas shows the bar tip, fetched from the server (${shape.w}×${shape.h})`);
await ben.screenshot({ path: `${out}/ben.png` });
await browser.close();

if (errors.length) { console.log('page errors:', errors); failed++; }
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
