// Tool drop-downs (brush library, selection/shape modes) and R/Z view hotkeys. Usage: node tests/pickers.mjs [url]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/pickers';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
const errors = [];
let failed = 0;
page.on('pageerror', (e) => errors.push(e.message));
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const ed = (fn) => page.evaluate(`(${fn})(window.doodlehive.ed, window.doodlehive)`);

await page.goto(url);
await page.getByText('Create canvas').click();
const brushBtn = page.locator('.topbar [aria-label^="Brush (B)"]');

// Tapping the active brush opens the library.
await brushBtn.click();
await page.waitForSelector('.brush-library');
check(await page.locator('.brush-tab').count() === 5 && (await page.locator('.brush-tab.active').textContent()) === 'Pen', 'library opens on the Pen tab, one of 4 categories plus favourites');
check(await page.locator('.brush-row').count() === 4, 'the Pen tab lists 4 brushes with previews');
const inked = await page.evaluate(() => {
  const c = document.querySelector('.brush-row canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
  return n;
});
check(inked > 200, 'preview squiggle is drawn (' + inked + ' px)');
await page.screenshot({ path: `${out}/01-brush-library.png` });
await page.locator('.brush-tab', { hasText: 'Pencil' }).click();
await page.locator('.brush-row', { hasText: 'HB Pencil' }).click();
check(await page.locator('.brush-library').isHidden(), 'picking closes the library');
check(await ed((e) => e.settings.brushPreset) === 'pencil', 'HB Pencil selected');
check(await page.locator('.preset-btn', { hasText: 'HB Pencil' }).count() === 1, 'options bar shows HB Pencil');

// Eraser: first tap selects, second opens.
const eraserBtn = page.locator('.topbar [aria-label^="Eraser (E)"]');
await eraserBtn.click();
check(await page.locator('.tool-pop').isHidden(), 'first tap only selects the eraser');
await eraserBtn.click();
await page.waitForSelector('.brush-library');
check((await page.locator('.brush-tab.active').textContent()) === 'Eraser' && (await page.locator('.brush-row').count()) === 2, 'eraser opens the same library on its Eraser tab');
await page.screenshot({ path: `${out}/02-eraser-library.png` });
await page.keyboard.press('Escape');
check(await page.locator('.tool-pop').isHidden(), 'Escape closes it');

// Selection modes.
const selBtn = page.locator('.topbar [aria-label^="Selection (M)"]');
await selBtn.click();
await selBtn.click();
await page.waitForSelector('.icon-choices');
check(await page.locator('.icon-choices .icon-btn').count() === 5, 'selection drop-down has 5 icons');
await page.screenshot({ path: `${out}/03-select-modes.png` });
const before = await selBtn.innerHTML();
await page.locator('.icon-choices [aria-label="Lasso"]').click();
check(await ed((e) => e.settings.selectMode) === 'lasso', 'lasso chosen');
check((await selBtn.innerHTML()) !== before, 'toolbar icon changed to lasso');

// Shapes.
const shapeBtn = page.locator('.topbar [aria-label^="Shapes (U)"]');
await shapeBtn.click();
await shapeBtn.click();
await page.locator('.icon-choices [aria-label="Ellipse"]').click();
check(await ed((e) => e.settings.shape) === 'ellipse', 'ellipse shape chosen');
await page.screenshot({ path: `${out}/04-shape-ellipse.png` });

// R + drag rotates, Z + drag zooms.
const box = await page.locator('canvas.stage').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.keyboard.down('r');
await page.mouse.move(cx + 200, cy); await page.mouse.down(); await page.mouse.move(cx, cy + 200, { steps: 10 }); await page.mouse.up();
await page.keyboard.up('r');
const rot = await ed((e) => Math.round(e.view.viewport.rot * 180 / Math.PI));
check(Math.abs(rot - 90) <= 2, 'R + drag rotated the view (' + rot + '°)');
const z0 = await ed((e) => e.view.viewport.zoom);
await page.keyboard.down('z');
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 150, cy, { steps: 10 }); await page.mouse.up();
await page.keyboard.up('z');
const z1 = await ed((e) => e.view.viewport.zoom);
check(z1 > z0 * 2, `Z + drag zoomed in (${z0.toFixed(2)} → ${z1.toFixed(2)})`);
check(await ed((e) => e.doc.log.length) <= 1, 'no paint was added while dragging the view');
await page.screenshot({ path: `${out}/05-rotated-zoomed.png` });

// ---- Themes ----
const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
check(await accent() === '#fdb302', 'default theme is Honey');
await page.locator('[aria-label="Menu"]').click();
await page.screenshot({ path: `${out}/06-menu-honey.png` });
check((await page.locator('.menu-pop .shortcuts, .menu-pop .theme-row').count()) === 0, 'the menu holds no shortcut list or theme row');
await page.locator('.menu-pop .menu-item', { hasText: 'Preferences' }).click();
await page.waitForSelector('.modal[aria-label="Preferences"]');
await page.locator('.theme-swatch[aria-label^="Lavender"]').click();
check(await accent() === '#fdb302', 'premium themes stay locked without premium');
check((await page.locator('.theme-swatch.custom.locked').count()) === 1, 'so does the custom colour');
await page.screenshot({ path: `${out}/07-prefs.png` });
await page.locator('.modal-head .icon-btn').click();
await page.evaluate(() => localStorage.removeItem('doodlehive.theme'));

console.log(errors.length ? 'Errors:\n' + errors.join('\n') : 'No page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
