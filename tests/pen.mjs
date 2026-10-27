// Pen input: a stroke whose first sample has no pressure must not start with a dot sized by the previous stroke.
// Usage: node tests/pen.mjs [http://localhost:4180/app.html]
import { chromium } from '@playwright/test';
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto(process.argv[2] ?? 'http://localhost:4180/app.html');
await page.getByText('Create canvas').click();
await page.waitForSelector('canvas.stage');
const r = await page.evaluate(async () => {
  const c = document.querySelector('canvas.stage'), ed = window.doodlehive.ed;
  const fire = (type, x, y, pressure) => c.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', clientX: x, clientY: y, pressure, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const line = (p0, ps) => { fire('pointerdown', 300, 400, p0); for (let i = 1; i <= 30; i++) fire('pointermove', 300 + i * 8, 400, ps(i)); fire('pointerup', 540, 400, 0); };
  const height = () => { const b = ed.layer.surface.contentBounds(); return b ? b.h : 0; };
  ed.settings.brush.size = 60; ed.settings.brush.pressureSize = 1; ed.settings.brush.minSize = 0.05; ed.settings.brush.smoothing = 0;
  // A heavy stroke leaves the fallback pressure high.
  line(1, () => 1); await wait(50);
  const heavy = height(); ed.undo(); await wait(50);
  // Then a light stroke whose first two samples report no pressure.
  line(0, (i) => (i === 1 ? 0 : 0.1)); await wait(50);
  const light = height(); ed.undo(); await wait(50);
  // A tap with no pressure samples at all still marks the canvas.
  fire('pointerdown', 300, 400, 0); fire('pointerup', 300, 400, 0); await wait(50);
  const tap = height(); ed.undo(); await wait(50);
  // A light stroke with stray pressure spikes must not leave dark specks.
  const maxAlpha = () => { const b = ed.layer.surface.contentBounds(), c = document.createElement('canvas'); c.width = b.w; c.height = b.h;
    const x = c.getContext('2d'); x.translate(-b.x, -b.y); ed.layer.surface.drawTo(x, b);
    const d = x.getImageData(0, 0, b.w, b.h).data; let m = 0; for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]); return m; };
  ed.settings.brush.size = 3; ed.settings.brush.smoothing = 0.45;
  line(0.03, (i) => (i % 7 === 0 ? 0.5 : 0.03)); await wait(50);
  const spiky = maxAlpha(); ed.undo(); await wait(50);
  line(0.03, () => 0.03); await wait(50);
  const plain = maxAlpha(); ed.undo(); await wait(50);
  // iPad Safari: four coalesced samples per event, all with the event's pressure. The width must taper, not step.
  const widths = () => { const b = ed.layer.surface.contentBounds(), c = document.createElement('canvas'); c.width = b.w; c.height = b.h;
    const x = c.getContext('2d'); x.translate(-b.x, -b.y); ed.layer.surface.drawTo(x, b);
    const d = x.getImageData(0, 0, b.w, b.h).data, w = [];
    for (let i = 0; i < b.w; i++) { let n = 0; for (let j = 0; j < b.h; j++) if (d[(j * b.w + i) * 4 + 3] > 128) n++; w.push(n); }
    return w; };
  ed.settings.brush.size = 60; ed.settings.brush.smoothing = 0; ed.settings.brush.pressureSize = 1; ed.settings.brush.minSize = 0.05;
  const batch = (x, pressure) => {
    const e = new PointerEvent('pointermove', { pointerId: 9, pointerType: 'pen', clientX: x, clientY: 400, pressure, buttons: 1, bubbles: true });
    const samples = [3, 2, 1, 0].map((k) => new PointerEvent('pointermove', { pointerId: 9, pointerType: 'pen', clientX: x - k * 6, clientY: 400, pressure, buttons: 1 }));
    Object.defineProperty(e, 'getCoalescedEvents', { value: () => samples });
    c.dispatchEvent(e);
  };
  fire('pointerdown', 300, 400, 0.1);
  for (let i = 1; i <= 6; i++) batch(300 + i * 24, 0.1 + i * 0.15);
  fire('pointerup', 300 + 6 * 24, 400, 0); await wait(50);
  // How far the width strays from a straight taper over the middle of the stroke: a staircase strays by half a step.
  const w = widths().slice(30, -40); ed.undo();
  let jump = 0; for (let i = 0; i < w.length; i++) jump = Math.max(jump, Math.abs(w[i] - (w[0] + ((w[w.length - 1] - w[0]) * i) / (w.length - 1))));
  return { heavy, light, tap, spiky, plain, jump: Math.round(jump * 10) / 10, w: w.join(' ') };
});
await browser.close();
const ok = r.heavy > 50 && r.light < r.heavy / 3 && r.tap > 0;
console.log((ok ? 'ok   ' : 'FAIL ') + `pressureless first samples start thin (heavy ${r.heavy}, light ${r.light}, tap ${r.tap})`);
const calm = r.spiky < r.plain + 40;
console.log((calm ? 'ok   ' : 'FAIL ') + `pressure spikes are filtered out (spiky ${r.spiky}, plain ${r.plain})`);
const taper = r.jump <= 2;
console.log((taper ? 'ok   ' : 'FAIL ') + `coalesced samples with one shared pressure still taper (off a straight taper by ${r.jump}px)`);
if (!ok || !calm || !taper) process.exit(1);
console.log('all passed');
