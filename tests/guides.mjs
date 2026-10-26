// Guides: symmetry copies of strokes and shapes, grid snapping, rulers, and the reference image panel.
// Usage: node tests/guides.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/guides';
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
/** Alpha of the active layer at a document point. */
const alphaAt = (x, y) => ed((e, p) => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.translate(-p[0], -p[1]); e.layer.surface.drawTo(g, { x: p[0], y: p[1], w: 1, h: 1 });
  return g.getImageData(0, 0, 1, 1).data[3];
}, [x, y]);
const toDoc = (sx, sy) => ed((e, p) => { const d = e.view.viewport.toDoc(p[0], p[1]); return [d.x, d.y]; }, [sx, sy]);
const size = await ed((e) => [e.doc.settings.width, e.doc.settings.height]);
const log = () => ed((e) => e.doc.log.map((o) => o.t));

// ---- Guides popover ----
await page.locator('.topbar button[title^="Guides"]').click();
const pop = page.locator('.guides-pop');
check(await pop.isVisible(), 'the Guides button opens its popover');
for (const t of ['Symmetry', 'Grid', 'Rulers', 'Open reference image…']) check(await pop.getByText(t, { exact: false }).first().isVisible(), `popover shows ${t}`);
check((await page.locator('.topbar .bar-group:first-child .icon-btn:visible').count()) <= 8, 'top bar stays lean');

// ---- Vertical symmetry mirrors a stroke ----
await pop.locator('.segmented button', { hasText: 'Vertical' }).click();
await page.keyboard.press('Escape');
await ed((e) => { e.setColor('#000000'); e.settings.brush.size = 14; e.settings.brush.smoothing = 0; e.prefs.stabilizerOn = false; });
const centre = [box.width / 2, box.height / 2];
await drag([[centre[0] - 300, centre[1] - 100], [centre[0] - 200, centre[1] - 60]]);
await page.waitForTimeout(150);
const a = await toDoc(centre[0] - 250, centre[1] - 80);
const mirrored = [size[0] - a[0], a[1]];
check((await alphaAt(Math.round(a[0]), Math.round(a[1]))) > 100, 'the drawn side has ink');
check((await alphaAt(Math.round(mirrored[0]), Math.round(mirrored[1]))) > 100, 'the mirrored side has ink too');
let strokes = (await log()).filter((t) => t === 'stroke').length;
check(strokes === 2, 'one stroke became two ops (original + mirror)');
await page.screenshot({ path: `${out}/01-vertical.png` });

// Undo takes both away.
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);
check((await alphaAt(Math.round(mirrored[0]), Math.round(mirrored[1]))) === 0, 'undo removes the mirror as well');
strokes = (await log()).filter((t) => t === 'stroke').length;

// ---- Radial symmetry with 6 segments ----
await ed((e) => { e.settings.guides.symmetry.mode = 'radial'; e.settings.guides.symmetry.segments = 6; e.view.invalidate(null); });
await drag([[centre[0] + 60, centre[1]], [centre[0] + 200, centre[1]]]);
await page.waitForTimeout(200);
check((await log()).filter((t) => t === 'stroke').length === strokes + 6, 'radial 6 produces six stroke ops');
const c = await toDoc(centre[0], centre[1]);
const p0 = await toDoc(centre[0] + 130, centre[1]);
const r = p0[0] - c[0];
let lit = 0;
for (let i = 0; i < 6; i++) { const ang = (i / 6) * Math.PI * 2; if ((await alphaAt(Math.round(c[0] + Math.cos(ang) * r), Math.round(c[1] + Math.sin(ang) * r))) > 100) lit++; }
check(lit === 6, `all six arms carry ink (${lit}/6)`);
await page.screenshot({ path: `${out}/02-radial.png` });

