// Layer improvements: search, colour tags, multi-select actions, merge visible, flatten.
// Usage: node tests/layers.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
fs.mkdirSync('test-results/layers', { recursive: true });
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
const names = () => ed((e) => e.doc.layers.map((l) => l.props.name));
const rows = () => page.locator('.layers-panel .layer-row').allInnerTexts().then((t) => t.map((x) => x.split('\n')[0]));
const rowByName = (n) => page.locator('.layers-panel .layer-row', { hasText: n }).first();
// Paint a dot on each of four layers.
const dot = (x, y, color) => ed((e, a) => e.apply({ t: 'shape', id: Math.random().toString(36).slice(2, 10), layer: e.activeLayer, shape: 'rect', x0: a[0], y0: a[1], x1: a[0] + 100, y1: a[1] + 100, width: 0, fill: true, color: a[2], opacity: 1, erase: false }), [x, y, color]);
await dot(100, 100, '#ff0000');
for (const [i, [n, c]] of [['Sky', '#0000ff'], ['Lines', '#000000'], ['Notes', '#00ff00']].entries()) {
  await ed((e) => e.addLayer());
  await ed((e, n) => e.apply({ t: 'layer.props', id: Math.random().toString(36).slice(2, 10), layer: e.activeLayer, props: { name: n } }), n);
  await dot(300 + i * 200, 300, c);
}
check((await names()).join() === 'Layer 1,Sky,Lines,Notes', 'four layers');
await page.keyboard.press('l');

// ---- Search ----
await page.locator('.layer-search').fill('li');
check((await rows()).join() === 'Lines', `search narrows the stack (${await rows()})`);
await page.locator('.layer-search').fill('');
check((await rows()).length === 4, 'clearing shows all again');

// ---- Tags ----
await rowByName('Sky').click();
await page.locator('.layers-panel .layer-props:not([hidden]) .tag-dot').nth(5).click();
await page.waitForTimeout(100);
check(await ed((e) => e.doc.layer(e.activeLayer).props.color === '#1e88e5'), 'a tag dot sets the layer colour');
check(await rowByName('Sky').evaluate((el) => el.classList.contains('colored')), 'the row shows the tag');
check(await page.locator('.layers-panel .tag-dot.on').count() === 1, 'the chosen dot is marked');

// ---- Multi-select ----
await rowByName('Notes').click();
await rowByName('Sky').click({ modifiers: ['Shift'] });
check(await ed((e) => e.activeLayer) === await ed((e) => e.doc.layers.find((l) => l.props.name === 'Notes').props.id), 'Shift-click keeps the active layer');
check(await page.locator('.layers-panel .layer-row.picked').count() === 2, 'Shift-click picks the range');
check(await page.locator('.multi-bar:not([hidden])').isVisible() && (await page.locator('.multi-bar .opt-label').first().innerText()) === '3 layers selected', 'a bar for the picked layers');
await rowByName('Lines').click({ modifiers: ['Control'] });
check(await page.locator('.layers-panel .layer-row.picked').count() === 1, 'Ctrl-click drops one from the pick');
await rowByName('Lines').click({ modifiers: ['Control'] });
// Tag all three.
await page.locator('.multi-bar .tag-dot').nth(1).click();
await page.waitForTimeout(100);
check(await ed((e) => e.doc.layers.filter((l) => l.props.color === '#e53935').length === 3), 'tagging applies to every picked layer');
// Hide all three, show again.
await page.locator('.multi-bar button[data-tip="Show or hide selected"]').click();
await page.waitForTimeout(100);
check(await ed((e) => e.doc.layers.filter((l) => !l.props.visible).length === 3), 'visibility applies to all picked');
await page.locator('.multi-bar button[data-tip="Show or hide selected"]').click();
await page.waitForTimeout(100);
// Duplicate all three.
await page.locator('.multi-bar button[data-tip="Duplicate selected"]').click();
await page.waitForTimeout(200);
check((await names()).join() === 'Layer 1,Sky,Sky copy,Lines,Lines copy,Notes,Notes copy', `duplicates land above each original (${await names()})`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
check((await names()).length === 4, 'one undo removes all the copies');
// Merge selected.
await rowByName('Notes').click();
await rowByName('Sky').click({ modifiers: ['Shift'] });
await page.locator('.multi-bar button[data-tip="Merge selected"]').click();
await page.waitForTimeout(300);
check((await names()).join() === 'Layer 1,Sky', `merge selected leaves the bottom one (${await names()})`);
const merged = await ed((e) => { const l = e.doc.layers[1]; const r = l.surface.contentBounds(); return r && r.w; });
check(merged >= 500, `the merged layer holds all three dots (${merged}px wide)`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check((await names()).length === 4, 'one undo restores the three');

// ---- Merge visible / flatten ----
await ed((e) => e.apply({ t: 'layer.props', id: 'hide1', layer: e.doc.layers.find((l) => l.props.name === 'Lines').props.id, props: { visible: false } }));
await page.locator('.layers-panel button[data-tip="More"]').click();
await page.locator('.adjust-pick .menu-item', { hasText: 'Merge visible' }).click();
await page.waitForTimeout(300);
check((await names()).join() === 'Layer 1,Lines', `merge visible keeps the hidden layer apart (${await names()})`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
await page.locator('.layers-panel button[data-tip="More"]').click();
await page.locator('.adjust-pick .menu-item', { hasText: 'Flatten' }).click();
await page.waitForTimeout(300);
check((await names()).join() === 'Layer 1', `flatten drops hidden layers and merges the rest (${await names()})`);
await page.screenshot({ path: 'test-results/layers/01-flat.png' });
// Delete selected.
await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
check((await names()).length === 4, 'undo brings the stack back');
await rowByName('Sky').click();
await rowByName('Notes').click({ modifiers: ['Control'] });
await page.locator('.multi-bar button[data-tip="Delete selected"]').click();
await page.waitForTimeout(200);
check((await names()).join() === 'Layer 1,Lines', 'delete removes every picked layer');

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
