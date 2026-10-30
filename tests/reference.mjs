// A reference layer: fills and the wand read their edges from it while painting on another layer.
// Usage: node tests/reference.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
fs.mkdirSync('test-results/reference', { recursive: true });
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
const px = (sx, sy) => ed((e, p) => {
  const d = e.view.viewport.toDoc(p[0], p[1]), x = Math.floor(d.x), y = Math.floor(d.y);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.translate(-x, -y); e.layer.surface.drawTo(g, { x, y, w: 1, h: 1 });
  return [...g.getImageData(0, 0, 1, 1).data];
}, [sx, sy]);
const c = [box.width / 2, box.height / 2];
const circle = (r, n = 40) => Array.from({ length: n + 1 }, (_, i) => [c[0] + Math.cos((i / n) * Math.PI * 2) * r, c[1] + Math.sin((i / n) * Math.PI * 2) * r]);

// Line art on layer 1, an empty layer 2 above.
await ed((e) => { e.setColor('#000000'); e.settings.brush.size = 14; e.settings.brush.smoothing = 0; e.prefs.stabilizerOn = false; e.prefs.quickShape = false; });
await drag(circle(120));
const lineArt = await ed((e) => e.activeLayer);
await ed((e) => e.addLayer());
check((await ed((e) => e.activeLayer)) !== lineArt, 'a second layer is active');

// Mark layer 1 as the reference from the layers panel.
await page.keyboard.press('l');
await page.locator('.layers-panel .layer-row').last().click();
await page.locator('.layers-panel button[data-tip^="Reference"]').click();
check((await ed((e) => e.referenceLayer)) === lineArt, 'the reference button marks the layer');
check(await page.locator('.layers-panel .layer-row', { hasText: 'Reference' }).count() === 1, 'its row says Reference');
await page.locator('.layers-panel .layer-row').first().click();
await page.keyboard.press('g');
await ed((e) => { e.setColor('#ff0000'); e.settings.fillMode = 'bucket'; e.settings.fillSampleAll = false; e.settings.fillUseRef = true; e.emit('tool'); });
check(await page.locator('.optionsbar .segmented button', { hasText: 'Layer 1' }).count() === 1, 'the fill options offer the reference layer by name');

// Fill on layer 2 at the ring's centre: with the reference it stays inside the ring.
await m.click(...at(c[0], c[1]));
await page.waitForTimeout(400);
let inside = await px(c[0], c[1]), outside = await px(c[0] + 200, c[1]);
check(inside[0] > 200 && inside[3] > 200 && outside[3] === 0, `fill stays inside the reference ring (${inside} / ${outside})`);
check(await ed((e, id) => e.doc.log.at(-1).sampleLayer === id, lineArt), 'the op names the layer it sampled');
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);
// Without it, the empty layer floods everywhere.
await ed((e) => { e.settings.fillUseRef = false; e.emit('tool'); });
await m.click(...at(c[0], c[1]));
await page.waitForTimeout(400);
outside = await px(c[0] + 200, c[1]);
check(outside[3] > 200, 'This layer alone floods past the ring');
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);

// The wand follows the same reference.
await page.keyboard.press('m');
await ed((e) => { e.settings.selectMode = 'wand'; e.settings.fillUseRef = true; e.emit('tool'); });
await m.click(...at(c[0], c[1]));
await page.waitForTimeout(300);
const sel = await ed((e) => { const xs = e.selection.pts.filter((_, i) => i % 2 === 0); return Math.max(...xs) - Math.min(...xs); });
check(sel > 600 && sel < 800, `the wand selects the ring's inside through the reference (${sel}px wide)`);
await page.screenshot({ path: 'test-results/reference/01-wand.png' });

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
