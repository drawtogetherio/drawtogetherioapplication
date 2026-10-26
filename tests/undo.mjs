// Undo keeps only the changed parts of tiles: exact restore, small inverse ops, heavy logs squashed.
// Usage: node tests/undo.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/undo';
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
const drag = async (pts) => { await m.move(...at(...pts[0])); await m.down(); for (const p of pts.slice(1)) await m.move(...at(...p), { steps: 4 }); await m.up(); };
/** Per-tile checksums of the active layer; blank tiles don't count. */
const digest = () => ed((e) => {
  const o = {};
  for (const [k, t] of e.layer.surface.tiles) {
    const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    let s = 0, any = false;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3]) { any = true; s = (s * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3] * 17) >>> 0; } }
    if (any) o[k] = s;
  }
  return JSON.stringify(o, Object.keys(o).sort());
});

await ed((e) => { e.setColor('#1040c0'); e.settings.brush.size = 14; e.settings.brush.smoothing = 0; e.prefs.stabilizerOn = false; });
await drag([[200, 200], [700, 240], [600, 600]]);
await page.waitForTimeout(100);
const one = await digest();
check(one !== '{}', 'first stroke drawn');

// A second stroke over the same tiles: its undo should carry only the strip it touched.
await ed((e) => e.setColor('#e03030'));
await drag([[220, 400], [680, 420]]);
await page.waitForTimeout(100);
const two = await digest();
const inv = await ed((e) => {
  const u = e.doc.history.done.at(-1).undo.filter((o) => o.t === 'tiles');
  const keys = u.flatMap((o) => Object.entries(o.img ?? o.tiles).filter(([, v]) => v).map(([k]) => k));
  const dims = u.flatMap((o) => Object.values(o.img ?? {}).map((d) => d && [d.width, d.height]));
  return { keys, dims, cost: e.doc.history.done.at(-1).cost, all: u.reduce((n, o) => n + Object.keys(o.img ?? o.tiles).length, 0) };
});
check(inv.keys.length > 0 && inv.keys.every((k) => k.includes('@')), `undo keys name the changed part of each tile that existed (${inv.keys.slice(0, 3)}…)`);
check(inv.dims.some((d) => d && d[0] < 256 && d[1] < 256), `undo images are smaller than a tile (${JSON.stringify(inv.dims.slice(0, 3))})`);
check(inv.cost < inv.all, `undo cost counts area, not tiles (${inv.cost.toFixed(2)} for ${inv.all} tiles)`);

await page.keyboard.press('Control+z');
await page.waitForTimeout(50);
check((await digest()) === one, 'undo restores the first stroke exactly');
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(50);
check((await digest()) === two, 'redo brings the second stroke back exactly');
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await page.waitForTimeout(50);
check(await ed((e) => e.layer.surface.tiles.size === 0), 'undoing everything leaves no tiles behind');
await page.keyboard.press('Control+Shift+z');
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(50);
check((await digest()) === two, 'redoing everything matches again');

// Erasing over the strokes then undoing: the eraser's undo restores pixels too.
await page.keyboard.press('e');
await drag([[400, 150], [420, 650]]);
await page.waitForTimeout(100);
check((await digest()) !== two, 'eraser changed pixels');
await page.keyboard.press('Control+z');
await page.waitForTimeout(50);
check((await digest()) === two, 'undoing the eraser restores exactly');

// The inverse carries far fewer pixels than whole tiles would.
const area = await ed((e) => {
  const u = e.doc.history.done.at(-1).undo.find((o) => o.t === 'tiles');
  const imgs = Object.values(u.img).filter(Boolean);
  return { part: imgs.reduce((n, d) => n + d.width * d.height, 0), whole: imgs.length * 256 * 256 };
});
check(area.part < area.whole / 2, `inverse holds ${area.part} pixels instead of ${area.whole}`);

// Memory meter: shows the canvas size and shortens undo history as it nears the device's budget.
check(/MB|GB/.test(await page.locator('.layers-panel .mem-meter .mem-text').textContent()), 'the layers panel shows canvas memory');
const meter = await page.evaluate(async () => {
  const app = window.doodlehive, before = app.ed.doc.history.maxCost;
  app.memory.budget = app.memory.reading.used * 1.05;
  app.ed.apply({ t: 'layer.props', id: 'mm' + Date.now(), layer: app.ed.activeLayer, props: { opacity: 0.98 } });
  await new Promise((r) => setTimeout(r, 600));
  const toast = document.body.textContent.includes('near this device’s limit');
  return { before, after: app.ed.doc.history.maxCost, level: app.memory.el.dataset.level, toast, text: app.memory.el.title };
});
check(meter.before === 700 && meter.after === 100 && meter.level === '2' && meter.toast, `near the budget: undo history capped and a warning shown (${meter.text})`);

await page.screenshot({ path: `${out}/01-undo.png` });
check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `FAIL ${failed}` : 'ok');
process.exit(failed ? 1 : 0);
