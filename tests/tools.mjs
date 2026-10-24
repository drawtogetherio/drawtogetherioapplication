// Fill lasso (inside lines or not), magic wand with holes, the rope stabilizer and over-long strokes.
// Usage: node tests/tools.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/tools';
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
/** Alpha and colour of the active layer at a screen point. */
const pixel = (sx, sy) => ed((e, p) => {
  const d = e.view.viewport.toDoc(p[0], p[1]);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const x = c.getContext('2d'); x.translate(-Math.floor(d.x), -Math.floor(d.y)); e.layer.surface.drawTo(x, { x: Math.floor(d.x), y: Math.floor(d.y), w: 1, h: 1 });
  return [...x.getImageData(0, 0, 1, 1).data];
}, [sx, sy]);
const drag = async (pts) => { await m.move(...at(...pts[0])); await m.down(); for (const p of pts.slice(1)) await m.move(...at(...p), { steps: 3 }); await m.up(); };
const circle = (cx, cy, r, n = 48) => Array.from({ length: n + 1 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cy + Math.sin((i / n) * Math.PI * 2) * r]);

// A black ring: the "line art".
await ed((e) => { e.setColor('#000000'); e.settings.brush.size = 12; e.settings.brush.smoothing = 0; e.prefs.stabilizerOn = false; });
await drag(circle(500, 400, 120));
await page.waitForTimeout(100);
check((await pixel(620, 400))[3] > 200, 'ring drawn');

// ---- Fill lasso, inside lines ----
await page.keyboard.press('g');
await ed((e) => { e.settings.fillMode = 'lasso'; e.emit('tool'); });
check(await page.locator('.optionsbar .preset-btn', { hasText: 'Fill lasso' }).isVisible(), 'the bucket’s mode menu offers the fill lasso');
check(await page.locator('.optionsbar .check', { hasText: 'Fill inside lines' }).isVisible(), 'options show the inside-lines toggle');
await ed((e) => { e.setColor('#ff0000'); e.settings.lassoInside = true; e.settings.fillSampleAll = false; });
// Lasso a square around the ring and beyond it: only the inside of the ring should fill.
await drag([[330, 230], [700, 230], [700, 570], [330, 570], [330, 230]]);
await page.waitForTimeout(300);
const inside = await pixel(500, 400), outside = await pixel(345, 245), onLine = await pixel(620, 400);
check(inside[3] > 200 && inside[0] > 200 && inside[1] < 50, `inside the ring is red (${inside})`);
check(outside[3] === 0, `outside the ring, inside the lasso, stays empty (${outside})`);
check(onLine[0] < 60 && onLine[3] > 200, `the line itself stays black (${onLine})`);
await page.screenshot({ path: `${out}/01-lasso-inside.png` });

// ---- Fill lasso, plain ----
await ed((e) => { e.setColor('#0000ff'); e.settings.lassoInside = false; });
await drag([[300, 100], [440, 100], [440, 220], [300, 220], [300, 100]]);
await page.waitForTimeout(200);
const plain = await pixel(370, 160);
check(plain[2] > 200 && plain[3] > 200, `plain lasso fills its whole shape (${plain})`);
check(await ed((e) => e.doc.log.filter((o) => o.t === 'fillPoly').length) === 2, 'two fillPoly ops in the log');
await ed((e) => e.undo());
check((await pixel(370, 160))[3] === 0, 'undo removes the lasso fill');

