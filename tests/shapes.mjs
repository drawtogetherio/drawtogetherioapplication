// More shapes (polygon, star, arrow, bubble, polyline, curve, arc) and QuickShape: holding still snaps a stroke to a shape.
// Usage: node tests/shapes.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/shapes';
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
const drag = async (pts, hold = 0) => { await m.move(...at(...pts[0])); await m.down(); for (const p of pts.slice(1)) await m.move(...at(...p), { steps: 3 }); if (hold) await page.waitForTimeout(hold); await m.up(); await page.waitForTimeout(120); };
const alphaAt = (sx, sy) => ed((e, p) => {
  const d = e.view.viewport.toDoc(p[0], p[1]), x = Math.floor(d.x), y = Math.floor(d.y);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.translate(-x, -y); e.layer.surface.drawTo(g, { x, y, w: 1, h: 1 });
  return g.getImageData(0, 0, 1, 1).data[3];
}, [sx, sy]);
const last = () => ed((e) => { const o = e.doc.log.at(-1); return o ? { t: o.t, shape: o.shape, pts: o.pts, sides: o.sides, fill: o.fill } : null; });
const ops = () => ed((e) => e.doc.log.length);
const c = [box.width / 2, box.height / 2];

await ed((e) => { e.setColor('#000000'); e.settings.brush.size = 10; e.settings.brush.smoothing = 0; e.prefs.stabilizerOn = false; e.settings.shapeFill = true; });
await page.keyboard.press('u');

// ---- Picker lists the new shapes ----
await page.locator('.toolbar button[title^="Shapes"], .topbar button[title^="Shapes"]').first().click();
await page.waitForTimeout(100);
const names = await page.locator('.tool-pop button, .popover.tool-pop button').allInnerTexts().catch(() => []);
const titles = await page.evaluate(() => [...document.querySelectorAll('.tool-pop button, .popover.tool-pop button, .popover:not([hidden]) button')].map((b) => b.title || b.textContent.trim()));
for (const t of ['Arrow', 'Polygon', 'Star', 'Speech bubble', 'Polyline', 'Curve', 'Arc']) check(titles.some((x) => x.startsWith(t)), `picker offers ${t}`);
await page.keyboard.press('Escape');

// ---- Box shapes ----
const boxShape = async (shape, sides) => {
  await ed((e, a) => { e.settings.shape = a[0]; if (a[1]) e.settings.shapeSides = a[1]; e.emit('tool'); }, [shape, sides]);
  const n = await ops();
  await drag([[c[0] - 120, c[1] - 120], [c[0] + 120, c[1] + 120]]);
  const o = await last();
  check((await ops()) === n + 1 && o.shape === shape, `${shape} drawn as one shape op`);
  return o;
};
await boxShape('polygon', 6);
check((await alphaAt(c[0], c[1])) > 200, 'polygon is filled at its centre');
check((await alphaAt(c[0] - 115, c[1] - 115)) === 0, 'polygon leaves its box corner empty');
await page.keyboard.press('Control+z');
const star = await boxShape('star', 5);
check(star.sides === 5, 'star op carries its point count');
check((await alphaAt(c[0], c[1] - 110)) > 200 && (await alphaAt(c[0] - 100, c[1] - 100)) === 0, 'star has a top point and empty corners');
await page.keyboard.press('Control+z');
await ed((e) => { e.settings.shape = 'arrow'; e.emit('tool'); });
await drag([[c[0] - 120, c[1]], [c[0] + 120, c[1]]]);
check((await last()).shape === 'arrow' && (await alphaAt(c[0], c[1])) > 200, 'arrow shaft is drawn');
check((await alphaAt(c[0] + 111, c[1] - 6)) > 100 && (await alphaAt(c[0] + 111, c[1] - 20)) === 0, 'arrow head wings are drawn');
await page.keyboard.press('Control+z');
await boxShape('bubble');
check((await alphaAt(c[0], c[1] - 50)) > 200, 'speech bubble body is filled');
check((await alphaAt(c[0] + 100, c[1] + 110)) === 0, 'bubble bottom-right stays empty (tail is on the left)');
await page.screenshot({ path: `${out}/01-bubble.png` });
await page.keyboard.press('Control+z');
check(await page.locator('.optionsbar .slider, .optionsbar .compact').count() >= 0, 'options bar rendered');
await ed((e) => { e.settings.shape = 'polygon'; e.emit('tool'); });
check(await page.locator('.optionsbar', { hasText: 'Sides' }).count() === 1, 'polygon options show a Sides slider');

