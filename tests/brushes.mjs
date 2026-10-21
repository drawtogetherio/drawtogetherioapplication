// Brush library categories, grain and square tips, the shared smudge/eraser library, the slider preview and baked layer effects.
// Usage: node tests/brushes.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/brushes';
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
const box = await page.locator('canvas.stage').boundingBox();
const m = page.mouse;
const line = async (y, x0 = 300, x1 = 700) => { await m.move(box.x + x0, box.y + y); await m.down(); await m.move(box.x + x1, box.y + y, { steps: 25 }); await m.up(); };
/** Alpha histogram of the active layer inside a canvas-space box. */
const alphas = (r) => ed((e, r) => {
  const l = e.layer.surface, c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
  const x = c.getContext('2d'); x.translate(-r.x, -r.y); l.drawTo(x, r);
  const d = x.getImageData(0, 0, r.w, r.h).data; let full = 0, part = 0, any = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 240) full++; else if (d[i] > 8) part++; if (d[i] > 8) any++; }
  return { full, part, any };
}, r);
// Screen coordinates relative to the canvas element; the view is zoomed out, so boxes are converted to document space.
const docBox = (y, h = 60) => ed((e, p) => {
  const a = e.view.viewport.toDoc(p[0], p[1]), b = e.view.viewport.toDoc(p[2], p[3]);
  return { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) };
}, [280, y - h / 2, 740, y + h / 2]);

// ---- Categories ----
const brushBtn = page.locator('.topbar [aria-label^="Brush (B)"]');
await brushBtn.click();
await page.waitForSelector('.brush-library');
check((await page.locator('.brush-tab').allTextContents()).join() === 'General,Pencil,Pen,Eraser', 'four categories');
await page.locator('.brush-tab', { hasText: 'Pencil' }).click();
check((await page.locator('.brush-row .brush-name').allTextContents()).join() === 'Graphite Pencil,HB Pencil,Crayon,Charcoal', 'Pencil tab lists the pencils');
await page.screenshot({ path: `${out}/01-pencil-tab.png` });
await page.locator('.brush-row', { hasText: 'Crayon' }).click();
check(await ed((e) => e.settings.brushPreset) === 'crayon' && (await page.locator('.optionsbar .slider[aria-label="Grain"]').count()) === 1, 'Crayon picked; the options bar has a Grain slider');

// ---- Grain breaks a stroke up; the plain brush is solid ----
await ed((e) => { e.settings.brush.size = 30; });
await line(200);
const grainy = await alphas(await docBox(200));
await brushBtn.click();
await page.locator('.brush-tab', { hasText: 'General' }).click();
await page.locator('.brush-row', { hasText: 'Round Brush' }).click();
await ed((e) => { e.settings.brush.size = 30; e.settings.brush.hardness = 1; });
await line(300);
const solid = await alphas(await docBox(300));
check(grainy.any > 2000 && grainy.part / grainy.any > 0.25, `crayon stroke is broken up by grain (${Math.round((100 * grainy.part) / grainy.any)}% partial pixels)`);
check(solid.part / solid.any < 0.12, `round brush stroke is solid (${Math.round((100 * solid.part) / solid.any)}% partial)`);

// ---- Square tip: a tap leaves a square ----
await brushBtn.click();
await page.locator('.brush-row', { hasText: 'Cube Brush' }).click();
await ed((e) => { e.settings.brush.size = 40; e.settings.brush.pressureSize = 0; });
await m.click(box.x + 500, box.y + 420);
const sq = await ed((e, p) => {
  const d = e.view.viewport.toDoc(p[0], p[1]), l = e.layer.surface, c = document.createElement('canvas'); c.width = c.height = 60;
  const x = c.getContext('2d'); x.translate(-Math.round(d.x - 30), -Math.round(d.y - 30)); l.drawTo(x, { x: d.x - 30, y: d.y - 30, w: 60, h: 60 });
  const px = (ox, oy) => x.getImageData(30 + ox, 30 + oy, 1, 1).data[3];
  return { corner: px(16, 16), edge: px(0, 16) };
}, [500, 420]);
check(sq.corner > 200 && sq.edge > 200, 'cube brush paints its corners');