// ---- Magic wand ----
await page.keyboard.press('m');
await ed((e) => { e.settings.selectMode = 'wand'; e.setTool('brush'); e.setTool('select'); });
check(await page.locator('.optionsbar .opt-label', { hasText: 'Reference' }).isVisible(), 'wand shows tolerance and reference options');
await m.click(...at(500, 400));
await page.waitForTimeout(300);
let sel = await ed((e) => e.selection && { n: e.selection.pts.length, holes: e.selection.holes?.length ?? 0 });
check(sel && sel.n >= 6 && sel.holes === 0, `wand on the red disc selects one ring (${JSON.stringify(sel)})`);
const bounds = await ed((e) => { const xs = e.selection.pts.filter((_, i) => i % 2 === 0); return [Math.min(...xs), Math.max(...xs)]; });
const ringDoc = await ed((e, p) => [e.view.viewport.toDoc(p[0], p[1]).x, e.view.viewport.toDoc(p[2], p[3]).x], [...at(380, 400), ...at(620, 400)].map((v, i) => v - (i % 2 ? box.y : box.x)));
check(bounds[0] > ringDoc[0] && bounds[1] < ringDoc[1], `the selection sits inside the ring (${bounds.map(Math.round)} within ${ringDoc.map(Math.round)})`);
// The empty area around the ring: one ring with a hole where the disc is.
await m.click(...at(345, 245));
await page.waitForTimeout(400);
sel = await ed((e) => e.selection && { n: e.selection.pts.length, holes: e.selection.holes?.length ?? 0 });
check(sel && sel.holes === 1, `wand on the background selects around the disc with a hole (${JSON.stringify(sel)})`);
await page.screenshot({ path: `${out}/02-wand.png` });
// Painting inside the hole does nothing; outside it does.
await ed((e) => { e.setTool('brush'); e.setColor('#00ff00'); e.settings.brush.size = 30; });
await drag([[470, 400], [530, 400]]);
await drag([[320, 650], [380, 650]]);
await page.waitForTimeout(200);
const hole = await pixel(500, 400), ok = await pixel(350, 650);
check(hole[1] < 100 && ok[1] > 200, `the hole is protected, the rest paints (${hole} / ${ok})`);
await ed((e) => { e.selection = null; e.emit('selection'); });

// ---- Stabilizer ----
await ed((e) => { e.prefs.stabilizerOn = true; e.prefs.stabilizer = 1; e.settings.brush.size = 6; e.setColor('#000000'); });
await m.move(...at(200, 500)); await m.down();
await m.move(...at(400, 500), { steps: 4 });
const tether = await ed((e) => e.tools.brush.tether && { ...e.tools.brush.tether, pts: e.tools.brush['pts'].length });
check(tether && tether.cx - tether.bx > 50, `the brush trails the cursor on the rope (${tether && Math.round(tether.cx - tether.bx)} px behind)`);
await page.screenshot({ path: `${out}/03-rope.png` });
await m.up();
await page.waitForTimeout(200);
const end = await ed((e) => { const op = e.doc.log.at(-1); return [op.t, op.pts.at(-3), e.tools.brush.tether]; });
check(end[0] === 'stroke' && Math.abs(end[1] - tether.bx) < 2 && !end[2], `lifting ends the line where the brush was (${Math.round(end[1])} vs ${Math.round(tether.bx)})`);
await ed((e) => { e.prefs.stabilizerOn = false; });

// ---- Very long strokes split instead of failing ----
const before = await ed((e) => e.doc.log.filter((o) => o.t === 'stroke').length);
await page.evaluate(async ([box]) => {
  const c = document.querySelector('canvas.stage');
  const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', clientX: box.x + x, clientY: box.y + y, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
  fire('pointerdown', 300, 650);
  for (let i = 0; i < 45_000; i++) fire('pointermove', 300 + (i % 200), 650 + Math.floor(i / 200) % 40);
  fire('pointerup', 300, 650);
}, [box]);
await page.waitForTimeout(500);
const after = await ed((e) => { const s = e.doc.log.filter((o) => o.t === 'stroke'); return { n: s.length, max: Math.max(...s.map((o) => o.pts.length)) }; });
check(after.n - before === 2 && after.max <= 120_000, `a 45k-sample stroke lands as ${after.n - before} ops, longest ${after.max / 3} samples`);
check(await ed((e) => e.doc.history.canUndo), 'and stays in history');

console.log(errors.length ? 'Errors:\n' + errors.join('\n') : 'No page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