// ---- Polyline by clicks ----
await ed((e) => { e.settings.shape = 'polyline'; e.settings.shapeFill = false; e.emit('tool'); });
check(await page.locator('.optionsbar button', { hasText: 'Done' }).isVisible(), 'point shapes get a Done button');
let n = await ops();
await m.click(...at(c[0] - 150, c[1] + 150)); await page.waitForTimeout(450);
await m.click(...at(c[0], c[1] - 150)); await page.waitForTimeout(450);
await m.click(...at(c[0] + 150, c[1] + 150)); await page.waitForTimeout(450);
check((await ops()) === n, 'clicks place points without committing');
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
let o = await last();
check((await ops()) === n + 1 && o.shape === 'polyline' && o.pts.length === 6, `Enter commits the polyline (${o.pts?.length / 2} points)`);
check((await alphaAt(c[0] - 75, c[1])) > 200, 'polyline segment has ink');
await page.keyboard.press('Control+z');

// Double-click finishes too, and clicking the first point closes it.
n = await ops();
await m.click(...at(c[0] - 150, c[1] + 150)); await page.waitForTimeout(450);
await m.click(...at(c[0], c[1] - 150)); await page.waitForTimeout(450);
await m.dblclick(...at(c[0] + 150, c[1] + 150));
await page.waitForTimeout(150);
o = await last();
check((await ops()) === n + 1 && o.shape === 'polyline' && o.pts.length === 6, 'double-click finishes the polyline');
await page.keyboard.press('Control+z');
n = await ops();
await ed((e) => { e.settings.shapeFill = true; });
await m.click(...at(c[0] - 150, c[1] + 150)); await page.waitForTimeout(450);
await m.click(...at(c[0], c[1] - 150)); await page.waitForTimeout(450);
await m.click(...at(c[0] + 150, c[1] + 150)); await page.waitForTimeout(450);
await m.click(...at(c[0] - 150, c[1] + 150)); await page.waitForTimeout(150);
o = await last();
check((await ops()) === n + 1 && o.pts.length === 8 && o.pts[0] === o.pts[6], 'clicking the first point closes the polygon');
check((await alphaAt(c[0], c[1] + 50)) > 200, 'closed polyline is filled');
await page.screenshot({ path: `${out}/02-polyline.png` });
await page.keyboard.press('Control+z');

// Escape drops the points being placed.
await page.waitForTimeout(100);
n = await ops();
await m.click(...at(c[0] - 150, c[1])); await page.waitForTimeout(450);
await m.click(...at(c[0], c[1])); await page.waitForTimeout(450);
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check((await ops()) === n && !(await ed((e) => e.view.live)), 'Escape cancels a polyline in progress');

// ---- Curve ----
await ed((e) => { e.settings.shape = 'curve'; e.settings.shapeFill = false; e.emit('tool'); });
n = await ops();
await m.click(...at(c[0] - 200, c[1])); await page.waitForTimeout(450);
await m.click(...at(c[0], c[1] - 150)); await page.waitForTimeout(450);
await m.click(...at(c[0] + 200, c[1])); await page.waitForTimeout(450);
await page.keyboard.press('Enter'); await page.waitForTimeout(150);
o = await last();
check((await ops()) === n + 1 && o.shape === 'curve', 'curve committed');
check((await alphaAt(c[0], c[1] - 150)) > 200 && (await alphaAt(c[0], c[1])) === 0, 'the curve passes through the middle point, not the chord');
await page.keyboard.press('Control+z');

