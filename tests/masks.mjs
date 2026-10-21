// Clipping masks and layer masks: compositing, editing the mask, applying it, undo and replay. Usage: node tests/masks.mjs [url]
import { chromium } from '@playwright/test';

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const ed = (fn, arg) => page.evaluate(([src, a]) => new Function('ed', 'a', `return (${src})(ed, a)`)(window.doodlehive.ed, a), [fn.toString(), arg]);

await page.goto(process.argv[2] ?? 'http://localhost:4180/app.html');
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await page.waitForSelector('canvas.stage');

const rect = (x0, y0, x1, y1, color, extra = {}) => ed((e, a) => {
  e.apply({ t: 'shape', id: Math.random().toString(36).slice(2), layer: e.activeLayer, shape: 'rect', x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1, width: 0, fill: true, color: a.color, opacity: 1, erase: false, ...a.extra });
}, { x0, y0, x1, y1, color, extra });
/** Composited colour at a document point, read back from the stage. */
const at = (x, y) => ed((e, a) => {
  e.view.renderNow();
  const p = e.view.viewport.toScreen(a.x, a.y), d = e.view.dpr;
  const px = e.view.canvas.getContext('2d').getImageData(Math.round(p.x * d), Math.round(p.y * d), 1, 1).data;
  return [px[0], px[1], px[2]];
}, { x, y });
const alphaAt = (x, y, mask) => ed((e, a) => {
  const l = e.layer, s = a.mask ? l.mask : l.surface;
  if (!s) return -1;
  return s.extract({ x: a.x, y: a.y, w: 1, h: 1 }).getContext('2d').getImageData(0, 0, 1, 1).data[3];
}, { x, y, mask });
const near = (c, r, g, b) => Math.abs(c[0] - r) < 8 && Math.abs(c[1] - g) < 8 && Math.abs(c[2] - b) < 8;

// ---- Clipping ----
await rect(200, 200, 600, 600, '#ff0000');
await ed((e) => e.addLayer());
await rect(400, 400, 1000, 1000, '#0000ff');
check(near(await at(800, 800), 0, 0, 255) && near(await at(500, 500), 0, 0, 255), 'the upper layer shows everywhere it has pixels');
await page.locator('[aria-label^="Layers"]').click();
await page.locator('[aria-label="Clip to the layer below"]').click();
check(near(await at(800, 800), 255, 255, 255) && near(await at(500, 500), 0, 0, 255), 'clipped, it shows only where the layer below has pixels');
check((await page.locator('.layer-row.clipped').count()) === 1 && (await page.locator('.layer-row.clipped small').textContent()).includes('Clipped'), 'the row is marked as clipped');
await ed((e) => { e.apply({ t: 'layer.props', id: 'hidebase', layer: e.doc.layers[0].props.id, props: { visible: false } }); });
check(near(await at(500, 500), 255, 255, 255), 'hiding the base hides its clipped layers too');
await ed((e) => e.undo());

// ---- Layer mask ----
await page.locator('[aria-label="Add mask"]').click();
check((await page.locator('.mask-thumb.editing').count()) === 1 && (await page.locator('.mask-hint').isVisible()), 'adding a mask opens it for editing');
await rect(400, 400, 700, 700, '#000000', { mask: true });
check(near(await at(550, 550), 255, 0, 0) && near(await at(800, 800), 255, 255, 255), 'painting on the mask hides the layer there');
check(await alphaAt(550, 550, false) === 255 && await alphaAt(550, 550, true) === 255, 'the pixels stay; the mask holds the hidden area');
await rect(450, 450, 500, 500, '#000000', { mask: true, erase: true });
check(near(await at(475, 475), 0, 0, 255), 'erasing on the mask shows the layer again');
await page.locator('.layer-row.active .layer-thumb:not(.mask-thumb)').click();
check((await page.locator('.mask-thumb.editing').count()) === 0 && (await ed((e) => e.maskEdit)) === false, 'clicking the pixel thumbnail leaves mask editing');
await page.locator('[aria-label="Apply mask to pixels"]').click();
check(await alphaAt(550, 550, false) === 0 && await alphaAt(475, 475, false) === 255 && (await ed((e) => !e.layer.mask && !e.layer.props.mask)), 'applying bakes the mask into the pixels and removes it');
await ed((e) => e.undo());
check(await alphaAt(550, 550, false) === 255 && await alphaAt(550, 550, true) === 255 && (await ed((e) => !!e.layer.mask)), 'undo brings the mask and the pixels back');
await page.locator('[aria-label="Delete mask"]').click();
check(await alphaAt(550, 550, true) === -1 && near(await at(550, 550), 0, 0, 255), 'deleting the mask shows the whole layer');
await ed((e) => e.undo());
check(await alphaAt(550, 550, true) === 255, 'undo restores the deleted mask with its pixels');

// ---- Replay ----
const replay = await ed((e) => {
  const Doc = e.doc.constructor, copy = new Doc({ ...e.doc.settings });
  for (const op of e.doc.log) copy.apply(structuredClone(op), { record: false });
  const px = (s) => { const c = document.createElement('canvas'); c.width = c.height = 1024; const x = c.getContext('2d'); s?.drawTo(x); return x.getImageData(0, 0, 1024, 1024).data; };
  let diff = 0;
  for (const [a, b] of [[e.doc.layers[1].surface, copy.layers[1].surface], [e.doc.layers[1].mask, copy.layers[1].mask]]) {
    const pa = px(a), pb = px(b);
    for (let i = 0; i < pa.length; i++) if (Math.abs(pa[i] - pb[i]) > 2) diff++;
  }
  return { diff, clip: copy.layers[1].props.clip, mask: !!copy.layers[1].mask };
});
check(replay.diff === 0 && replay.clip === true && replay.mask, `replaying the log reproduces the clipped, masked layer (${replay.diff} channels differ)`);

console.log(errors.length ? errors : 'No page errors');
await browser.close();
if (failed || errors.length) process.exit(1);
console.log('all passed');
