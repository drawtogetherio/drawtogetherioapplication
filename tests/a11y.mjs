// Accessibility: every control has a name, keyboard focus is visible, Tab reaches the bars, and the left-handed layout mirrors.
// Usage: node tests/a11y.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/a11y';
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

/** Buttons in `root` with no accessible name. */
const unnamed = (root) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)]
  .filter((b) => b.offsetParent !== null && !(b.getAttribute('aria-label') || b.textContent.trim() || b.title))
  .map((b) => b.className), root);

// ---- Names on every visible control, in each bar and popover ----
check((await unnamed('.topbar')).length === 0, 'every top bar button has a name');
check((await unnamed('.sidebar')).length === 0, 'every sidebar button has a name');
for (const [key, pop, label] of [['l', '.layers-pop', 'layers'], ['m', '.optionsbar', 'selection options'], ['u', '.optionsbar', 'shape options'], ['g', '.optionsbar', 'fill options']]) {
  await page.keyboard.press(key);
  const bad = await unnamed(pop);
  check(bad.length === 0, `every ${label} control has a name${bad.length ? ': ' + bad.join(', ') : ''}`);
}
await page.keyboard.press('Escape');
await page.locator('.topbar button[title^="Guides"]').click();
check((await unnamed('.guides-pop')).length === 0, 'every guides control has a name');
await page.keyboard.press('Escape');
await page.locator('.topbar button[title="Effects"]').click();
check((await unnamed('.effects-pop')).length === 0, 'every effects item has a name');
await page.keyboard.press('Escape');
await page.locator('.topbar button[title="Menu"]').click();
check((await unnamed('.menu-pop')).length === 0, 'every menu item has a name');
await page.keyboard.press('Escape');
const dialogsBtn = page.locator('.sidebar button[title="History"]');
await dialogsBtn.click();
check((await unnamed('.history-pop')).length === 0, 'every history control has a name');
await page.keyboard.press('Escape');

// Layer tags: a letter and a name, not colour alone.
await page.keyboard.press('l');
await page.locator('.layers-pop .layer-row').first().click({ modifiers: ['Control'] });
const tags = page.locator('.layers-pop .tag-dot');
check((await tags.count()) === 7, 'tag dots shown for the selection');
check((await tags.nth(1).textContent()) === 'R' && (await tags.nth(1).getAttribute('title')) === 'Tag: Red', 'tag dots carry a letter and a colour name');
await page.keyboard.press('Escape');

// ---- Keyboard: Tab reaches the tool bar; focus is visible ----
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press('F6');
const where = () => page.evaluate(() => { const el = document.activeElement; return el.closest('.topbar') ? 'topbar' : el.closest('.optionsbar') ? 'options' : el.closest('.sidebar') ? 'sidebar' : el.tagName; });
check((await where()) === 'topbar', 'F6 from the canvas focuses the top bar');
await page.keyboard.press('Tab');
const focused = await page.evaluate(() => {
  const el = document.activeElement, cs = getComputedStyle(el);
  return { inBar: !!el.closest('.topbar'), outline: cs.outlineStyle, width: cs.outlineWidth };
});
check(focused.inBar, 'Tab moves through the top bar instead of hiding the UI');
check(focused.outline !== 'none' && focused.width !== '0px', `keyboard focus shows a ring (${focused.outline} ${focused.width})`);
await page.keyboard.press('F6');
check((await where()) === 'options', 'F6 again reaches the options bar');
await page.keyboard.press('F6');
check((await where()) === 'sidebar', 'then the sidebar');
await page.keyboard.press('Shift+F6');
check((await where()) === 'options', 'Shift+F6 goes back');
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press('Tab');
check(await page.evaluate(() => document.body.classList.contains('ui-hidden')), 'Tab from the canvas still hides the UI');
await page.keyboard.press('Tab');
check(!(await page.evaluate(() => document.body.classList.contains('ui-hidden'))), 'and shows it again');
// Layers by key, then focus lands in the panel.
await page.keyboard.press('l');
check(await page.evaluate(() => !!document.activeElement?.closest('.layers-panel')), 'L opens the layers panel and focuses it');
await page.keyboard.press('Escape');
// The palette gives a keyboard-only route to everything.
await page.keyboard.press('Control+k');
await page.keyboard.type('colour picker');
await page.keyboard.press('Enter');
check(await page.locator('.color-pop').isVisible(), 'the colour picker opens from the keyboard via the palette');
await page.keyboard.press('Escape');

// ---- Reduced motion ----
await page.emulateMedia({ reducedMotion: 'reduce' });
const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.toast')).transitionDuration);
check(parseFloat(dur) < 0.001, `reduced motion shortens transitions (${dur})`);
await page.emulateMedia({ reducedMotion: 'no-preference' });

// ---- Left-handed layout ----
const sideX = async () => (await page.locator('.sidebar').boundingBox()).x;
const toolX = async () => (await page.locator('.topbar .tool').first().boundingBox()).x;
check((await sideX()) < 640 && (await toolX()) > 640, 'default: sliders left, tools right');
await ed((e) => { e.prefs.leftHanded = true; e.emit('prefs'); window.doodlehive.app?.applyPrefs?.(); });
await page.waitForTimeout(700);
await page.reload();
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
check(await page.evaluate(() => document.body.classList.contains('left-handed')), 'left-handed pref survives a reload');
check((await sideX()) > 640 && (await toolX()) < 640, 'left-handed: tools left, sliders right');
check((await page.locator('.minimap').boundingBox()).x < 640, 'minimap moves to the left');
await page.keyboard.press('l');
check((await page.locator('.layers-pop').boundingBox()).x < 640, 'the layers popover opens by the tools');
await page.keyboard.press('Escape');
await page.screenshot({ path: `${out}/left-handed.png` });
await page.locator('.topbar button[title="Menu"]').click();
await page.locator('.menu-item', { hasText: 'Preferences' }).click();
await page.getByText('Layout', { exact: true }).first().click();
const lh = page.locator('.switch-row', { hasText: 'Left-handed' }).locator('input');
check(await lh.isChecked(), 'Preferences shows the left-handed switch on');
await lh.click();
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
check(!(await page.evaluate(() => document.body.classList.contains('left-handed'))), 'turning it off mirrors back');

check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
