// Multi-user lag benchmark: one real browser client draws while N bot users (WebSocket clients that
// behave like the app: live chunks every 33 ms, cursor every 50 ms, the stroke op on pen-up) draw in
// the same room. Reports frame times, long tasks, input delay and pen-up cost on the measured client.
// Needs the server running with dev login on (npm run build && PUBLIC_URL=http://localhost:8787 npm start).
// Usage: node tests/lagbench.mjs [--url http://localhost:8787] [--bots 3] [--secs 20] [--fixed] [--label name] [--json out.json]
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes('--' + k);
const base = arg('url', 'http://localhost:8787').replace(/\/$/, '');
const BOTS = Number(arg('bots', 3)), SECS = Number(arg('secs', 20)), FIXED = flag('fixed');
const label = arg('label', 'run'), jsonOut = arg('json', null);
const tag = Math.floor(Math.random() * 1e6);

async function devLogin(name) {
  const r = await fetch(base + '/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!r.ok) throw new Error('dev login failed: ' + r.status + ' ' + await r.text());
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const BRUSHES = [
  { size: 28, opacity: 1, flow: 1, hardness: 0.85, spacing: 0.08, pressureSize: 0.8, pressureFlow: 0.4, minSize: 0.15, smoothing: 0.3 }, // round
  { size: 22, opacity: 1, flow: 0.5, hardness: 0.4, spacing: 0.08, pressureSize: 0.5, pressureFlow: 0.9, minSize: 0.3, smoothing: 0.1, grain: 0.6, grainScale: 1.6 }, // charcoal
  { size: 60, opacity: 1, flow: 0.3, hardness: 0, spacing: 0.05, pressureSize: 0, pressureFlow: 1, minSize: 0.05, smoothing: 0.2 }, // soft
];
const COLORS = ['#e8578a', '#3fbf7f', '#4a7bea', '#f0a020'];
let opSeq = 0;
const id = (p = 'op_') => p + tag.toString(36) + (opSeq++).toString(36) + Math.random().toString(36).slice(2, 8);

/** A bot member: joins, adds a layer in its folder, then draws wavy strokes in its own area. */
async function bot(i, roomId, area) {
  const cookie = await devLogin(`Bot${i}x${tag}`);
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${roomId}`, { headers: { cookie } });
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  let you = '', layer = '', stop = false, strokes = 0;
  const ready = new Promise((res, rej) => {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'welcome') {
        you = m.you;
        layer = id('ly_');
        send({ type: 'op', op: { t: 'layer.add', id: id(), parent: 'uf_' + you, index: 0, layer: { id: layer, name: 'Layer 1', visible: true, opacity: 1, blend: 'normal', alphaLock: false } } });
        setTimeout(res, 300);
      }
      if (m.type === 'reject' || m.type === 'error') console.log(`bot${i}:`, m.reason ?? m.message);
    });
    ws.on('error', rej);
  });
  await ready;
  const brush = BRUSHES[i % BRUSHES.length], color = COLORS[(i + 1) % COLORS.length];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (async () => {
    let k = 0;
    while (!stop) {
      const stroke = id(), pts = [];
      let sent = 0, lastLive = Date.now(), lastCursor = 0;
      const y0 = area.y + ((k * 37) % area.h), n = 90; // ~1.5 s at 60 Hz
      for (let s = 0; s < n && !stop; s++) {
        const t = s / (n - 1);
        const x = Math.round((area.x + t * area.w) * 100) / 100;
        const y = Math.round((y0 + Math.sin(t * 12 + k) * 30) * 100) / 100;
        pts.push(x, y, 0.7);
        const now = Date.now();
        if (now - lastLive >= 33) {
          send({ type: 'live', live: { stroke, layer, erase: false, brush, color, pts: pts.slice(sent) } });
          sent = pts.length; lastLive = now;
        }
        if (now - lastCursor >= 50) { send({ type: 'cursor', x: Math.round(x), y: Math.round(y), drawing: true }); lastCursor = now; }
        await sleep(16);
      }
      if (sent < pts.length) send({ type: 'live', live: { stroke, layer, erase: false, brush, color, pts: pts.slice(sent) } });
      send({ type: 'op', op: { t: 'stroke', id: stroke, layer, erase: false, brush, color, pts } });
      strokes++; k++;
      await sleep(250);
    }
  })();
  return { stop: async () => { stop = true; await run; ws.close(); return strokes; } };
}

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Host logs in and makes a room (free account, so the device-copy path runs like it does for most people).
const res = await page.request.post(base + '/auth/dev', { data: { name: `Host${tag}` } });
if (!res.ok()) throw new Error('host login failed ' + res.status());
const created = await page.request.post(base + '/api/rooms', {
  data: { name: 'Lag bench', settings: FIXED ? { width: 2400, height: 1600, infinite: false, background: '#ffffff' } : { infinite: true, background: '#ffffff' }, share: { visibility: 'open' } },
  headers: { origin: base },
});
if (!created.ok()) throw new Error('room create failed ' + created.status() + ' ' + await created.text());
const roomId = (await created.json()).id;
await page.goto(`${base}/app?room=${roomId}`);
const setup = await Promise.race([
  page.waitForSelector('#display-name', { timeout: 15000 }).then(() => 'setup'),
  page.waitForFunction(() => window.doodlehive?.ed.room?.status === 'open', null, { timeout: 15000 }).then(() => 'open'),
]);
if (setup === 'setup') {
  await page.fill('#display-name', 'Host');
  await page.getByRole('button', { name: 'Start drawing' }).click();
}
await page.waitForFunction(() => window.doodlehive?.ed.room?.status === 'open', null, { timeout: 20000 });
// Studio layout keeps the layers panel open, like most people drawing together.
await page.evaluate(() => { const app = window.doodlehive; app.ed.prefs.layout = 'studio'; app.applyLayout(); });
await page.waitForTimeout(500);
const box = await page.locator('canvas.stage').boundingBox();

// Bots draw in their own bands of the visible canvas; the host draws in the remaining one.
const docArea = await page.evaluate(() => {
  const vp = window.doodlehive.ed.view.viewport, a = vp.toDoc(0, 0), b = vp.toDoc(vp.w, vp.h);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
});
const bands = BOTS + 1, bandH = docArea.h / bands;
const bots = [];
for (let i = 0; i < BOTS; i++) bots.push(await bot(i, roomId, { x: docArea.x + docArea.w * 0.1, y: docArea.y + bandH * (i + 1) + bandH * 0.2, w: docArea.w * 0.8, h: bandH * 0.6 }));
await page.waitForFunction((n) => window.doodlehive.ed.room.members.length === n, BOTS + 1, { timeout: 10000 });
await page.waitForTimeout(1500); // let the bots get going

const result = await page.evaluate(async ([secs, box, bandFrac]) => {
  const ed = window.doodlehive.ed, view = ed.view, c = document.querySelector('canvas.stage');
  // Instrument: frame intervals, long tasks, render cost.
  const frames = [];
  let last = performance.now(), running = true;
  const tick = (t) => { frames.push(t - last); last = t; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const longTasks = [];
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); });
  try { po.observe({ type: 'longtask', buffered: false }); } catch {}
  const renders = [];
  const realRender = view.render.bind(view);
  view.render = () => { const t0 = performance.now(); realRender(); renders.push(performance.now() - t0); };
  let remoteOps = 0;
  const unsub = ed.room.on((e) => { if (e.kind === 'op') remoteOps++; });

  // The host draws continuously: a pen sampled up to 120 Hz, 1.2 s strokes, 200 ms gaps.
  const delays = [], ups = [], downs = [];
  const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
    pointerId: 7, pointerType: 'pen', clientX: box.x + x, clientY: box.y + y, pressure: 0.7, buttons: type === 'pointerup' ? 0 : 1, bubbles: true,
  }));
  const end = performance.now() + secs * 1000;
  let k = 0;
  const top = box.height * 0.05, h = box.height * bandFrac * 0.8;
  while (performance.now() < end) {
    const y0 = top + ((k * 41) % Math.max(1, h - 60)) + 30;
    let t0 = performance.now();
    fire('pointerdown', box.width * 0.1, y0);
    downs.push(performance.now() - t0);
    // The pen moves with wall time, like a real one; gaps between samples are time the main thread was busy.
    const start = performance.now();
    let prev = start;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000 / 120));
      const now = performance.now();
      delays.push(now - prev);
      prev = now;
      const t = Math.min(1, (now - start) / 1200);
      fire('pointermove', box.width * (0.1 + 0.8 * t), y0 + Math.sin(t * 10 + k) * 25);
      if (t >= 1) break;
    }
    t0 = performance.now();
    fire('pointerup', box.width * 0.9, y0 + Math.sin(10 + k) * 25);
    ups.push(performance.now() - t0);
    k++;
    await new Promise((r) => setTimeout(r, 200));
  }
  running = false;
  po.disconnect();
  unsub();
  view.render = realRender;
  await new Promise((r) => setTimeout(r, 50));
  return { frames: frames.slice(1), longTasks, renders, delays, ups, downs, strokes: k, remoteOps, layers: ed.doc.layers.length, tiles: ed.doc.layers.reduce((s, l) => s + l.surface.size, 0) };
}, [SECS, box, 1 / bands]);

let botStrokes = 0;
for (const b of bots) botStrokes += await b.stop();
await page.screenshot({ path: `test-results/lagbench-${label}.png` }).catch(() => {});
await browser.close();

const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const r1 = (v) => Math.round(v * 10) / 10;
const totalMs = sum(result.frames);
const summary = {
  label, bots: BOTS, secs: SECS, canvas: FIXED ? 'fixed 2400x1600' : 'unlimited',
  fps: r1((result.frames.length / totalMs) * 1000),
  frameP50: r1(q(result.frames, 0.5)), frameP95: r1(q(result.frames, 0.95)), frameP99: r1(q(result.frames, 0.99)), frameMax: r1(Math.max(...result.frames)),
  jankyFrames: result.frames.filter((f) => f > 50).length,
  longTasks: result.longTasks.length, longTaskMs: Math.round(sum(result.longTasks)), longTaskMax: r1(Math.max(0, ...result.longTasks)),
  penGapAvg: r1(avg(result.delays)), penGapP95: r1(q(result.delays, 0.95)), penGapP99: r1(q(result.delays, 0.99)), penGapMax: r1(Math.max(...result.delays)),
  penSamplesPerSec: r1(result.delays.length / (sum(result.delays) / 1000)),
  renderAvg: r1(avg(result.renders)), renderP95: r1(q(result.renders, 0.95)), renderCount: result.renders.length,
  penUpAvg: r1(avg(result.ups)), penUpMax: r1(Math.max(...result.ups)),
  hostStrokes: result.strokes, botStrokes, remoteOps: result.remoteOps, layers: result.layers, tiles: result.tiles,
  errors: errors.length,
};
console.log(JSON.stringify(summary, null, 2));
if (errors.length) console.log('page errors:', errors.slice(0, 5));
if (jsonOut) {
  const all = fs.existsSync(jsonOut) ? JSON.parse(fs.readFileSync(jsonOut, 'utf8')) : [];
  all.push(summary);
  fs.writeFileSync(jsonOut, JSON.stringify(all, null, 2));
}
