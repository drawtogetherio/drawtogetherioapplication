// Selection refinements: feather (soft fills, strokes, moves), grow/shrink, invert, colour range, layer content, save/load.
// Usage: node tests/selection.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/selection';
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
/** Layer RGBA at a document point. */
const px = (x, y) => ed((e, p) => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.translate(-p[0], -p[1]); e.layer.surface.drawTo(g, { x: p[0], y: p[1], w: 1, h: 1 });
  return [...g.getImageData(0, 0, 1, 1).data];
}, [x, y]);
const sel = () => ed((e) => e.selection && { n: e.selection.pts.length / 2, holes: e.selection.holes?.length ?? 0, feather: e.selection.feather ?? 0, bounds: (() => { const xs = e.selection.pts.filter((_, i) => i % 2 === 0), ys = e.selection.pts.filter((_, i) => i % 2 === 1); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round); })() });
const inside = (x, y) => ed((e, p) => { const path = new Path2D(); const pts = e.selection.pts; path.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]); path.closePath(); for (const h of e.selection.holes ?? []) { path.moveTo(h[0], h[1]); for (let i = 2; i < h.length; i += 2) path.lineTo(h[i], h[i + 1]); path.closePath(); } return document.createElement('canvas').getContext('2d').isPointInPath(path, p[0], p[1], 'evenodd'); }, [x, y]);

// Selections are given in document coordinates through the tool itself.
await page.keyboard.press('m');
await ed((e) => { e.settings.selectMode = 'rect'; e.emit('tool'); });
// With the canvas turned, a dragged box still stands upright on screen.
await ed((e) => { const vp = e.view.viewport; vp.rot = Math.PI / 6; vp.onChange(); });
await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(640, 400, { steps: 4 }); await page.mouse.up();
const corners = await ed((e) => { const M = e.view.viewport.matrix(), p = e.selection.pts, out = []; for (let i = 0; i < p.length; i += 2) { const q = M.transformPoint({ x: p[i], y: p[i + 1] }); out.push([q.x, q.y]); } return out; });
const upright = corners.length === 4 && Math.abs(corners[0][0] - corners[3][0]) < 0.5 && Math.abs(corners[1][0] - corners[2][0]) < 0.5 && Math.abs(corners[0][1] - corners[1][1]) < 0.5 && Math.abs(corners[2][1] - corners[3][1]) < 0.5;
check(upright, `rectangle select follows the screen on a rotated view (${corners.map((c) => c.map(Math.round)).join(' ')})`);
await ed((e) => { e.settings.selectMode = 'ellipse'; e.emit('tool'); });
await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(640, 400, { steps: 4 }); await page.mouse.up();
const ell = await ed((e) => { const M = e.view.viewport.matrix(), p = e.selection.pts; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < p.length; i += 2) { const q = M.transformPoint({ x: p[i], y: p[i + 1] }); x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); } return [x0, y0, x1, y1]; });
const sb = await page.locator('canvas.stage').boundingBox();
check(Math.abs(ell[0] + sb.x - 500) < 2 && Math.abs(ell[1] + sb.y - 300) < 2 && Math.abs(ell[2] + sb.x - 640) < 2 && Math.abs(ell[3] + sb.y - 400) < 2, `oval select fills the dragged screen box (${ell.map(Math.round)})`);
await ed((e) => { const vp = e.view.viewport; vp.rot = 0; vp.onChange(); e.selection = null; e.settings.selectMode = 'rect'; e.emit('tool'); e.view.invalidate(null); });
const setSel = (x0, y0, x1, y1) => ed((e, r) => e.tools.select.set({ pts: [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3]] }), [x0, y0, x1, y1]);
await setSel(800, 800, 1200, 1200);
check((await sel()).n === 4, 'a rectangle selection');
for (const t of ['Feather', 'By', 'Grow', 'Shrink', 'Invert', 'Save']) check(await page.locator('.optionsbar', { hasText: t }).count() === 1, `options bar offers ${t}`);

// ---- Grow / shrink ----
await ed((e) => { e.settings.selectGrow = 50; });
await page.locator('.optionsbar button', { hasText: 'Grow' }).click();
let s = await sel();
check(Math.abs(s.bounds[0] - 750) <= 2 && Math.abs(s.bounds[2] - 1250) <= 2, `Grow by 50 widens the box (${s.bounds})`);
check(s.n > 8, 'grown corners are rounded');
await page.locator('.optionsbar button', { hasText: 'Shrink' }).click();
s = await sel();
check(Math.abs(s.bounds[0] - 800) <= 3 && Math.abs(s.bounds[2] - 1200) <= 3, `Shrink by 50 brings it back (${s.bounds})`);

// ---- Invert ----
await page.locator('.optionsbar button', { hasText: 'Invert' }).click();
s = await sel();
check(s.holes === 1 && s.bounds.join() === '0,0,2048,2048', `Invert covers the canvas with the old box as a hole (${s.bounds}, ${s.holes} hole)`);
check(!(await inside(1000, 1000)) && (await inside(100, 100)), 'the old inside is out, the outside is in');
await page.locator('.optionsbar button', { hasText: 'Invert' }).click();
check((await inside(1000, 1000)) && !(await inside(100, 100)) && (await sel()).holes === 0, 'inverting again restores it');

