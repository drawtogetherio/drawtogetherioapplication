// iPad app: Apple Pencil double-tap and squeeze, the quick palette, the Apple Pencil preferences and share-sheet exports.
// The native plugins are faked in the page the way Capacitor injects them. Usage: node tests/pencil.mjs [http://localhost:4180/app.html]
import { chromium } from '@playwright/test';

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const errors = [];

async function open(fake) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  page.on('pageerror', (e) => errors.push(e.message));
  if (fake) await page.addInitScript(() => {
    const plugin = (extra) => ({ listeners: {}, addListener(event, cb) { (this.listeners[event] ??= []).push(cb); return { remove() {} }; }, ...extra });
    window.__shared = [];
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        Doodlehive: plugin({ info: async () => ({ apns: 'sandbox', pencilOnly: false, hoverPreview: true, squeeze: true }), setBadge: async () => {} }),
        // Filesystem is only faked once the page has picked its canvas storage, so canvases stay in IndexedDB here.
        Share: { share: async (o) => { window.__shared.push(o); } },
      },
    };
    window.__fire = (event, data) => { for (const cb of window.Capacitor.Plugins.Doodlehive.listeners[event] ?? []) cb(data); };
  });
  await page.goto(process.argv[2] ?? 'http://localhost:4180/app.html');
  await page.getByText('Create canvas').click();
  await page.waitForSelector('canvas.stage');
  return page;
}

const page = await open(true);
const tool = () => page.evaluate(() => window.doodlehive.ed.toolId);
const fire = (event, data) => page.evaluate(([e, d]) => window.__fire(e, d), [event, data]);

// ---- Double-tap follows iPadOS's setting by default ----
await fire('pencilTap', { action: 'switchEraser', hover: false });
check(await tool() === 'eraser', 'double-tap set to "switch eraser" picks the eraser');
await fire('pencilTap', { action: 'switchEraser', hover: false });
check(await tool() === 'brush', 'double-tap again goes back to the brush');
await page.evaluate(() => window.doodlehive.ed.setTool('fill'));
await fire('pencilTap', { action: 'switchEraser', hover: false });
await fire('pencilTap', { action: 'switchEraser', hover: false });
check(await tool() === 'fill', 'from the fill tool, the eraser toggle returns to fill');
await fire('pencilTap', { action: 'switchPrevious', hover: false });
check(await tool() === 'eraser', '"switch to previous" swaps with the last tool');
await page.evaluate(() => window.doodlehive.ed.setTool('brush'));
await fire('pencilTap', { action: 'showColorPalette', hover: false });
check(await page.locator('.color-pop').isVisible(), '"show colour palette" opens the colour picker');
await fire('pencilTap', { action: 'showColorPalette', hover: false });
check(await page.locator('.color-pop').isHidden(), 'and closes it again');
await fire('pencilTap', { action: 'showInkAttributes', hover: false });
check(await page.locator('.tool-pop:not([hidden]) .brush-library').count() === 1, '"show ink attributes" opens the brush library');
await page.keyboard.press('Escape');
await fire('pencilTap', { action: 'ignore', hover: false });
check(await tool() === 'brush', '"off" in iPadOS does nothing');

// ---- Squeeze: the quick palette under the hovering tip ----
await page.evaluate(() => window.doodlehive.ed.setColor('#ff0066', true));
await fire('pencilSqueeze', { action: 'showContextualPalette', hover: true, x: 600, y: 400, z: 0.3 });
const pal = page.locator('.pencil-palette');
check(await pal.isVisible(), 'squeeze opens the quick palette');
const box = await pal.boundingBox();
check(box && Math.abs(box.x + box.width / 2 - 600) < 2 && Math.abs(box.y + box.height / 2 - 400) < 2, 'centred under the Pencil tip');
check(await pal.locator('.pp-swatch[title="#ff0066"]').count() === 1, 'it lists recent colours');
await page.screenshot({ path: 'test-results/pencil-palette.png' }).catch(() => {});
await pal.getByRole('button', { name: 'Smudge' }).click();
check(await tool() === 'smudge' && await pal.isHidden(), 'picking a tool switches and closes it');
await fire('pencilSqueeze', { action: 'showContextualPalette', hover: false });
const box2 = await pal.boundingBox();
check(box2 && Math.abs(box2.x + box2.width / 2 - 590) < 2, 'without hover it opens in the middle');
await page.mouse.click(100, 700);
check(await pal.isHidden(), 'tapping elsewhere closes it');

