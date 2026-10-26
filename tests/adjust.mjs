// Colour adjustments: baked from the effects bar, and live on adjustment layers.
// Usage: node tests/adjust.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/adjust';
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
const at = (x, y) => [box.x + x, box.y + y];
const drag = async (pts) => { await m.move(...at(...pts[0])); await m.down(); for (const p of pts.slice(1)) await m.move(...at(...p), { steps: 3 }); await m.up(); await page.waitForTimeout(150); };
const layerPixel = (sx, sy) => ed((e, p) => {
  const d = e.view.viewport.toDoc(p[0], p[1]), x = Math.floor(d.x), y = Math.floor(d.y);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.translate(-x, -y); e.layer.surface.drawTo(g, { x, y, w: 1, h: 1 });
  return [...g.getImageData(0, 0, 1, 1).data];
}, [sx, sy]);
/** What is on screen at a stage point. */
const screenPixel = async (sx, sy) => { await page.waitForTimeout(250); return page.evaluate(([x, y]) => {
  const c = document.querySelector('canvas.stage'), k = c.width / c.clientWidth;
  const g = document.createElement('canvas'); g.width = g.height = 1;
  const x2 = g.getContext('2d'); x2.drawImage(c, Math.round(x * k), Math.round(y * k), 1, 1, 0, 0, 1, 1);
  return [...x2.getImageData(0, 0, 1, 1).data];
}, [sx, sy]); };
const near = (p, r, g, b, tol = 12) => Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - b) <= tol;
const c = [box.width / 2, box.height / 2];
const adjust = (effect, params, colors) => ed((e, a) => e.applyPrepared({ t: 'effect', id: Math.random().toString(36).slice(2, 10), layer: e.activeLayer, effect: a[0], amount: 1, params: a[1], colors: a[2] }), [effect, params, colors]);

// A red square.
await ed((e) => { e.setColor('#ff0000'); e.settings.shape = 'rect'; e.settings.shapeFill = true; e.settings.brush.size = 2; });
await page.keyboard.press('u');
await drag([[c[0] - 150, c[1] - 150], [c[0] + 150, c[1] + 150]]);
check(near(await layerPixel(c[0], c[1]), 255, 0, 0), 'red square drawn');

// ---- Effects popover lists the adjustments ----
await page.locator('.topbar button[title="Effects"]').click();
const items = await page.locator('.effects-pop .menu-item').allInnerTexts();
check(items.includes('Hue / saturation / brightness') && items.includes('Curves') && items.includes('Gradient map'), 'effects popover offers the adjustments');
check(await page.locator('.effects-pop .menu-label', { hasText: 'Adjust' }).isVisible(), 'under an Adjust heading');

// ---- Bake an invert from the bar ----
await page.locator('.effects-pop .menu-item', { hasText: 'Invert' }).click();
const bar = page.locator('.effect-bar');
check(await bar.isVisible() && (await bar.locator('select').inputValue()) === 'invert', 'the effects bar opens on Invert');
check((await bar.locator('.slider-label').first().innerText()) === 'Mix', 'amount reads Mix for adjustments');
await bar.locator('button[title="Apply"]').click();
await page.waitForTimeout(400);
check(near(await layerPixel(c[0], c[1]), 0, 255, 255), `invert bakes cyan (${await layerPixel(c[0], c[1])})`);
check(await ed((e) => e.doc.log.at(-1).t === 'effect' && e.doc.log.at(-1).effect === 'invert'), 'as one effect op');
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);

