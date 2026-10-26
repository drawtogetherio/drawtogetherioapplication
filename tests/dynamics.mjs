// Brush dynamics: seeded scatter and jitter replay identically, colour dynamics, wet mixing, tilt shading, dab angle.
// Usage: node tests/dynamics.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/dynamics';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
let failed = 0;
page.on('pageerror', (e) => errors.push(e.message));
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const ed = (fn, arg) => page.evaluate(([src, a]) => new Function('ed', 'a', `return (${src})(ed, a)`)(window.doodlehive.ed, a), [fn.toString(), arg]);

await page.goto(url);
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();

/** The active layer's pixels in a document rect: digest, bbox of ink, distinct colours, mean colour. */
const read = (x, y, w, h) => ed((e, r) => {
  const c = document.createElement('canvas'); c.width = r[2]; c.height = r[3];
  const g = c.getContext('2d'); g.translate(-r[0], -r[1]); e.layer.surface.drawTo(g, { x: r[0], y: r[1], w: r[2], h: r[3] });
  const d = g.getImageData(0, 0, r[2], r[3]).data;
  let hash = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0, sr = 0, sg = 0, sb = 0;
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    hash = (Math.imul(hash, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) | 0;
    if (d[i + 3] < 40) continue;
    const px = (i / 4) % r[2], py = Math.floor(i / 4 / r[2]);
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    n++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
    colors.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
  }
  return { hash, x0, y0, x1, y1, n, colors: colors.size, mean: n ? [sr / n, sg / n, sb / n] : null };
}, [x, y, w, h]);
const base = { size: 10, opacity: 1, flow: 1, hardness: 0.9, spacing: 0.1, pressureSize: 0, pressureFlow: 0, minSize: 0.1, smoothing: 0 };
const line = (y, x0 = 100, x1 = 500) => { const pts = []; for (let x = x0; x <= x1; x += 4) pts.push(x, y, 1); return pts; };
const stroke = (id, brush, pts, extra = {}) => ed((e, o) => { e.run([{ t: 'stroke', id: o.id, layer: e.activeLayer, erase: false, brush: o.brush, color: o.color ?? '#2040ff', pts: o.pts, ...o.extra }], 'stroke'); }, { id, brush, pts, ...extra });
const clearLayer = () => ed((e) => { e.setTool('select'); });

// ---- Scatter is deterministic per op id ----
await stroke('scat-1', { ...base, scatter: 1.5, sizeJitter: 0.5, flowJitter: 0.5 }, line(200));
const a = await read(60, 150, 500, 100);
check(a.n > 0 && (a.y0 < 185 || a.y1 > 215), `scatter puts dabs off the path (rows ${a.y0}..${a.y1})`);
await ed((e) => e.undo());
await stroke('scat-1', { ...base, scatter: 1.5, sizeJitter: 0.5, flowJitter: 0.5 }, line(200));
const b = await read(60, 150, 500, 100);
check(a.hash === b.hash, 'the same op id replays the same pixels');
await ed((e) => e.undo());
await stroke('scat-2', { ...base, scatter: 1.5, sizeJitter: 0.5, flowJitter: 0.5 }, line(200));
const c = await read(60, 150, 500, 100);
check(a.hash !== c.hash, 'another op id scatters differently');
await ed((e) => e.undo());

// ---- Plain brushes are untouched by the seed ----
await stroke('plain-1', base, line(200));
const p1 = await read(60, 150, 500, 100);
await ed((e) => e.undo());
await stroke('plain-2', base, line(200));
const p2 = await read(60, 150, 500, 100);
check(p1.hash === p2.hash && p1.y0 + 150 >= 194 && p1.y1 + 150 <= 206, `a brush without dynamics draws the same line whatever the id (${p1.hash === p2.hash}, rows ${p1.y0}..${p1.y1})`);
await ed((e) => e.undo());

// ---- Colour dynamics ----
await stroke('hue', { ...base, hueJitter: 0.5 }, line(200));
const hue = await read(60, 150, 500, 100);
check(hue.colors > 8, `hue jitter paints many colours (${hue.colors})`);
await ed((e) => e.undo());
await stroke('bright', { ...base, brightJitter: 0.6 }, line(200));
const br = await read(60, 150, 500, 100);
check(br.colors > 4 && br.mean[2] > br.mean[0], `brightness jitter keeps the hue (${br.colors} shades)`);
await ed((e) => e.undo());

