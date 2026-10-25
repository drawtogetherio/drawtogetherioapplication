// Preferences: grouped dialog, themes, pressure editor, key rebinding, synced through the account.
// Needs `npm run dev` with dev login on. Usage: DB_PATH=... node tests/prefs.mjs [http://localhost:5173]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

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

const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
const me = () => page.evaluate(async () => (await fetch('/api/me')).json());
const group = (g) => page.locator(`.pref-group[data-group="${g}"]`).click();
const openPrefs = async () => {
  await page.locator('.me-pic').click();
  await page.locator('.account-pop .menu-item', { hasText: 'Preferences' }).click();
  await page.waitForSelector('.modal[aria-label="Preferences"]');
};
const closePrefs = () => page.locator('.modal-head .icon-btn').click();

// ---- Patreon banner ----
const banner = page.locator('.support-banner');
check(await banner.isVisible() && /patreon\.com/.test(await banner.locator('a').getAttribute('href')), 'the support banner shows on the home screen');
await banner.locator('.icon-btn').click();
check(await banner.isHidden(), 'X closes it');
await page.waitForTimeout(700);
await page.reload();
await page.waitForSelector('.home:not([hidden])');
check(await banner.isHidden(), 'it stays closed after a reload');

// ---- Groups ----
await openPrefs();
const groups = await page.locator('.pref-group').evaluateAll((els) => els.map((e) => e.textContent));
check(groups.join() === 'Appearance,Layout,Canvas,Pressure,Shortcuts,About', 'groups down the left: appearance, layout, canvas, pressure, shortcuts, about');
check((await page.locator('.pref-page h3').textContent()) === 'Appearance', 'opens on appearance');

// ---- Appearance ----
await page.locator('.theme-swatch[aria-label^="Lavender"]').click();
await page.waitForSelector('.toast.show');
check((await page.locator('.toast').innerText()).includes('premium') && (await accent()) === '#f4c25b', 'only Honey is free');
check((await page.locator('.theme-swatch.custom.locked').count()) === 1, 'the custom colour is locked too');
await page.locator('.segmented button', { hasText: 'Light' }).click();
check(await page.evaluate(() => document.documentElement.dataset.mode === 'light'), 'light mode applies at once');
await page.screenshot({ path: `${out}/01-appearance.png` });

// ---- Layout ----
await group('Layout');
check((await page.locator('.pref-page .switch-row:visible').count()) === 0, 'panel toggles only show for studio');
await page.locator('.segmented button', { hasText: 'Studio' }).click();
check((await page.locator('.pref-page .switch-row:visible').allTextContents()).join() === 'Tools,Brush properties,Colour wheel,Swatches,Layers', 'studio lists its five panels');
await page.locator('.switch-row', { hasText: 'Swatches' }).locator('input').click();
await page.locator('.segmented button', { hasText: 'Simple' }).click();
await page.evaluate(() => { const p = window.doodlehive.ed.prefs; p.customBrushes.push({ id: 'cmine', name: 'Mine', cat: 'Pen', params: { ...window.doodlehive.ed.settings.brush, hardness: 0.25 } }); p.brushCategories.push('Inks'); });

// ---- Canvas ----
await group('Canvas');
await page.locator('.switch-row', { hasText: 'Brush outline' }).locator('input').click();
await page.locator('.switch-row', { hasText: 'Draw with a finger' }).locator('input').click();
check(await page.evaluate(() => window.doodlehive.ed.prefs.fingerDraws === false), 'finger drawing lives in canvas preferences');
await page.locator('.switch-row', { hasText: 'Chime when mentioned' }).locator('input').click();
check(await page.evaluate(() => window.doodlehive.ed.prefs.chime === false), 'the mention chime can be turned off');

// ---- About ----
await group('About');
check(/^v\d+\.\d+\.\d+$/.test((await page.locator('.pref-row', { hasText: 'Doodlehive' }).locator('span').last().textContent()).trim()), 'About shows the app version');