// ---- Preferences override iPadOS ----
await page.evaluate(() => { const ed = window.doodlehive.ed; ed.setTool('brush'); ed.prefs.pencilTap = 'undo'; ed.prefs.pencilSqueeze = 'eraser'; });
const stroke = (p) => p.evaluate(async () => {
  const c = document.querySelector('canvas.stage');
  const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 3, pointerType: 'pen', clientX: x, clientY: y, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
  fire('pointerdown', 300, 300); for (let i = 1; i < 10; i++) fire('pointermove', 300 + i * 10, 300); fire('pointerup', 400, 300);
  await new Promise((r) => setTimeout(r, 100));
});
await stroke(page);
const done = () => page.evaluate(() => window.doodlehive.ed.doc.history.done.length);
const before = await done();
check(before > 0, 'a stroke to undo');
await fire('pencilTap', { action: 'switchEraser', hover: false });
check(await done() === before - 1 && await tool() === 'brush', 'double-tap set to Undo undoes instead of following iPadOS');
await fire('pencilSqueeze', { action: 'showContextualPalette', hover: false });
check(await tool() === 'eraser' && await pal.isHidden(), 'squeeze set to eraser switches tools');

await page.locator('[aria-label="Menu"]').click();
await page.locator('.menu-item', { hasText: 'Preferences' }).click();
await page.locator('.pref-group', { hasText: 'Apple Pencil' }).click();
const tap = page.locator('select[aria-label="Double-tap"]');
check(await tap.inputValue() === 'undo', 'the Apple Pencil page shows the double-tap choice');
await tap.selectOption('palette');
check(await page.evaluate(() => window.doodlehive.ed.prefs.pencilTap) === 'palette', 'changing it saves the preference');
await page.keyboard.press('Escape');

await page.close();

// ---- Export goes through the share sheet when Filesystem and Share are there ----
const page2 = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page2.on('pageerror', (e) => errors.push(e.message));
await page2.addInitScript(() => {
  window.__shared = [];
  window.Capacitor = { isNativePlatform: () => true, Plugins: {
    Share: { share: async (o) => { window.__shared.push(o); } },
    Filesystem: {
      writeFile: async (o) => { window.__written = o; return { uri: 'file:///cache/' + o.path }; },
      // Enough of the Filesystem for canvas storage to work.
      readdir: async () => ({ files: [] }), readFile: async () => { throw new Error('missing'); }, appendFile: async () => {}, rmdir: async () => {}, mkdir: async () => {},
    },
  } };
});
await page2.goto(process.argv[2] ?? 'http://localhost:4180/app.html');
await page2.getByText('Create canvas').click();
await page2.waitForSelector('canvas.stage');
check(await page2.locator('.pref-group', { hasText: 'Apple Pencil' }).count() === 0, '(no Doodlehive plugin: no Pencil page)');
await stroke(page2);
await page2.keyboard.press('Control+Shift+E');
await page2.locator('.modal .btn.primary', { hasText: 'Export' }).click();
await page2.waitForFunction(() => window.__shared.length > 0, null, { timeout: 5000 }).catch(() => {});
const out = await page2.evaluate(() => ({ shared: window.__shared, written: window.__written && { path: window.__written.path, dir: window.__written.directory, len: window.__written.data.length } }));
check(out.shared.length === 1 && out.shared[0].files?.[0] === 'file:///cache/' + out.written?.path, 'export opens the share sheet with the written file');
check(out.written?.dir === 'CACHE' && out.written.len > 100 && /\.png$/.test(out.written.path), 'the file is written to the cache as base64');

await browser.close();
check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