// ---- Wet mixing carries paint from the layer ----
await ed((e) => e.run([{ t: 'shape', id: 'red-block', layer: e.activeLayer, shape: 'rect', x0: 100, y0: 150, x1: 300, y1: 250, width: 1, fill: true, color: '#ff0000', opacity: 1, erase: false }], 'shape'));
await stroke('dry', { ...base, size: 14 }, line(200, 120, 520));
const dry = await read(320, 180, 200, 40);
check(dry.mean && dry.mean[2] > 200 && dry.mean[0] < 80, 'a dry brush stays blue past the red block');
await ed((e) => e.undo());
await stroke('wet', { ...base, size: 14, wet: 0.5 }, line(200, 120, 520));
const wet = await read(305, 180, 40, 40), far = await read(460, 180, 60, 40);
check(wet.mean && wet.mean[0] > 80 && wet.mean[2] > 40, `a wet brush carries red out of the block (${wet.mean.map(Math.round)})`);
check(far.mean && far.mean[2] > far.mean[0] && far.mean[2] > 150, `and recharges with its own colour further on (${far.mean.map(Math.round)})`);
const wetIn = await read(130, 197, 150, 6);
check(wetIn.mean[0] > wet.mean[0] && wetIn.mean[2] > 10, 'inside the block it is redder, but still mixed');
await ed((e) => { e.undo(); e.undo(); });

// ---- Tilt shading stretches dabs along the lean ----
const dot = [300, 300, 1];
await stroke('upright', { ...base, size: 20, tilt: 1 }, dot, { extra: { tilt: [0, 0] } });
const up = await read(250, 250, 100, 100);
await ed((e) => e.undo());
await stroke('leaning', { ...base, size: 20, tilt: 1 }, dot, { extra: { tilt: [60, 0] } });
const lean = await read(250, 250, 100, 100);
check(up.x1 - up.x0 >= 17 && up.x1 - up.x0 <= 21 && Math.abs((up.x1 - up.x0) - (up.y1 - up.y0)) <= 1, `an upright pen makes a round dab (${up.x1 - up.x0}×${up.y1 - up.y0})`);
check(lean.x1 - lean.x0 > (up.x1 - up.x0) * 1.8 && Math.abs((lean.y1 - lean.y0) - (up.y1 - up.y0)) <= 2, `a pen leaning along x stretches it sideways (${lean.x1 - lean.x0}×${lean.y1 - lean.y0})`);
await ed((e) => e.undo());
await stroke('no-tilt-brush', { ...base, size: 20 }, dot, { extra: { tilt: [60, 0] } });
const ignored = await read(250, 250, 100, 100);
check(ignored.x1 - ignored.x0 <= 21, 'tilt data does nothing for a brush without tilt shading');
await ed((e) => e.undo());

// ---- Dab angle on a square tip ----
await stroke('sq-0', { ...base, size: 20, shape: 'square', angle: 0 }, dot);
const sq0 = await read(250, 250, 100, 100);
await ed((e) => e.undo());
await stroke('sq-45', { ...base, size: 20, shape: 'square', angle: 45 }, dot);
const sq45 = await read(250, 250, 100, 100);
check(sq45.x1 - sq45.x0 > (sq0.x1 - sq0.x0) * 1.3, `a 45° square dab is a diamond (${sq0.x1 - sq0.x0} → ${sq45.x1 - sq45.x0} wide)`);
await ed((e) => e.undo());
const diag = []; for (let i = 0; i <= 40; i += 2) diag.push(300 + i, 300 + i, 1);
await stroke('sq-diag', { ...base, size: 20, shape: 'square' }, diag);
const sqd = await read(250, 250, 150, 150);
await ed((e) => e.undo());
await stroke('sq-follow', { ...base, size: 20, shape: 'square', follow: true }, diag);
const sqf = await read(250, 250, 150, 150);
check(sqd.y1 - sqd.y0 <= 62 && sqf.y1 - sqf.y0 >= 66, `following a diagonal stroke turns square dabs into diamonds (${sqd.y1 - sqd.y0} → ${sqf.y1 - sqf.y0} tall)`);
await ed((e) => e.undo());

// ---- Brush editor: grouped sections ----
await page.locator('.topbar [aria-label^="Brush (B)"]').click();
await page.waitForSelector('.brush-library');
await page.getByRole('tab', { name: 'Pen', exact: true }).click();
await page.locator('.brush-row', { hasText: 'Ink Pen' }).hover();
await page.locator('[aria-label="More for Ink Pen"]').click();
await page.locator('.brush-menu .menu-item', { hasText: 'Clone' }).click();
await page.waitForSelector('.brush-edit');
const groups = page.locator('.brush-edit .brush-group');
check((await groups.count()) === 7, 'the editor has seven sections');
check((await page.locator('.brush-group[open]').count()) === 2, 'only Stroke and Pressure start open');
await groups.filter({ hasText: 'Scatter' }).locator('summary').click();
check(await page.locator('.brush-edit .slider[aria-label="Scatter"]').isVisible(), 'opening Scatter shows its sliders');
check(await page.locator('.brush-edit .switch-row', { hasText: 'Angle follows the stroke' }).isVisible(), 'with the follow switch');
await page.screenshot({ path: `${out}/editor.png` });
await page.keyboard.press('Escape');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
void clearLayer;
