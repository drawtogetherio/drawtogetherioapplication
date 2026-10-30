// Smoke test: drives the app in Chromium and saves screenshots to test-results/.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = 'test-results';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(url);
await page.screenshot({ path: `${out}/01-new-canvas.png` });

// Pick A4 fixed canvas
const mode = process.env.MODE ?? 'fixed';
if (mode === 'fixed') await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await page.waitForTimeout(200);

const stage = page.locator('canvas.stage');
const box = await stage.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

// Pen stroke with varying pressure (synthetic pointer events)
async function penStroke(points) {
  await page.evaluate((pts) => {
    const c = document.querySelector('canvas.stage');
    const fire = (type, p, pressure) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'pen', clientX: p[0], clientY: p[1], pressure, buttons: type === 'pointerup' ? 0 : 1, button: 0, bubbles: true,
    }));
    fire('pointerdown', pts[0], 0.1);
    pts.forEach((p, i) => fire('pointermove', p, Math.sin((i / pts.length) * Math.PI)));
    fire('pointerup', pts[pts.length - 1], 0);
  }, points);
}
const wave = [];
for (let i = 0; i <= 80; i++) wave.push([cx - 250 + i * 6, cy - 120 + Math.sin(i / 8) * 60]);
await penStroke(wave);

// Mouse stroke
await page.mouse.move(cx - 200, cy + 60);
await page.mouse.down();
for (let i = 0; i < 30; i++) await page.mouse.move(cx - 200 + i * 12, cy + 60 + Math.cos(i / 4) * 30);
await page.mouse.up();

// Shape: ellipse, then rect
await page.keyboard.press('u');
await page.locator('.optionsbar .preset-btn').click();
await page.locator('.icon-choices [aria-label="Ellipse"]').click();
await page.mouse.move(cx + 40, cy - 40); await page.mouse.down(); await page.mouse.move(cx + 200, cy + 100, { steps: 5 }); await page.mouse.up();

// Fill inside the ellipse with red on a new layer below
await page.locator('.color-btn').click();
await page.locator('.cp-swatch[data-tip="#e53935"]').first().click();
await page.keyboard.press('Escape');
await page.mouse.click(10, 300); // dismiss popover
await page.keyboard.press('g');
await page.mouse.click(cx + 120, cy + 30);
await page.screenshot({ path: `${out}/02-drawn.png` });

// Select + transform: rectangle selection around the ellipse, move & rotate
await page.keyboard.press('m');
await page.mouse.move(cx + 20, cy - 60); await page.mouse.down(); await page.mouse.move(cx + 220, cy + 120, { steps: 5 }); await page.mouse.up();
await page.mouse.move(cx + 120, cy + 30); await page.mouse.down(); await page.mouse.move(cx + 160, cy + 120, { steps: 5 }); await page.mouse.up();
await page.screenshot({ path: `${out}/03-transforming.png` });
await page.keyboard.press('Enter');
await page.keyboard.press('Control+d');

// New layer with multiply blend
await page.keyboard.press('b');
await page.locator('[data-tip="Layers (L)"]').click();
await page.locator('.head-actions [data-tip="New layer"]').click();
await page.locator('.blend-select').selectOption('multiply');
await page.mouse.click(10, 300);
await page.locator('.color-btn').click();
await page.locator('.cp-swatch[data-tip="#1e88e5"]').first().click();
await page.mouse.click(10, 300);
const st = await page.evaluate(() => { const a = window.doodlehive; a.ed.settings.brush.size = 60; return a.ed.doc.layers.length; });
await page.mouse.move(cx - 260, cy); await page.mouse.down(); await page.mouse.move(cx + 260, cy, { steps: 20 }); await page.mouse.up();
await page.locator('[data-tip="Layers (L)"]').click();
await page.screenshot({ path: `${out}/04-layers.png` });
await page.mouse.click(10, 300);

// Undo / redo
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+Shift+z');

// Flip + rotate view via API
await page.keyboard.press('h');
await page.screenshot({ path: `${out}/05-flipped.png` });
await page.keyboard.press('h');

// Exports
const sizes = {};
for (const f of ['PNG', 'JPG', 'PSD (layers)']) {
  await page.locator('[data-tip="Export (Ctrl+Shift+E)"]').click();
  await page.locator('.segmented button', { hasText: f }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.modal .btn.primary').click()]);
  const p = `${out}/export-${dl.suggestedFilename()}`;
  await dl.saveAs(p);
  sizes[dl.suggestedFilename()] = fs.statSync(p).size;
}
const info = await page.evaluate(() => {
  const d = window.doodlehive.ed.doc;
  return { layers: d.layers.map((l) => [l.props.name, l.props.blend, l.surface.size]), ops: d.log.map((o) => o.t), undo: d.history.canUndo };
});
console.log(JSON.stringify({ layersBefore: st, info, sizes, errors }, null, 1));
await browser.close();