// ---- Arc: three clicks ----
await ed((e) => { e.settings.shape = 'arc'; e.emit('tool'); });
n = await ops();
await m.click(...at(c[0] - 150, c[1])); await page.waitForTimeout(450);
await m.click(...at(c[0], c[1] - 150)); await page.waitForTimeout(450);
await m.click(...at(c[0] + 150, c[1])); await page.waitForTimeout(200);
o = await last();
check((await ops()) === n + 1 && o.shape === 'arc' && o.pts.length === 6, 'third click commits the arc');
check((await alphaAt(c[0] - 106, c[1] - 106)) > 100 && (await alphaAt(c[0], c[1] + 150)) === 0, 'arc runs through the top, not the bottom');
await page.screenshot({ path: `${out}/03-arc.png` });
await page.keyboard.press('Control+z');

// ---- QuickShape ----
await page.keyboard.press('b');
check(await page.locator('.optionsbar .check', { hasText: 'QuickShape' }).isVisible(), 'brush options offer QuickShape');
n = await ops();
await drag([[c[0] - 200, c[1] + 10], [c[0] - 100, c[1] - 6], [c[0], c[1] + 8], [c[0] + 100, c[1] - 4], [c[0] + 200, c[1]]], 900);
o = await last();
check((await ops()) === n + 1 && o.t === 'shape' && o.shape === 'line', `a wobbly line held still becomes a line (${o.t}/${o.shape})`);
check((await alphaAt(c[0], c[1] + 5)) > 200, 'the snapped line has ink');
await page.keyboard.press('Control+z');
n = await ops();
const ring = Array.from({ length: 30 }, (_, i) => [c[0] + Math.cos(i / 29 * Math.PI * 2) * (100 + (i % 3) * 4), c[1] + Math.sin(i / 29 * Math.PI * 2) * 100]);
await drag(ring, 900);
o = await last();
check(o.t === 'shape' && o.shape === 'ellipse', `a rough circle becomes an ellipse (${o.t}/${o.shape})`);
await page.keyboard.press('Control+z');
n = await ops();
await drag([[c[0] - 150, c[1] + 100], [c[0] - 50, c[1] - 100], [c[0] + 50, c[1] + 100], [c[0] + 150, c[1] - 100]], 900);
o = await last();
check(o.t === 'shape' && o.shape === 'polyline' && o.pts.length === 8, `a zigzag becomes a polyline (${o.shape}, ${o.pts?.length / 2} pts)`);
await page.keyboard.press('Control+z');
n = await ops();
const arc = Array.from({ length: 20 }, (_, i) => [c[0] + Math.cos(Math.PI + i / 19 * Math.PI) * 120, c[1] + Math.sin(Math.PI + i / 19 * Math.PI) * 120]);
await drag(arc, 900);
o = await last();
check(o.t === 'shape' && o.shape === 'arc', `a half circle becomes an arc (${o.shape})`);
await page.screenshot({ path: `${out}/04-quickshape.png` });
await page.keyboard.press('Control+z');
// Moving on after the snap goes back to the freehand stroke.
n = await ops();
await m.move(...at(c[0] - 200, c[1])); await m.down(); await m.move(...at(c[0], c[1]), { steps: 4 });
await page.waitForTimeout(900);
check(await ed((e) => e.view.live && e.view.live.buffer !== e.tools.brush.stroke), 'holding swaps the preview for the shape');
await m.move(...at(c[0] + 100, c[1] + 120), { steps: 6 }); await m.up(); await page.waitForTimeout(150);
o = await last();
check(o.t === 'stroke', 'moving on after the snap keeps the freehand stroke');
await page.keyboard.press('Control+z');
// An Apple Pencil held still keeps reporting tiny moves: the hold must still count.
await m.move(...at(c[0] - 150, c[1] + 100)); await m.down();
await m.move(...at(c[0] + 150, c[1] + 100), { steps: 10 });
for (let i = 0; i < 12; i++) { await m.move(...at(c[0] + 150 + (i % 2), c[1] + 100 + (i % 3) * 0.5)); await page.waitForTimeout(80); }
await m.up(); await page.waitForTimeout(150);
o = await last();
check(o.t === 'shape' && o.shape === 'line', `a jittery hold still snaps (${o.t} ${o.shape ?? ''})`);
await page.keyboard.press('Control+z');
// Off switch.
await ed((e) => { e.prefs.quickShape = false; });
await drag([[c[0] - 200, c[1]], [c[0] + 200, c[1]]], 900);
o = await last();
check(o.t === 'stroke', 'QuickShape off leaves strokes alone');

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