// ---- Grid snapping of a rectangle ----
await ed((e) => { e.settings.guides.symmetry.mode = 'off'; e.settings.guides.grid = { mode: 'square', size: 64, snap: true, rulers: true }; e.view.invalidate(null); e.settings.shape = 'rect'; e.settings.shapeFill = true; });
await page.keyboard.press('u');
const before = (await log()).length;
await drag([[centre[0] - 150, centre[1] - 150], [centre[0] - 30, centre[1] - 20]]);
await page.waitForTimeout(200);
const sp = await ed((e) => e.doc.log.filter((o) => o.t === 'shape').at(-1)) ?? {};
check(sp.t === 'shape', 'a shape op was logged');
const onGrid = (v) => Math.abs(v / 64 - Math.round(v / 64)) < 1e-6;
check([sp.x0, sp.y0, sp.x1, sp.y1].every(onGrid), `rectangle corners snap to the 64px grid (${[sp.x0, sp.y0, sp.x1, sp.y1]})`);
check((await log()).length === before + 1, 'no symmetry copy when symmetry is off');
await page.screenshot({ path: `${out}/03-grid.png` });

// Rulers change the stage's top-left corner.
const corner = () => page.evaluate(() => {
  const c = document.querySelector('canvas.stage');
  const g = document.createElement('canvas'); g.width = g.height = 40;
  const x = g.getContext('2d'); x.drawImage(c, 0, 0);
  return [...x.getImageData(0, 0, 40, 40).data].join();
});
const withRulers = await corner();
await ed((e) => { e.settings.guides.grid.rulers = false; e.view.invalidate(null); });
await page.waitForTimeout(150);
check(withRulers !== (await corner()), 'rulers draw in the stage corner');
await ed((e) => { e.settings.guides.grid.rulers = true; e.view.invalidate(null); });

// ---- Selection snaps too ----
await page.keyboard.press('m');
await ed((e) => { e.settings.selectMode = 'rect'; e.emit('tool'); });
await drag([[centre[0] + 20, centre[1] + 20], [centre[0] + 150, centre[1] + 140]]);
await page.waitForTimeout(100);
const sel = await ed((e) => e.selection?.pts ?? null);
check(sel && sel.length >= 8 && sel.every(onGrid), `rect selection corners sit on the grid (${sel?.slice(0, 4)})`);
await page.keyboard.press('Control+d');

// ---- Reference panel ----
await ed((e) => { e.settings.guides.grid.mode = 'off'; e.settings.guides.grid.rulers = false; e.view.invalidate(null); });
const ref = page.locator('.ref-panel');
check(await ref.isHidden(), 'reference panel hidden by default');
// Load a red image through the panel's loader.
await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 80; c.height = 60;
  const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 80, 60); g.fillStyle = '#00ff00'; g.fillRect(40, 0, 40, 60);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  window.doodlehive.reference.load(new File([blob], 'ref.png', { type: 'image/png' }));
});
await page.waitForTimeout(300);
check(await ref.isVisible(), 'loading an image shows the reference panel');
const rb = await page.locator('.ref-canvas').boundingBox();
await page.keyboard.press('i');
await m.click(rb.x + rb.width * 0.25, rb.y + rb.height / 2);
const picked = await ed((e) => e.color);
check(/^#ff0000$/i.test(picked), `eyedropper picks from the reference image (${picked})`);
await m.click(rb.x + rb.width * 0.8, rb.y + rb.height / 2);
check(/^#00ff00$/i.test(await ed((e) => e.color)), 'and the other half is green');
await page.screenshot({ path: `${out}/04-reference.png` });
await page.locator('.ref-head button[title="Close"]').click();
check(await ref.isHidden(), 'Close hides the panel');

// Focus mode hides the panel.
await page.evaluate(() => window.doodlehive.reference.el.hidden = false);
await page.keyboard.press('F');
await page.waitForTimeout(100);
check(await ref.isHidden(), 'focus mode hides the reference panel');
await page.keyboard.press('F');

// ---- Layer stack no longer carries the effects button ----
await page.keyboard.press('l');
await page.waitForTimeout(100);
check((await page.locator('.layers-pop button[title="Layer effects"], .panel button[title="Layer effects"]').count()) === 0, 'layer stack has no Layer effects button');
check((await page.locator('.topbar button[title^="Effects"]').count()) === 1, 'the Effects button stays in the top bar');

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
