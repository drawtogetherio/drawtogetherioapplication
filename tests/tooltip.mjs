// Tooltips: our own bubble replaces the browser's title one, so a hovering pen and keyboard focus get it too.
// Usage: node tests/tooltip.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/app.html';
const out = 'test-results/tooltip';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };

await page.goto(url);
await page.getByText('Create canvas').click();
await page.waitForSelector('.topbar');
await page.waitForTimeout(200);
const tip = page.locator('.tip');
const hover = (sel, type) => page.locator(sel).first().evaluate((el, t) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: t })), type);

check((await page.evaluate(() => document.querySelectorAll('[title]').length)) === 0, 'nothing in the app carries a native title');
const brush = page.locator('.topbar [data-tip="Brush (B)"]').first();
await brush.hover();
await tip.waitFor({ state: 'visible' });
check((await tip.evaluate((e) => e.firstChild.textContent)) === 'Brush' && (await tip.locator('kbd').innerText()) === 'B', 'hovering with the mouse shows the tip, with the shortcut as a key');
const [b, t] = await Promise.all([brush.boundingBox(), tip.boundingBox()]);
check(t.y >= b.y + b.height && Math.abs(t.x + t.width / 2 - (b.x + b.width / 2)) < 2, 'it sits centred under the control');
await page.screenshot({ path: `${out}/01-mouse.png` });
await page.mouse.move(640, 500);
await tip.waitFor({ state: 'hidden' });
check(true, 'and goes when the pointer leaves');

const layers = page.locator('.topbar [data-tip^="Layers"]').first();
await hover('.topbar [data-tip^="Layers"]', 'pen');
await tip.waitFor({ state: 'visible', timeout: 1500 });
check((await tip.innerText()).startsWith('Layers'), 'a hovering pen gets the tip too');
await layers.evaluate((el) => el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'pen', relatedTarget: document.body })));
await tip.waitFor({ state: 'hidden' });

await hover('.topbar [data-tip^="Layers"]', 'touch');
await page.waitForTimeout(800);
check(await tip.isHidden(), 'a finger does not');

await brush.hover();
await tip.waitFor({ state: 'visible' });
await page.mouse.down();
check(await tip.isHidden(), 'pressing hides it');
await page.mouse.up();
await page.mouse.move(640, 500);

await brush.focus();
await page.keyboard.press('Tab');
const focused = await page.evaluate(() => document.activeElement?.closest('[data-tip]')?.getAttribute('data-tip') ?? '');
await tip.waitFor({ state: 'visible' });
check(focused && (await tip.innerText()).replace(/\s+/g, '') === focused.replace(/\s*\((\w+)\)$/, '$1').replace(/\s+/g, ''), `keyboard focus shows it (${focused})`);
await page.screenshot({ path: `${out}/02-focus.png` });
await page.keyboard.press('Escape');
check(await tip.isHidden(), 'Escape dismisses it');

await browser.close();
if (errors.length) { console.log('page errors:', errors); failed++; }
process.exit(failed ? 1 : 0);