// ---- Feather: fills fade over the edge ----
await ed((e) => { e.setColor('#ff0000'); });
await ed((e) => e.tools.select.feather(20));
check((await sel()).feather === 20, 'feather is set on the selection');
await page.keyboard.press('Alt+Backspace');
await page.waitForTimeout(300);
const centre = await px(1000, 1000), edge = await px(1200, 1000), beyond = await px(1225, 1000), far = await px(1300, 1000);
check(centre[3] === 255, `the middle is solid (${centre})`);
check(edge[3] > 60 && edge[3] < 200, `the edge is half-way (${edge})`);
check(beyond[3] > 0 && beyond[3] < edge[3], `the fade continues past the outline (${beyond})`);
check(far[3] === 0, 'and ends');
check(await ed((e) => e.doc.log.at(-1).clip.feather === 20), 'the op carries the feather for replay');
await page.screenshot({ path: `${out}/01-feather.png` });
// Strokes are soft too.
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);
await page.keyboard.press('b');
await ed((e) => { e.settings.brush.size = 60; e.settings.brush.smoothing = 0; e.prefs.stabilizerOn = false; e.prefs.quickShape = false; });
const toScreen = (x, y) => ed((e, p) => { const s = e.view.viewport.toScreen(p[0], p[1]); return [s.x, s.y]; }, [x, y]);
const a = await toScreen(700, 1000), b = await toScreen(1300, 1000);
await drag([a, b]);
const sIn = await px(1000, 1000), sEdge = await px(1205, 1000), sOut = await px(1300, 1000);
check(sIn[3] > 200 && sEdge[3] > 20 && sEdge[3] < 230 && sOut[3] === 0, `a stroke through a feathered selection fades out (${sIn[3]}, ${sEdge[3]}, ${sOut[3]})`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);
// Moving a feathered selection lifts soft pixels.
await page.keyboard.press('m');
await ed((e) => { e.tools.select.set({ pts: [0, 0, 2048, 0, 2048, 2048, 0, 2048] }); });
await page.keyboard.press('Alt+Backspace');
await page.waitForTimeout(200);
await ed((e) => { e.tools.select.set({ pts: [800, 800, 1200, 800, 1200, 1200, 800, 1200], feather: 20 }); });
const c0 = await toScreen(1000, 1000), c1 = await toScreen(1000, 1300);
await drag([c0, c1]);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const hole = await px(1000, 1000), holeEdge = await px(1000, 800), moved = await px(1000, 1300);
check(hole[3] === 0 && holeEdge[3] > 60 && holeEdge[3] < 200 && moved[3] === 255, `moving lifts a soft-edged piece (${hole[3]}, ${holeEdge[3]}, ${moved[3]})`);
check((await sel()).feather === 20, 'the moved selection keeps its feather');
await page.keyboard.press('Control+z'); await page.waitForTimeout(100);
await page.keyboard.press('Control+z'); await page.waitForTimeout(100);
await ed((e) => e.tools.select.set(null));

// ---- Colour range and content ----
await ed((e) => { e.setColor('#0000ff'); e.settings.shape = 'rect'; e.settings.shapeFill = true; e.settings.brush.size = 2; });
await page.keyboard.press('u');
const r1 = [await toScreen(200, 200), await toScreen(500, 500)], r2 = [await toScreen(1500, 1500), await toScreen(1800, 1800)];
await drag(r1); await drag(r2);
await ed((e) => { e.setColor('#00ff00'); });
await drag([await toScreen(900, 200), await toScreen(1100, 400)]);
await page.keyboard.press('m');
await ed((e) => { e.settings.selectMode = 'range'; e.settings.fillSampleAll = false; e.settings.fillTolerance = 0.1; e.emit('tool'); });
check(await page.locator('.optionsbar .mode-btn, .optionsbar .preset-btn', { hasText: 'Colour range' }).count() >= 1, 'the select tool offers a Colour range mode');
await m.click(...at(...await toScreen(350, 350)));
await page.waitForTimeout(300);
check((await inside(350, 350)) && (await inside(1650, 1650)) && !(await inside(1000, 300)), 'colour range picks both blue boxes but not the green one');
await ed((e) => { e.settings.selectMode = 'wand'; e.emit('tool'); });
await m.click(...at(...await toScreen(350, 350)));
await page.waitForTimeout(300);
check((await inside(350, 350)) && !(await inside(1650, 1650)), 'the wand only takes the touching one');
await ed((e) => e.tools.select.set(null));
await page.locator('.optionsbar button', { hasText: 'Content' }).click();
await page.waitForTimeout(300);
check((await inside(350, 350)) && (await inside(1650, 1650)) && (await inside(1000, 300)) && !(await inside(1000, 1000)), 'Content selects every painted pixel');

// ---- Save and load ----
await page.locator('.optionsbar button', { hasText: 'Save' }).click();
await page.locator('.modal input, dialog input').first().fill('Boxes');
await page.locator('.modal button, dialog button', { hasText: 'Save' }).click();
await page.waitForTimeout(200);
await ed((e) => e.tools.select.set(null));
check(!(await ed((e) => e.selection)), 'deselected');
await page.locator('.optionsbar select.opt-select').selectOption({ label: 'Boxes' });
await page.waitForTimeout(200);
check((await inside(350, 350)) && (await inside(1000, 300)), 'Load brings the saved selection back');
await page.screenshot({ path: `${out}/02-content.png` });

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
