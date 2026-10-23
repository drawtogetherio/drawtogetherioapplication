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
  return { heavy, light, tap: height() };
});
await browser.close();
const ok = r.heavy > 50 && r.light < r.heavy / 3 && r.tap > 0;
console.log((ok ? 'ok   ' : 'FAIL ') + `pressureless first samples start thin (heavy ${r.heavy}, light ${r.light}, tap ${r.tap})`);
if (!ok) process.exit(1);
console.log('all passed');