// ---- Pressure ----
await group('Pressure');
check((await page.locator('.prefs .slider').count()) === 1 && (await page.locator('.curve-editor').count()) === 0, 'simple mode is a slider');
await page.locator('.segmented button', { hasText: 'Advanced' }).click();
const curve = page.locator('.curve-editor');
await curve.waitFor();
const cb = await curve.boundingBox();
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
const pts = await page.evaluate(() => window.doodlehive.ed.prefs.pressureCurve);
check(pts.length === 6 && Math.abs(pts[2] - 0.5) < 0.05 && Math.abs(pts[3] - 0.5) < 0.05, `a click adds a point to the graph (${pts.map((v) => v.toFixed(2)).join(' ')})`);
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height * 0.25, { steps: 8 });
await page.mouse.up();
check(await page.evaluate(() => window.doodlehive.ed.prefs.pressureCurve[3] > 0.65), 'dragging moves it');
await page.screenshot({ path: `${out}/02-pressure.png` });

// ---- Shortcuts ----
await group('Shortcuts');
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
await closePrefs();

// ---- Saved with the account ----
await page.waitForTimeout(700);
let m = await me();
check(m.prefs.mode === 'light' && m.prefs.keys.fill === 'q' && m.prefs.hoverPreview === false && m.prefs.fingerDraws === false
  && m.prefs.pressureMode === 'advanced' && m.prefs.pressureCurve.length === 6 && m.prefs.supportBanner === false, 'preferences are stored on the account');
check(m.prefs.layout === 'classic' && m.prefs.panels.swatches.show === false && m.prefs.panels.layers.dock === 'right'
  && m.prefs.customBrushes[0]?.name === 'Mine' && m.prefs.customBrushes[0].params.hardness === 0.25 && m.prefs.brushCategories.join() === 'Inks', 'layout, panels, custom brushes and categories too');

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

// ---- Hamburger menu ----
await page.locator('[aria-label="Menu"]').click();
const menu = await page.locator('.menu-pop').innerText();
check(!/finger|shortcut|\bFill\b/i.test(menu) && (await page.locator('.menu-pop .shortcuts').count()) === 0, 'the menu has no finger toggle or shortcut list');
await page.screenshot({ path: `${out}/03-menu.png` });
await page.locator('.menu-pop .menu-item', { hasText: 'Preferences' }).click();
await page.waitForSelector('.modal[aria-label="Preferences"]');
check(true, 'Preferences opens from the menu');
await closePrefs();

// ---- Profile card hides the hex ----
await page.locator('.members-btn').click();
await page.locator('.member-row').first().click();
await page.waitForSelector('.modal .profile-card-head');
check((await page.locator('.modal .fav, .modal .fav-swatch').count()) === 0, 'profile card shows no colour box or hex');
await page.locator('.modal-head .icon-btn').click();

// ---- Premium: custom colour and gradients ----
if (process.env.DB_PATH) {
  execSync(`npx tsx server/admin.ts premium Pia${suffix} forever`, { env: process.env, stdio: 'ignore' });
  await page.reload();
  await page.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
  await page.locator('[aria-label="Menu"]').click();
  await page.locator('.menu-pop .menu-item', { hasText: 'Preferences' }).click();
  await page.waitForSelector('.modal[aria-label="Preferences"]');
  await page.locator('.theme-swatch[aria-label^="Blueberry"]').click();
  check(await accent() === '#4f8cff', 'premium unlocks the other themes');
  await page.locator('.theme-swatch.custom').fill('#2a9d8f');
  await page.waitForTimeout(500);
  m = await me();
  check(await accent() === '#2a9d8f' && m.theme === 'custom:#2a9d8f', 'and a colour of their own, saved to the account');
  await page.screenshot({ path: `${out}/04-custom-theme.png` });
  await closePrefs();

  await page.evaluate(() => fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gradient: ['#ff6b6b', '#4f8cff'] }) }));
  await page.reload();
  await page.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
  await page.locator('.members-btn').click();
  await page.locator('.member-row').first().click();
  await page.waitForSelector('.modal .profile-card-head');
  check((await page.locator('.modal .fav').count()) === 0 && (await page.locator('.avatar.has-gradient').count()) >= 1, 'a gradient profile shows no plain colour or swatch');
  await page.screenshot({ path: `${out}/05-gradient-card.png` });
} else console.log('skip premium checks (set DB_PATH to run the admin script)');

await browser.close();
if (errors.length) { console.log('page errors:', errors); failed++; }
process.exit(failed ? 1 : 0);