// ---- The others, by op ----
await adjust('hsb', [0.5, 0, 0]); await page.waitForTimeout(300);
let px = await layerPixel(c[0], c[1]);
check(near(px, 128, 255, 0, 14), `hue +90° turns red to chartreuse (${px})`);
await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
await adjust('gradientMap', undefined, ['#000000', '#ffffff']); await page.waitForTimeout(300);
px = await layerPixel(c[0], c[1]);
check(near(px, 54, 54, 54, 6), `gradient map black→white gives red's luminance (${px})`);
await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
await adjust('curves', [0, 1, 1, 0]); await page.waitForTimeout(300);
check(near(await layerPixel(c[0], c[1]), 0, 255, 255), 'a falling curve inverts');
await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
await adjust('levels', [0, 0.5, 1, 0, 1]); await page.waitForTimeout(300);
await ed((e) => { e.setColor('#808080'); });
check(near(await layerPixel(c[0], c[1]), 255, 0, 0), 'levels keeps pure red red');
await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
await adjust('balance', [0, 0, 1]); await page.waitForTimeout(300);
px = await layerPixel(c[0], c[1]);
check(px[2] > 40 && px[0] === 255, `colour balance pushes blue into the midtone red (${px})`);
await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/01-baked.png` });

// ---- Adjustment layer ----
await page.keyboard.press('l');
await page.locator('.layers-panel button[title="New adjustment layer"]').click();
await page.locator('.adjust-pick .menu-item', { hasText: 'Invert' }).click();
await page.waitForTimeout(300);
check(await ed((e) => !!e.layer?.props.adjust && e.layer.props.adjust.effect === 'invert'), 'a new layer carries the adjustment');
check(await page.locator('.effect-bar[aria-label="Adjustment layer"]').isVisible(), 'its settings open in the bar');
check(await page.locator('.layers-panel .adjust-thumb').count() === 1, 'the row shows an adjustment badge');
let seen = await screenPixel(c[0], c[1]);
check(near(seen, 0, 255, 255), `the canvas shows the square inverted live (${seen})`);
await page.locator('.effect-bar button[title="Apply"]').click();
await page.waitForTimeout(300);
check(await ed((e) => e.doc.log.at(-1).t === 'layer.props' && e.doc.log.at(-1).props.adjust.effect === 'invert'), 'Apply saves it as a layer.props op');
// The pixel layer itself is untouched.
check(await ed((e) => { const l = e.doc.layers.find((l) => !l.props.adjust); const d = l.surface.extract({ x: 1000, y: 1000, w: 1, h: 1 }).getContext('2d').getImageData(0, 0, 1, 1).data; return d[0] === 255 && d[1] === 0; }), 'the pixel layer still holds red');
// Hide it: back to red.
await page.keyboard.press('l');
await page.locator('.layers-panel .layer-row.active .vis').click();
seen = await screenPixel(c[0], c[1]);
check(near(seen, 255, 0, 0), `hiding the adjustment layer shows red again (${seen})`);
await page.locator('.layers-panel .layer-row.active .vis').click();
// Opacity mixes.
await ed((e) => e.apply({ t: 'layer.props', id: 'opx1', layer: e.activeLayer, props: { opacity: 0.5 } }));
seen = await screenPixel(c[0], c[1]);
check(near(seen, 128, 128, 128, 10), `half opacity gives half the inversion (${seen})`);
await ed((e) => e.apply({ t: 'layer.props', id: 'opx2', layer: e.activeLayer, props: { opacity: 1 } }));
// Painting on it goes nowhere; its mask limits it.
await page.keyboard.press('b');
await ed((e) => { e.setColor('#000000'); e.settings.brush.size = 40; });
await drag([[c[0] - 100, c[1] - 100], [c[0] + 100, c[1] + 100]]);
check(await ed((e) => e.doc.log.at(-1).t !== 'stroke'), 'strokes on an adjustment layer are refused');
await ed((e) => e.setMask(true));
await page.waitForTimeout(200);
await ed((e) => e.setActiveLayer(e.activeLayer, true));
await drag([[c[0] - 100, c[1]], [c[0] + 100, c[1]]]);
seen = await screenPixel(c[0], c[1]);
const seenEdge = await screenPixel(c[0], c[1] - 120);
check(near(seen, 255, 0, 0) && near(seenEdge, 0, 255, 255), `painting the mask hides the inversion there (${seen} vs ${seenEdge})`);
await page.screenshot({ path: `${out}/02-layer.png` });
// Clipped to the layer below: only where it has pixels (the paper stays white).
await ed((e) => e.toggleClip());
const paper = await screenPixel(c[0] - 250, c[1] - 250);
check(near(paper, 255, 255, 255), `clipped adjustment leaves the paper white (${paper})`);
await ed((e) => e.toggleClip());
// Clicking the badge reopens the editor; Cancel restores.
if (await page.locator('.layers-pop').isHidden()) await page.keyboard.press('l');
await page.locator('.layers-panel .layer-row.active .adjust-thumb').click();
check(await page.locator('.effect-bar[aria-label="Adjustment layer"]').isVisible(), 'clicking the badge reopens the settings');
await page.locator('.effect-bar select').selectOption('hsb');
await page.waitForTimeout(100);
check(await page.locator('.effect-bar .adjust-row .slider').count() === 3, 'HSB shows three sliders');
await page.locator('.effect-bar button[title="Cancel"]').click();
check(await ed((e) => e.layer.props.adjust.effect === 'invert'), 'Cancel keeps the saved adjustment');

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
