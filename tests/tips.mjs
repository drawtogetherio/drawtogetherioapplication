// Brush images: a tip shape, a dual tip, a texture that moves with the dab; kept on the device, and a missing one falls back to a round tip.
// Usage: node tests/tips.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/tips';
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

/** A PNG drawn in the page: `draw` paints white shapes on black. */
const png = async (name, w, h, draw) => ({ name, mimeType: 'image/png', buffer: Buffer.from((await page.evaluate(([w, h, src]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; new Function('g', 'w', 'h', src)(g, w, h);
  return c.toDataURL('image/png');
}, [w, h, draw])).split(',')[1], 'base64') });
const bar = await png('bar.png', 64, 16, 'g.fillRect(0, 0, w, h)');
const leftHalf = await png('left.png', 64, 64, 'g.fillRect(0, 0, w / 2, h)');
const stripes = await png('stripes.png', 64, 64, 'for (let x = 0; x < w; x += 8) g.fillRect(x, 0, 4, h)');

const read = (x, y, w, h) => ed((e, r) => {
  const c = document.createElement('canvas'); c.width = r[2]; c.height = r[3];
  const g = c.getContext('2d'); g.translate(-r[0], -r[1]); e.layer.surface.drawTo(g, { x: r[0], y: r[1], w: r[2], h: r[3] });
  const d = g.getImageData(0, 0, r[2], r[3]).data;
  let hash = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  const cols = new Float64Array(r[2]), rows = new Float64Array(r[3]);
  for (let i = 0; i < d.length; i += 4) {
    hash = (Math.imul(hash, 31) + d[i + 3]) | 0;
    const px = (i / 4) % r[2], py = Math.floor(i / 4 / r[2]);
    cols[px] += d[i + 3]; rows[py] += d[i + 3];
    if (d[i + 3] < 40) continue;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); n++;
  }
  const sd = (a, lo, hi) => { const v = [...a].slice(lo + 2, hi - 1), m = v.reduce((s, q) => s + q, 0) / v.length; return m ? Math.sqrt(v.reduce((s, q) => s + (q - m) ** 2, 0) / v.length) / m : 0; };
  return { hash, x0, y0, x1, y1, n, colVar: sd(cols, x0, x1), rowVar: sd(rows, y0, y1) };
}, [x, y, w, h]);
const base = { size: 40, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: 0, pressureFlow: 0, minSize: 0.1, smoothing: 0 };
const dot = (id, brush, pts = [300, 300, 1]) => ed((e, o) => e.run([{ t: 'stroke', id: o.id, layer: e.activeLayer, erase: false, brush: o.brush, color: '#000000', pts: o.pts }], 'stroke'), { id, brush, pts });
const undo = () => ed((e) => e.undo());

// ---- A tip image through the editor ----
await page.locator('.topbar [aria-label^="Brush (B)"]').click();
await page.waitForSelector('.brush-library');
await page.getByRole('tab', { name: 'Pen', exact: true }).click();
await page.locator('.brush-row', { hasText: 'Ink Pen' }).hover();
await page.locator('[aria-label="More for Ink Pen"]').click();
await page.locator('.brush-menu .menu-item', { hasText: 'Clone' }).click();
await page.waitForSelector('.brush-edit');
await page.fill('.brush-edit input[aria-label="Brush name"]', 'Bar tip');
await page.locator('.brush-edit .segmented button', { hasText: 'Image…' }).click();
await page.locator('.brush-edit .asset-file').setInputFiles(bar);
await page.waitForSelector('.brush-edit .asset-thumb');
check(await page.locator('.brush-edit .segmented button.active').textContent() === 'Image…', 'picking a picture makes it the tip');
await page.locator('.modal-actions .btn.primary').click();
await page.waitForSelector('.brush-edit', { state: 'detached' });
const tipId = await ed((e) => e.prefs.customBrushes[0]?.params.shape);
check(/^[0-9a-f]{32}$/.test(tipId ?? ''), `the brush keeps the image by content id (${tipId})`);
await page.keyboard.press('Escape');

await dot('bar-1', { ...base, shape: tipId });
const b1 = await read(250, 250, 100, 100);
check(b1.x1 - b1.x0 >= 38 && b1.y1 - b1.y0 <= 12, `a bar tip stamps a bar (${b1.x1 - b1.x0}×${b1.y1 - b1.y0})`);
await undo();
await dot('bar-90', { ...base, shape: tipId, angle: 90 });
const b2 = await read(250, 250, 100, 100);
check(b2.y1 - b2.y0 >= 38 && b2.x1 - b2.x0 <= 12, `turned 90° it stands up (${b2.x1 - b2.x0}×${b2.y1 - b2.y0})`);
await undo();