// ---- Smudge and eraser use the same library ----
const smudgeBtn = page.locator('.topbar [aria-label^="Smudge"]');
await smudgeBtn.click(); await smudgeBtn.click();
await page.waitForSelector('.brush-library');
check((await page.locator('.brush-library .panel-title').textContent()) === 'Smudge Library' && (await page.locator('.brush-tab').count()) === 4, 'smudge opens the shared library');
await page.locator('.brush-tab', { hasText: 'Pencil' }).click();
await page.locator('.brush-row', { hasText: 'Charcoal' }).click();
check(await ed((e) => e.settings.smudgePreset === 'charcoal' && e.settings.smudge.grain === 0.6 && e.settings.smudge.flow === 0.7), 'smudge takes the charcoal feel with a smudge strength');
await ed((e) => { e.settings.smudge.size = 40; });
await line(300, 320, 520);
check(await ed((e) => e.doc.log.at(-1).t === 'smudge' && e.doc.log.at(-1).brush.grain === 0.6), 'a grainy smudge stroke went through');
const eraserBtn = page.locator('.topbar [aria-label^="Eraser (E)"]');
await eraserBtn.click(); await eraserBtn.click();
await page.getByRole('tab', { name: 'Pen', exact: true }).click();
await page.locator('.brush-row', { hasText: 'Chisel Marker' }).click();
check(await ed((e) => e.settings.eraserPreset) === 'chisel', 'the eraser can be any brush');

// ---- Slider preview ----
await brushBtn.click();
const size = page.locator('.sidebar .slider[aria-label="Size"]');
const sb = await size.boundingBox();
await m.move(sb.x + sb.width / 2, sb.y + sb.height * 0.7); await m.down();
await m.move(sb.x + sb.width / 2, sb.y + sb.height * 0.3, { steps: 6 });
check(await page.locator('.slider-preview').isVisible() && /px · \d+%/.test(await page.locator('.slider-preview-text').textContent()), 'dragging Size shows the brush preview with size and opacity');
await page.screenshot({ path: `${out}/02-slider-preview.png` });
await m.up();
await page.waitForTimeout(700);
check(await page.locator('.slider-preview').isHidden(), 'it goes away after the drag');

// ---- Effects: baked, undoable, and replay the same ----
const before = await ed((e) => e.doc.log.length);
await page.locator('[aria-label="Menu"]').click();
await page.locator('.menu-pop .menu-item', { hasText: 'Layer effects' }).click();
await page.waitForSelector('.modal[aria-label="Layer effects"]');
await page.selectOption('#effect-kind', 'mosaic');
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/03-effects.png` });
await page.getByRole('button', { name: 'Apply' }).click();
check(await ed((e, n) => e.doc.log.length === n + 1 && e.doc.log.at(-1).t === 'effect' && e.doc.log.at(-1).effect === 'mosaic', before), 'mosaic baked in as one effect op');
await page.locator('.layers-pop').count();
for (const effect of ['glitch', 'blur', 'chroma', 'motion']) {
  await page.locator('[aria-label="Menu"]').click();
  await page.locator('.menu-pop .menu-item', { hasText: 'Layer effects' }).click();
  await page.selectOption('#effect-kind', effect);
  await page.getByRole('button', { name: 'Apply' }).click();
}
await page.screenshot({ path: `${out}/04-after-effects.png` });
const replay = await ed((e) => {
  const Doc = e.doc.constructor, copy = new Doc({ ...e.doc.settings });
  for (const op of e.doc.log) copy.apply(JSON.parse(JSON.stringify(op)), { record: false });
  const px = (d) => { const c = document.createElement('canvas'); c.width = c.height = 2048; const x = c.getContext('2d'); d.layers[0].surface.drawTo(x); return x.getImageData(0, 0, 2048, 2048).data; };
  const a = px(e.doc), b = px(copy); let diff = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 2) diff++;
  return { diff, ops: e.doc.log.filter((o) => o.t === 'effect').length };
});
check(replay.ops === 5 && replay.diff === 0, `replaying ${replay.ops} effects reproduces the layer exactly (${replay.diff} channels differ)`);
await page.keyboard.press('Control+z');
check(await ed((e) => e.doc.log.at(-1).t === 'tiles'), 'undo takes an effect back');

console.log(errors.length ? 'Errors:\n' + errors.join('\n') : 'No page errors');
await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed || errors.length ? 1 : 0);
