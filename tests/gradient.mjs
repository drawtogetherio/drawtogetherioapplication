// Gradient fill mode: linear and radial, fade to transparent or to a colour, kept inside the selection, undoable.
// Usage: node tests/gradient.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/gradient';
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
const drag = async (pts) => { await m.move(...at(...pts[0])); await m.down(); for (const p of pts.slice(1)) await m.move(...at(...p), { steps: 4 }); await m.up(); await page.waitForTimeout(150); };
const pixel = (sx, sy) => ed((e, p) => {
  const d = e.view.viewport.toDoc(p[0], p[1]), x = Math.floor(d.x), y = Math.floor(d.y);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.translate(-x, -y); e.layer.surface.drawTo(g, { x, y, w: 1, h: 1 });
  return [...g.getImageData(0, 0, 1, 1).data];
}, [sx, sy]);
const last = () => ed((e) => { const o = e.doc.log.at(-1); return { t: o.t, kind: o.kind, stops: o.stops, region: o.region }; });
const c = [box.width / 2, box.height / 2], half = (box.height - 100) / 2 - 10;

await ed((e) => { e.setColor('#ff0000'); e.settings.fillMode = 'gradient'; });
await page.keyboard.press('g');
check(await page.locator('.optionsbar .segmented button', { hasText: 'Radial' }).isVisible(), 'gradient options show Linear/Radial');
check(await page.locator('.optionsbar .segmented button', { hasText: 'Transparent' }).isVisible(), 'and a Transparent/Colour end');

// ---- Linear fade across the canvas ----
await drag([[c[0] - half, c[1]], [c[0] + half, c[1]]]);
let o = await last();
check(o.t === 'gradient' && o.kind === 'linear' && o.stops[1].alpha === 0, 'a linear gradient op fading out');
const left = await pixel(c[0] - half + 4, c[1]), mid = await pixel(c[0], c[1]), right = await pixel(c[0] + half - 4, c[1]);
check(left[0] > 240 && left[3] > 240, `start is solid red (${left})`);
check(mid[3] > 90 && mid[3] < 170, `middle is half transparent (${mid})`);
check(right[3] < 15, `end is transparent (${right})`);
check((await pixel(c[0] - half + 4, c[1] - half + 4))[3] > 240, 'the fill covers the whole canvas height');
await page.screenshot({ path: `${out}/01-linear.png` });
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);
check((await pixel(c[0] - half + 4, c[1]))[3] === 0, 'undo clears it');

// ---- Radial to a colour, inside a selection ----
await page.keyboard.press('m');
await ed((e) => { e.settings.selectMode = 'rect'; e.emit('tool'); });
await drag([[c[0] - 150, c[1] - 150], [c[0] + 150, c[1] + 150]]);
await page.keyboard.press('g');
await ed((e) => { e.settings.gradientKind = 'radial'; e.settings.gradientEnd = '#0000ff'; e.emit('tool'); });
await drag([[c[0], c[1]], [c[0] + 140, c[1]]]);
o = await last();
check(o.kind === 'radial' && o.stops[1].color === '#0000ff' && o.stops[1].alpha === 1, 'radial op ends in blue');
check(o.region.w <= 1000 && o.region.h <= 1000, `region is trimmed to the selection (${o.region.w}x${o.region.h})`);
const centre = await pixel(c[0], c[1]), edge = await pixel(c[0] + 138, c[1]), outside = await pixel(c[0] + 200, c[1]);
check(centre[0] > 240 && centre[2] < 20, `centre is red (${centre})`);
check(edge[2] > 200 && edge[0] < 60, `edge is blue (${edge})`);
check(outside[3] === 0, 'nothing lands outside the selection');
await page.screenshot({ path: `${out}/02-radial.png` });
await page.keyboard.press('Control+d');

// Shift constrains the angle.
await ed((e) => { e.settings.gradientKind = 'linear'; e.settings.gradientEnd = null; e.emit('tool'); e.selection = null; });
await m.move(...at(c[0] - 100, c[1])); await m.down(); await page.keyboard.down('Shift'); await m.move(...at(c[0] + 100, c[1] + 12), { steps: 4 }); await m.up(); await page.keyboard.up('Shift');
await page.waitForTimeout(150);
o = await ed((e) => { const o = e.doc.log.at(-1); return [o.y0, o.y1]; });
check(Math.abs(o[0] - o[1]) < 0.01, 'Shift keeps the gradient horizontal');

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
