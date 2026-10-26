// Studio layout: panels dock or float, drag, resize, close; colour wheel; switching back to classic. Usage: node tests/studio.mjs [url]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const out = 'test-results/studio';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const ed = (fn, arg) => page.evaluate(([src, a]) => new Function('ed', 'a', `return (${src})(ed, a)`)(window.doodlehive.ed, a), [fn.toString(), arg]);
const panel = (id) => ed((e, id) => e.prefs.panels[id], id);
const m = page.mouse;
const drag = async (from, to, steps = 10) => { await m.move(from[0], from[1]); await m.down(); await m.move(to[0], to[1], { steps }); await m.up(); };

await page.goto(process.argv[2] ?? 'http://localhost:4180/app.html');
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await page.waitForSelector('canvas.stage');

// ---- Switch on from Preferences ----
await page.locator('.topbar [aria-label="Menu"]').click();
await page.locator('.menu-item', { hasText: 'Preferences' }).click();
await page.locator('.pref-group', { hasText: 'Layout' }).click();
await page.locator('.pref-page .segmented button', { hasText: 'Studio' }).click();
await page.locator('.modal-head .icon-btn').click();
check(await page.evaluate(() => document.body.classList.contains('studio')) && (await page.locator('.sp:visible').count()) === 5, 'studio shows five panels');
check((await page.locator('.dock-left .sp').count()) === 2 && (await page.locator('.dock-right .sp').count()) === 3 && (await page.locator('.sidebar').isHidden()), 'tools and brush properties dock left; colour, swatches and layers right; the floating sidebar is gone');
check((await page.locator('.sp-tools .tool').count()) === 7 && (await page.locator('.sp-brush .optionsbar .slider').count()) >= 4 && (await page.locator('.sp-brush .sp-sliders .slider').count()) === 2, 'the toolbar, options and size/opacity sliders live in the panels');
await page.screenshot({ path: `${out}/01-studio.png` });

// ---- Drawing still works and the canvas fits the middle ----
const stage = await page.locator('canvas.stage').boundingBox();
check(stage.x > 200 && stage.x + stage.width < 1200, `the canvas sits between the docks (${Math.round(stage.x)}..${Math.round(stage.x + stage.width)})`);
await drag([stage.x + 200, stage.y + 200], [stage.x + 500, stage.y + 400]);
check(await ed((e) => e.doc.log.at(-1)?.t === 'stroke'), 'a stroke goes through');

// ---- Colour wheel ----
const wheel = await page.locator('.cp-svwrap.wheel').boundingBox();
await m.click(wheel.x + wheel.width * 0.97, wheel.y + wheel.height / 2);
await m.click(wheel.x + wheel.width * 0.76, wheel.y + wheel.height * 0.24);
const col = await ed((e) => e.color);
check(/^#f[0-9a-f]0[0-9a-f]0[0-9a-f]$/.test(col), `the ring sets the hue and the square the shade (${col})`);
check((await page.locator('.sp-swatches .cp-swatch').count()) >= 24, 'swatches have their own panel');

// ---- Brush picker opens beside the toolbar ----
await page.locator('.sp-tools [aria-label^="Brush"]').click();
await page.waitForSelector('.brush-library');
const pop = await page.locator('.tool-pop').boundingBox(), tool = await page.locator('.sp-tools [aria-label^="Brush"]').boundingBox();
check(pop.x >= tool.x + tool.width && Math.abs(pop.y - tool.y) < 40, 'the library pops out to the right of the tool');
await page.keyboard.press('Escape');
await m.click(stage.x + 600, stage.y + 100);

// ---- Float, dock elsewhere, reorder ----
const head = page.locator('.sp-layers .sp-head');
let hb = await head.boundingBox();
await drag([hb.x + 40, hb.y + 12], [hb.x - 400, hb.y + 100]);
let st = await panel('layers');
check(st.dock === 'float' && st.x > 0 && (await page.locator('.sp-layers.float').count()) === 1, `dragging the title floats the panel (${st.x}, ${st.y})`);
await page.screenshot({ path: `${out}/02-floating.png` });
hb = await head.boundingBox();
await m.move(hb.x + 40, hb.y + 12); await m.down(); await m.move(700, 850, { steps: 10 });
check(await page.locator('.dock-hint.bottom').isVisible(), 'near an edge the dock zone lights up');
await m.up();
st = await panel('layers');
check(st.dock === 'bottom' && (await page.locator('.dock-bottom .sp-layers').count()) === 1, 'dropping there docks it to the bottom');
check((await page.locator('.sp-layers').boundingBox()).height <= 860 * 0.45 + 1, 'a docked panel takes at most 45% of the workspace');
hb = await head.boundingBox();
await drag([hb.x + 40, hb.y + 12], [1390, 100]);
st = await panel('layers');
check(st.dock === 'right' && st.order === 0 && (await page.locator('.dock-right .sp').first().getAttribute('data-panel')) === 'layers', 'dropping it at the top of the right side puts it first');
await page.screenshot({ path: `${out}/03-reordered.png` });

// ---- Resize and close ----
const grip = await page.locator('.sp-brush .sp-resize').boundingBox();
const before = await panel('brush');
await drag([grip.x + 7, grip.y + 7], [grip.x + 67, grip.y - 43], 5);
st = await panel('brush');
check(st.w === before.w + 60 && st.h === before.h - 50, 'the corner grip resizes a docked panel');
await page.locator('[aria-label="Close Swatches"]').click();
check(!(await panel('swatches')).show && (await page.locator('.sp-swatches').isHidden()), 'X hides a panel and remembers it');
await page.locator('.topbar [aria-label="Colour"]').click();
check(!(await panel('color')).show, 'the colour button toggles the colour panel instead of a popover');
await page.locator('.topbar [aria-label="Colour"]').click();

// ---- Prefs keep the layout; classic puts everything back ----
await page.locator('.topbar [aria-label="Menu"]').click();
await page.locator('.menu-item', { hasText: 'Preferences' }).click();
await page.locator('.pref-group', { hasText: 'Layout' }).click();
check((await page.locator('.pref-page .switch-row input').evaluateAll((els) => els.map((e) => e.checked))).join() === 'true,true,true,false,true,true', 'the Layout preferences list which panels show, and the minimap');
await page.locator('.pref-page .btn', { hasText: 'Reset layout' }).click();
check((await panel('layers')).order === 2 && (await panel('swatches')).show, 'Reset layout restores the default arrangement');
await page.locator('.pref-page .segmented button', { hasText: 'Simple' }).click();
await page.locator('.modal-head .icon-btn').click();
check((await page.locator('.topbar .tool').count()) === 7 && (await page.locator('.sidebar .slider').count()) === 2 && (await page.locator('#app > .optionsbar').count()) === 1 && (await page.locator('.studio').isHidden()), 'classic has its toolbar, sliders and options bar back');
await page.locator('.topbar [aria-label="Colour"]').click();
check(await page.locator('.color-pop .cp-hue').isVisible() && (await page.locator('.color-pop .cp-swatch').count()) >= 24, 'the colour popover is a bar picker with swatches again');
await page.screenshot({ path: `${out}/04-classic.png` });

console.log(errors.length ? errors : 'No page errors');
await browser.close();
if (failed || errors.length) process.exit(1);
console.log('all passed');