// ---- Dual tip cuts the dab ----
await ed((e) => { const b = e.prefs.customBrushes[0]; b.params.shape = 'square'; e.emit('prefs'); });
await page.locator('.topbar [aria-label^="Brush (B)"]').click();
await page.waitForSelector('.brush-library');
await page.locator('.brush-row', { hasText: 'Bar tip' }).hover();
await page.locator('[aria-label="More for Bar tip"]').click();
await page.locator('.brush-menu .menu-item', { hasText: 'Edit' }).click();
await page.waitForSelector('.brush-edit');
await page.locator('.brush-group', { hasText: 'Dual tip' }).locator('summary').click();
await page.locator('.brush-group', { hasText: 'Dual tip' }).locator('button', { hasText: 'Choose image…' }).click();
await page.locator('.brush-edit .asset-file').setInputFiles(leftHalf);
await page.waitForSelector('.brush-group .asset-thumb');
await page.locator('.modal-actions .btn.primary').click();
await page.waitForSelector('.brush-edit', { state: 'detached' });
await page.keyboard.press('Escape');
const dualId = await ed((e) => e.prefs.customBrushes[0]?.params.dual);
check(/^[0-9a-f]{32}$/.test(dualId ?? ''), 'the dual tip is saved by id');
await dot('dual', { ...base, shape: 'square', dual: dualId, dualScale: 1 });
const d1 = await read(250, 250, 100, 100);
check(d1.x0 >= 28 && d1.x1 <= 52 && d1.y1 - d1.y0 >= 38, `a left-half dual tip keeps only the left half of a square dab (x ${d1.x0}..${d1.x1})`);
await undo();

// ---- A texture that moves with the dab ----
await ed((e) => { const b = e.prefs.customBrushes[0]; delete b.params.dual; e.emit('prefs'); });
await page.locator('.topbar [aria-label^="Brush (B)"]').click();
await page.waitForSelector('.brush-library');
await page.locator('.brush-row', { hasText: 'Bar tip' }).hover();
await page.locator('[aria-label="More for Bar tip"]').click();
await page.locator('.brush-menu .menu-item', { hasText: 'Edit' }).click();
await page.waitForSelector('.brush-edit');
const tex = page.locator('.brush-group', { hasText: 'Texture' });
if (!(await tex.getAttribute('open'))) await tex.locator('summary').click();
await tex.locator('button', { hasText: 'Texture image…' }).click();
await page.locator('.brush-edit .asset-file').setInputFiles(stripes);
await page.waitForSelector('.brush-group .asset-thumb');
await page.locator('.modal-actions .btn.primary').click();
await page.waitForSelector('.brush-edit', { state: 'detached' });
await page.keyboard.press('Escape');
const texId = await ed((e) => e.prefs.customBrushes[0]?.params.texture);
check(/^[0-9a-f]{32}$/.test(texId ?? ''), 'the texture is saved by id');
const textured = { ...base, size: 60, shape: 'square', grain: 1, grainScale: 1, texture: texId };
await dot('tex-fixed', textured);
const t1 = await read(260, 260, 80, 80);
check(t1.colVar > 0.25 && t1.rowVar < 0.1, `vertical stripes fixed to the paper vary across x only (${t1.colVar.toFixed(2)} / ${t1.rowVar.toFixed(2)})`);
await undo();
await dot('tex-move', { ...textured, grainMove: true, angle: 90 });
const t2 = await read(260, 260, 80, 80);
check(t2.rowVar > 0.25 && t2.colVar < 0.1, `a moving texture turns with the dab: stripes now vary across y (${t2.colVar.toFixed(2)} / ${t2.rowVar.toFixed(2)})`);
await undo();

// ---- Missing image: still draws ----
await dot('missing', { ...base, shape: '00000000000000000000000000000000' });
const m1 = await read(250, 250, 100, 100);
check(m1.n > 500 && Math.abs((m1.x1 - m1.x0) - (m1.y1 - m1.y0)) <= 2, 'a brush whose image is missing draws a round dab');
await undo();

// ---- Kept on the device: the saved brush's images load with the prefs ----
await ed((e, id) => { e.prefs.customBrushes[0].params.shape = id; e.emit('prefs'); }, tipId);
await dot('bar-again', { ...base, shape: tipId });
const before = await read(250, 250, 100, 100);
await undo();
await page.waitForTimeout(700);
await page.reload();
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await ed((e) => e.setTool('brush'));
await page.waitForTimeout(500);
await dot('bar-after', { ...base, shape: tipId });
await page.waitForTimeout(100);
const after = await read(250, 250, 100, 100);
const stored = await page.evaluate(async (id) => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('doodlehive'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  if (!db.objectStoreNames.contains('assets')) return 'no store (v' + db.version + ')';
  const v = await new Promise((res) => { const q = db.transaction('assets').objectStore('assets').get(id); q.onsuccess = () => res(q.result); });
  return v ? v.length + ' bytes' : 'absent';
}, tipId);
check(after.hash === before.hash, `after a reload the tip image comes back from IndexedDB and draws the same (${stored}; ${before.x1 - before.x0}×${before.y1 - before.y0} → ${after.x1 - after.x0}×${after.y1 - after.y0})`);
await undo();
await page.screenshot({ path: `${out}/done.png` });

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
