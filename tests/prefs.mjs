// Preferences: rebinding keys, light mode and hover outline, synced through the account.
// Needs `npm run dev` with dev login on. Usage: node tests/prefs.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/prefs';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);

const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[1349]/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto(base + '/app');
await page.waitForURL(/\/login/);
await page.fill('#dev-name', 'Pia' + suffix);
await page.getByRole('button', { name: 'Dev login' }).click();
await page.waitForSelector('#display-name');
await page.fill('#display-name', 'Pia');
await page.getByRole('button', { name: 'Start drawing' }).click();
await page.waitForSelector('.home:not([hidden])');

// ---- Open from the account menu ----
await page.locator('.account-btn').click();
await page.locator('.account-pop .menu-item', { hasText: 'Preferences' }).click();
await page.waitForSelector('.modal[aria-label="Preferences"]');
const sections = await page.locator('.pref-section h3').evaluateAll((els) => els.map((e) => e.textContent));
check(sections.join() === 'Appearance,Canvas,Shortcuts', 'sections: appearance, canvas, shortcuts');

// ---- Light mode ----
await page.locator('.prefs .segmented button', { hasText: 'Light' }).click();
check(await page.evaluate(() => document.documentElement.dataset.mode === 'light'), 'light mode applies at once');
await page.screenshot({ path: `${out}/01-light-prefs.png` });

// ---- Rebind a key ----
const chip = page.locator('.key-chip[data-action="brush"]');
await chip.click();
await page.keyboard.press('q');
check((await chip.innerText()) === 'Q', 'brush is now Q');
await page.locator('.key-chip[data-action="fill"]').click();
await page.keyboard.press('q');
check((await chip.innerText()) === '—' && (await page.locator('.key-chip[data-action="fill"]').innerText()) === 'Q', 'a taken key moves to the new action');
await page.locator('.key-chip[data-action="brush"]').click();
await page.keyboard.press('b');
await page.locator('.key-chip[data-action="brush"]').click();
await page.keyboard.press('Escape');
check((await chip.innerText()) === 'B', 'Escape keeps the old binding');
await page.locator('.prefs .switch-row', { hasText: 'Brush outline' }).locator('input').click();
await page.locator('.modal-head .icon-btn').click();

// ---- Saved with the account ----
await page.waitForTimeout(700);
const me = await page.evaluate(async () => (await fetch('/api/me')).json());
check(me.prefs.mode === 'light' && me.prefs.keys.fill === 'q' && me.prefs.hoverPreview === false, 'preferences are stored on the account');

await page.reload();
await page.waitForSelector('.home:not([hidden])');
check(await page.evaluate(() => document.documentElement.dataset.mode === 'light'), 'light mode comes back after a reload');
const room = await page.evaluate(async () => (await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Keys', settings: { infinite: true }, share: { visibility: 'open' } }) })).json());
await page.goto(`${base}/app?room=${room.id}`);
await page.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
await page.keyboard.press('e');
await page.keyboard.press('q');
check(await page.evaluate(() => window.doodlehive.ed.toolId === 'fill'), 'the new key picks the tool');
await page.keyboard.press('g');
check(await page.evaluate(() => window.doodlehive.ed.toolId === 'fill'), 'the old key no longer does');
check((await page.locator('.topbar [aria-label="Fill (Q)"]').count()) === 1, 'tool tips show the new key');
await page.locator('[aria-label="Menu"]').click();
check((await page.locator('.shortcuts').innerText()).includes('Q Fill'), 'the shortcut list follows');
await page.screenshot({ path: `${out}/02-light-canvas.png` });
await page.locator('[aria-label="Menu"]').click();

// ---- Profile card hides the hex ----
await page.locator('.members-btn').click();
await page.locator('.member-row').first().click();
await page.waitForSelector('.modal .fav');
check((await page.locator('.modal .fav').innerText()).trim() === '' && (await page.locator('.modal .fav-swatch').count()) === 1, 'profile card shows a swatch, not the hex');

await browser.close();
if (errors.length) { console.log('page errors:', errors); failed++; }
process.exit(failed ? 1 : 0);
