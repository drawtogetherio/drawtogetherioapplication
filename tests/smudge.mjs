// Smudge tool: drags paint, undoes, syncs through a room, and the server validates it.
// Usage: node tests/smudge.mjs [http://localhost:4180/app.html] [http://localhost:8787]
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const api = (process.argv[3] ?? 'http://localhost:8787').replace(/\/$/, '');
const out = 'test-results/smudge';
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };

// ---- In the editor ----
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto(url);
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await page.waitForTimeout(200);

const box = await page.locator('canvas.stage').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
// Alpha of the active layer under a screen point.
const alphaAt = (sx, sy) => page.evaluate(([sx, sy]) => {
  const ed = window.doodlehive.ed;
  const r = ed.view.canvas.getBoundingClientRect();
  const p = ed.view.viewport.toDoc(sx - r.left, sy - r.top);
  const c = ed.doc.layer(ed.activeLayer).surface.extract({ x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 });
  return c.getContext('2d').getImageData(0, 0, 1, 1).data[3];
}, [sx, sy]);
const drag = async (x0, y0, x1, y1, steps = 30) => {
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move(x1, y1, { steps }); await page.mouse.up();
};

await page.evaluate(() => { window.doodlehive.ed.sizeParams.size = 30; });
await drag(cx - 150, cy, cx + 150, cy, 40);
check((await alphaAt(cx, cy)) > 200 && (await alphaAt(cx, cy + 40)) === 0, 'a thick stroke, nothing below it');

await page.keyboard.press('s');
check(await page.evaluate(() => window.doodlehive.ed.toolId === 'smudge'), 'S picks the smudge tool');
check(!(await page.locator('.sidebar .slider[aria-label="Opacity"]').isVisible()) && (await page.locator('.optionsbar .slider[aria-label="Strength"]').count()) === 1, 'smudge options show strength, not opacity');
await page.evaluate(() => { window.doodlehive.ed.settings.smudge.size = 40; });
await drag(cx, cy, cx, cy + 90, 40);
const pulled = await alphaAt(cx, cy + 40);
check(pulled > 20, `paint is dragged downward (alpha ${pulled})`);
check((await alphaAt(cx, cy)) < 255, 'the source thins out');
check((await alphaAt(cx + 100, cy + 40)) === 0, 'untouched areas stay clear');
await page.screenshot({ path: `${out}/01-smudged.png` });

await page.keyboard.press('Control+z');
check((await alphaAt(cx, cy + 40)) === 0, 'undo puts the pixels back');
await page.keyboard.press('Control+Shift+z');
check((await alphaAt(cx, cy + 40)) === pulled, 'redo replays the same smudge');

// Inside a selection only
await page.keyboard.press('Control+z');
await page.keyboard.press('m');
await drag(cx - 60, cy - 40, cx + 60, cy + 120, 4);
await page.keyboard.press('s');
await drag(cx - 100, cy, cx - 100, cy + 90, 40);
await drag(cx, cy, cx, cy + 90, 40);
check((await alphaAt(cx - 100, cy + 40)) === 0 && (await alphaAt(cx, cy + 40)) > 20, 'a selection limits the smudge');
await page.keyboard.press('Control+d');

const log = await page.evaluate(() => window.doodlehive.ed.doc.log.filter((o) => o.t === 'smudge').map((o) => ({ pts: o.pts.length, clip: !!o.clip })));
check(log.length >= 3 && log.at(-1).clip, 'smudges are logged as ops with their clip');
await browser.close();

// ---- In a room ----
const suffix = Math.floor(Math.random() * 1e6);
async function login(name) {
  const r = await fetch(api + '/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: api }, body: JSON.stringify({ name: name + suffix }) });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}
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
const artist = await login('Artist'), friend = await login('Friend');
const room = await (await fetch(api + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: artist, Origin: api }, body: JSON.stringify({ name: 'Smudge', settings: { infinite: true }, share: { visibility: 'open' } }) })).json();
const a = connect(artist, room.id), f = connect(friend, room.id);
await a.opened; await f.opened;
const welcome = await a.next('welcome');
await f.next('welcome');
const folder = welcome.ops.find((o) => o.t === 'folder.add' && o.folder.owner === welcome.you).folder.id;
const brush = { size: 40, opacity: 1, flow: 0.7, hardness: 0.5, spacing: 0.12, pressureSize: 0.5, pressureFlow: 0.5, minSize: 0.3, smoothing: 0.3 };
a.send({ type: 'op', op: { t: 'layer.add', id: 'l1', parent: folder, index: 0, layer: { id: 'ly', name: 'L', visible: true, opacity: 1, blend: 'normal', alphaLock: false } } });
a.send({ type: 'op', op: { t: 'smudge', id: 's1', layer: 'ly', brush, pts: [0, 0, 1, 10, 10, 1, 20, 20, 1] } });
const got = await f.next('op', (m) => m.op.id === 's1');
check(got.op.t === 'smudge' && got.op.pts.length === 9, 'a smudge reaches the others');
a.send({ type: 'op', op: { t: 'smudge', id: 's2', layer: 'ly', brush: { ...brush, size: 1e6 }, pts: [0, 0, 1] } });
check((await a.next('reject')).opId === 's2', 'oversized smudge is refused');
f.send({ type: 'op', op: { t: 'smudge', id: 's3', layer: 'ly', brush, pts: [0, 0, 1] } });
check(/someone else/.test((await f.next('reject')).reason), 'smudging someone else’s layer is refused');
a.ws.close(); f.ws.close();

if (errors.length) { console.log('page errors:', errors); failed++; }
process.exit(failed ? 1 : 0);
