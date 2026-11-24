// The tidy top bar: honey as the starting colour, menu icon row (export, flips lit while on, centre, effects, guides),
// stabilizer and pressure in each drawing tool's own menu, hold-to-pick on the canvas, and dragging the colour onto it.
// Usage: node tests/topbar.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/topbar';
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
const pixel = (sx, sy) => ed((e, p) => {
  const d = e.view.viewport.toDoc(p[0], p[1]);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const x = c.getContext('2d'); x.translate(-Math.floor(d.x), -Math.floor(d.y)); e.layer.surface.drawTo(x, { x: Math.floor(d.x), y: Math.floor(d.y), w: 1, h: 1 });
  return [...x.getImageData(0, 0, 1, 1).data];
}, [sx, sy]);

// ---- Starting colour ----
check(await ed((e) => e.color) === '#ef8720', 'a new canvas starts in honey');

// ---- Top bar is down to the essentials ----
for (const label of ['Export (Ctrl+Shift+E)', 'Effects']) check(await page.locator(`.topbar [aria-label="${label}"]`).count() === 0, `no ${label} button in the top bar`);
check(await page.locator('.topbar [aria-label^="Flip"], .topbar [aria-label^="Guides"], .topbar .icon-btn[aria-label^="Fit"]').count() === 0, 'no flip, guides or fit buttons in the top bar');
check(await page.locator('.optionsbar .preset-btn').count() === 0 && await page.locator('.optionsbar input[type=checkbox]').count() === 0, 'the options bar has no brush dropdown or pressure checkboxes');

// ---- Menu icon row ----
await page.locator('[aria-label="Menu"]').click();
const row = page.locator('.menu-pop .menu-tools');
check(await row.isVisible(), 'the menu opens with an icon row');
const labels = await row.locator('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
check(labels.length === 6 && labels[0].startsWith('Export') && labels[4] === 'Effects' && labels[5].startsWith('Guides'), `row holds export, flips, centre, effects, guides (${labels.join(' | ')})`);
const order = await page.evaluate(() => { const p = document.querySelector('.menu-pop .menu-dyn'); const kids = [...p.children]; return [kids.findIndex((k) => k.classList.contains('menu-tools')), kids.findIndex((k) => /Share/.test(k.textContent ?? ''))]; });
check(order[0] >= 0 && (order[1] < 0 || order[0] < order[1]), 'the icon row sits above Share');
const flipH = row.locator('[aria-label^="Flip horizontally"]');
check(await flipH.getAttribute('aria-pressed') === 'false', 'horizontal flip starts off');
await flipH.click();
check(await page.locator('.menu-pop').isVisible() && await flipH.getAttribute('aria-pressed') === 'true' && await flipH.evaluate((b) => b.classList.contains('active')), 'flipping keeps the menu open and lights the button');
check(await row.locator('[aria-label^="Flip vertically"]').getAttribute('aria-pressed') === 'false', 'the vertical flip stays unlit');
await page.screenshot({ path: `${out}/01-menu-flipped.png` });
await page.keyboard.press('h');
check(await flipH.getAttribute('aria-pressed') === 'false', 'flipping back with H unlights it');
await row.locator('[aria-label="Effects"]').click();
check(await page.locator('.effects-pop').isVisible() && await page.locator('.menu-pop').isHidden(), 'Effects opens its list from the menu');
await m.click(...at(20, 20));
await page.locator('[aria-label="Menu"]').click();
await row.locator('[aria-label^="Guides"]').click();
check(await page.locator('.guides-pop').isVisible(), 'Guides opens its popover from the menu');
await m.click(...at(20, 20));


// ---- Per-tool stabilizer and pressure ----
await page.locator('.topbar [aria-label^="Brush (B)"]').click(); // already active: opens the library
const opts = page.locator('.brush-library .tool-opts');
check(await opts.isVisible() && await opts.locator('label', { hasText: 'Stabilizer' }).count() === 1, 'the brush menu has the stabilizer and pressure switches');
await opts.locator('label', { hasText: 'Stabilizer' }).click();
check(await ed((e) => e.prefs.toolOpts.brush.stabilizerOn && !e.prefs.toolOpts.eraser.stabilizerOn), 'stabilizer turns on for the brush only');
await opts.locator('label', { hasText: 'Opacity' }).click();
check(await ed((e) => e.prefs.toolOpts.brush.pressureOpacity && e.settings.brush.pressureFlow > 0 && !e.prefs.toolOpts.eraser.pressureOpacity), 'pressure opacity is the brush’s own');
await page.screenshot({ path: `${out}/02-brush-options.png` });
await page.keyboard.press('Escape');
await m.click(...at(20, 20));
await page.keyboard.press('e');
await page.locator('.topbar [aria-label^="Eraser (E)"]').click();
check(await page.locator('.brush-library .tool-opts label', { hasText: 'Stabilizer' }).locator('input').isChecked() === false, 'the eraser’s menu shows its own (off) stabilizer');
await m.click(...at(20, 20));
await page.keyboard.press('s');
await page.locator('.topbar [aria-label^="Smudge (S)"]').click();
check(await page.locator('.brush-library .tool-opts label', { hasText: 'Strength' }).count() === 1 && await page.locator('.brush-library .tool-opts label', { hasText: 'Stabilizer' }).count() === 0, 'smudge offers pressure size and strength');
await m.click(...at(20, 20));
await page.waitForTimeout(500);
const stored = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).find((v) => v?.includes('toolOpts')));
check(!!stored && JSON.parse(stored).toolOpts.brush.stabilizerOn === true, 'per-tool switches are saved with the preferences');
await ed((e) => { e.prefs.toolOpts.brush.stabilizerOn = false; });
await page.keyboard.press('b');

// ---- Press and hold the canvas: eyedropper ----
await ed((e) => { e.setColor('#1040c0'); e.settings.brush.size = 40; e.settings.brush.smoothing = 0; e.prefs.quickShape = false; });
await m.move(...at(300, 300)); await m.down(); await m.move(...at(500, 300), { steps: 8 }); await m.up();
await page.waitForTimeout(150);
const strokes = await ed((e) => e.doc.log.filter((o) => o.t === 'stroke').length);
await ed((e) => e.setColor('#00ff00'));
await m.move(...at(400, 300)); await m.down(); await page.waitForTimeout(650); await m.up();
await page.waitForTimeout(150);
check(await ed((e) => e.color) === '#1040c0', 'holding still on the canvas picks the colour under it');
check(await ed((e) => e.doc.log.filter((o) => o.t === 'stroke').length) === strokes, 'and leaves no dab behind');

// ---- Drag the colour onto the canvas: fill ----
await ed((e) => e.setColor('#e53935'));
const cb = await page.locator('.topbar .color-btn').boundingBox();
await m.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await m.down();
await page.waitForTimeout(450);
check(await page.locator('.color-drop').isVisible(), 'holding the colour button lifts the colour');
await m.move(...at(700, 650), { steps: 10 });
await page.screenshot({ path: `${out}/03-color-drag.png` });
await m.up();
await page.waitForTimeout(600);
check(await page.locator('.color-drop').count() === 0 && await page.locator('.color-pop').isHidden(), 'dropping clears the ghost without opening the picker');
const px = await pixel(700, 650);
check(px[0] === 0xe5 && px[1] === 0x39 && px[3] === 255, `the drop fills there in that colour (${px})`);
check(await ed((e) => e.toolId) === 'brush', 'the brush stays the tool');

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
if (failed) process.exit(1);
