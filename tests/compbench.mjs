// Compositor benchmark: a 4K canvas with N layers of paint. Times a full recomposite of the view, a
// brush-sized dirty region at 100%, a zoom step, and frame intervals during a long stroke.
// Usage: node tests/compbench.mjs [http://localhost:4180/app.html] [--layers 20] [--json out.json]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const url = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:4180/app.html';
const LAYERS = Number(arg('layers', 20)), jsonOut = arg('json', null);
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.goto(url);
await page.selectOption('#canvas-preset', '4k');
await page.getByText('Create canvas').click();
await page.waitForFunction(() => !!window.doodlehive);

const r = await page.evaluate(async (LAYERS) => {
  const app = window.doodlehive, ed = app.ed, doc = ed.doc, view = ed.view;
  const uid = () => 'b' + Math.random().toString(36).slice(2, 10);
  // Paint: each layer gets long strokes across the whole canvas, so every tile has content on most layers.
  ed.settings.brush.size = 60; ed.settings.brush.smoothing = 0; ed.prefs.stabilizerOn = false;
  for (let i = 0; i < LAYERS; i++) {
    if (i) ed.addLayer();
    const layer = ed.activeLayer;
    for (let s = 0; s < 4; s++) {
      const y0 = 200 + s * 500 + i * 20;
      ed.apply({ t: 'shape', id: uid(), layer, shape: 'line', x0: 50, y0, x1: 3790, y1: y0 + 300, width: 48, fill: false, color: ['#e8578a', '#3fbf7f', '#4a7bea', '#f0a020'][i % 4], opacity: 0.9, erase: false });
    }
  }
  const tiles = doc.layers.reduce((n, l) => n + l.surface.size, 0);
  const time = (fn, n = 5) => { const t = []; for (let i = 0; i < n; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return { median: +t[n >> 1].toFixed(1), max: +t[n - 1].toFixed(1) }; };
  const settle = () => new Promise((res) => setTimeout(res, 50));
  // Full recomposite of the fitted view (what a zoom step or a layer visibility change costs).
  ed.fitView(); view.renderNow(); await settle();
  const full = time(() => { view.invalidate(null); view.renderNow(); });
  // One brush-sized dirty region at 100% (what each frame of a stroke composites).
  ed.view.viewport.zoom = 1; ed.view.viewport.onChange(); view.renderNow(); await settle();
  const vp = ed.view.viewport;
  const dab = time(() => { view.invalidate({ x: vp.cx - 32, y: vp.cy - 32, w: 64, h: 64 }); view.renderNow(); }, 9);
  const dab256 = time(() => { view.invalidate({ x: vp.cx - 128, y: vp.cy - 128, w: 256, h: 256 }); view.renderNow(); }, 9);
  // Blit only (pan with nothing dirty).
  const pan = time(() => { vp.cx += 3; vp.onChange(); view.renderNow(); }, 9);
  // Zoom step: new scale means the whole visible range recomposites.
  const zoomStep = time(() => { vp.zoomAt(640, 400, 1.1); view.renderNow(); }, 5);
  ed.fitView(); view.renderNow();
  return { layers: doc.layers.length, tiles, full, dab, dab256, pan, zoomStep };
}, LAYERS);

// Frame intervals during a real stroke at 100% zoom with every layer in play.
await page.evaluate(() => { const vp = window.doodlehive.ed.view.viewport; vp.zoom = 1; vp.onChange(); });
const box = await page.locator('canvas.stage').boundingBox();
const frames = page.evaluate(() => new Promise((res) => {
  const t = []; let last = performance.now(), n = 0;
  const tick = (now) => { t.push(now - last); last = now; if (++n < 150) requestAnimationFrame(tick); else res(t); };
  requestAnimationFrame(tick);
}));
await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.down();
for (let i = 1; i <= 120; i++) { await page.mouse.move(box.x + 100 + i * 9, box.y + 100 + Math.sin(i / 6) * 120); }
await page.mouse.up();
const t = (await frames).sort((a, b) => a - b);
r.strokeFrame = { median: +t[t.length >> 1].toFixed(1), p95: +t[Math.floor(t.length * 0.95)].toFixed(1), max: +t[t.length - 1].toFixed(1) };
console.log(JSON.stringify(r, null, 1));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(r, null, 1));
await browser.close();
