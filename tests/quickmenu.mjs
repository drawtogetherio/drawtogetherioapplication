// Quick menu (right click / Q) and the command palette (Ctrl+K).
// Usage: node tests/quickmenu.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/quickmenu';
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
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const menu = page.locator('.quick-menu');

// ---- The sidebar button opens it over itself; the sliders read their values ----
const qb = page.locator('.sidebar .quick-btn');
check(await qb.count() === 1 && (await page.locator('.sidebar > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).slice(0, 3).join() === 'slider,icon-btn,slider', 'a quick menu button sits between the size and opacity sliders');
await qb.click();
const qbb = await qb.boundingBox(), qm = await menu.boundingBox();
check(await menu.isVisible() && Math.abs(qm.x + qm.width / 2 - (qbb.x + qbb.width / 2)) < 80 && Math.abs(qm.y + qm.height / 2 - (qbb.y + qbb.height / 2)) < 80, 'the button opens the quick menu next to itself');
await page.keyboard.press('Escape');
check(await menu.isHidden(), 'Escape closes it');
const reads = await page.locator('.sidebar .slider .slider-value').allTextContents();
check(/^\d+(\.\d)?px$/.test(reads[0]) && /^\d+%$/.test(reads[1]) && await page.locator('.sidebar .slider .slider-value').first().isVisible(), `the sliders read size in px and opacity in % (${reads.join(', ')})`);
await ed((e) => { e.prefs.layout = 'studio'; window.doodlehive.applyPrefs(); });
check(await page.locator('.sp-sliders .quick-btn').count() === 1, 'the studio brush panel has the button too');
await page.locator('.sp-sliders .quick-btn').click();
check(await menu.isVisible(), 'and it opens the quick menu there');
await page.keyboard.press('Escape');
await ed((e) => { e.prefs.layout = 'classic'; window.doodlehive.applyPrefs(); });

// ---- Right click opens, drag-release runs ----
await m.move(cx, cy);
await m.down({ button: 'right' });
check(await menu.isVisible(), 'right click opens the quick menu');
check((await menu.locator('.quick-slot').count()) === 8, 'eight slots');
const brush = menu.locator('.quick-slot[aria-label="Brush"]');
check(await brush.isVisible(), 'default ring includes the brush');
const eraser = await menu.locator('.quick-slot[aria-label="Eraser"]').boundingBox();
await m.move(eraser.x + eraser.width / 2, eraser.y + eraser.height / 2, { steps: 3 });
await m.up({ button: 'right' });
check(await menu.isHidden(), 'releasing over a slot closes the menu');
check((await ed((e) => e.toolId)) === 'eraser', 'and runs its command (eraser)');
check((await ed((e) => e.doc.log.length)) === 1, 'the right click drew nothing');

// ---- Q key opens at the pointer; click a slot ----
await m.move(cx, cy);
await page.keyboard.press('q');
check(await menu.isVisible(), 'Q opens the quick menu');
const mb = await menu.boundingBox();
check(Math.abs(mb.x + mb.width / 2 - cx) < 2 && Math.abs(mb.y + mb.height / 2 - cy) < 2, 'centred on the pointer');
await menu.locator('.quick-slot[aria-label="Brush"]').click();
check((await ed((e) => e.toolId)) === 'brush', 'clicking a slot runs it');
check(await menu.isHidden(), 'and closes the menu');

// ---- Escape and outside clicks close ----
await page.keyboard.press('q');
await page.keyboard.press('Escape');
check(await menu.isHidden(), 'Escape closes it');
await page.keyboard.press('q');
await m.click(cx + 300, cy + 200);
check(await menu.isHidden(), 'clicking outside closes it');
check((await ed((e) => e.doc.log.length)) === 1, 'the outside click drew nothing');

// ---- Clamped to the viewport ----
await m.move(box.x + 5, box.y + 5);
await page.keyboard.press('q');
const slots = await Promise.all((await menu.locator('.quick-slot').all()).map((s) => s.boundingBox()));
check(slots.every((b) => b.x >= 0 && b.y >= 0), 'near a corner the ring stays on screen');
await page.keyboard.press('Escape');

// ---- Customise a slot ----
await m.move(cx, cy);
await page.keyboard.press('q');
await menu.locator('.quick-centre').click();
check(await menu.isVisible(), 'customise keeps the menu open');
check((await menu.locator('.quick-slot.editing').count()) === 8, 'slots show edit state');
await menu.locator('.quick-slot[aria-label="Flip canvas horizontally"]').click();
const pick = page.locator('.quick-pick');
check(await pick.isVisible(), 'a slot in edit mode opens the command list');
await pick.locator('.menu-item', { hasText: 'New layer' }).click();
check(await menu.locator('.quick-slot[aria-label="New layer"]').isVisible(), 'the slot now holds New layer');
check(await menu.locator('.quick-slot[aria-label="Flip canvas horizontally"]').isHidden(), 'and no longer flip');
await menu.locator('.quick-centre').click();
check((await menu.locator('.quick-slot.editing').count()) === 0, 'Done leaves edit mode');
await page.keyboard.press('Escape');
const saved = await ed((e) => e.prefs.quickMenu);
check(saved[6] === 'newLayer', 'the ring is saved in prefs');
await page.waitForTimeout(700);
await page.reload();
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
check((await ed((e) => e.prefs.quickMenu))[6] === 'newLayer', 'and survives a reload');
const layersBefore = await ed((e) => e.doc.layers.length);
await m.move(cx, cy);
await page.keyboard.press('q');
await menu.locator('.quick-slot[aria-label="New layer"]').click();
check((await ed((e) => e.doc.layers.length)) === layersBefore + 1, 'running New layer from the ring adds a layer');

// ---- Command palette ----
await page.keyboard.press('Control+k');
const cmdk = page.locator('.cmdk');
check(await cmdk.isVisible(), 'Ctrl+K opens the command palette');
check(await page.locator('.cmdk-input').evaluate((el) => el === document.activeElement), 'its input has focus');
const rows = await cmdk.locator('.cmdk-row').count();
check(rows > 20, `lists the commands (${rows})`);
check(await cmdk.locator('.cmdk-row', { hasText: 'Undo' }).locator('kbd', { hasText: 'Ctrl+Z' }).isVisible(), 'shows shortcuts');
await page.keyboard.type('flip vert');
check((await cmdk.locator('.cmdk-row').count()) === 1, 'typing filters');
const flipBefore = await ed((e) => e.view.viewport.flipY);
await page.keyboard.press('Enter');
check(await cmdk.isHidden(), 'Enter runs and closes');
check((await ed((e) => e.view.viewport.flipY)) === -flipBefore, 'the canvas flipped vertically');
await page.keyboard.press('Control+k');
await page.keyboard.type('zzzz');
check(await cmdk.getByText('No matching command').isVisible(), 'an empty result says so');
await page.keyboard.press('Escape');
check(await cmdk.isHidden(), 'Escape closes the palette');
await page.keyboard.press('Control+k');
await page.keyboard.type('eraser');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
check((await ed((e) => e.toolId)) === 'eraser', 'arrows and Enter pick a command');
check((await ed((e) => e.doc.log.length)) === 2, 'typing in the palette triggered no single-key shortcuts');

// Menu item
await page.locator('.topbar button[data-tip="Menu"]').click();
await page.locator('.menu-item', { hasText: 'Commands' }).click();
check(await cmdk.isVisible(), 'the menu has a Commands item');
await page.keyboard.press('Escape');

await page.screenshot({ path: `${out}/done.png` });
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
