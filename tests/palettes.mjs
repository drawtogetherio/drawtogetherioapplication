// Palettes: .aco / .ase / Procreate .swatches / text import, saved palettes in the picker, colour harmonies.
// Usage: node tests/palettes.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import zlib from 'node:zlib';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/palettes';
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };

// ---- Sample files ----
const aco = (() => {
  const b = Buffer.alloc(4 + 10 * 3);
  b.writeUInt16BE(1, 0); b.writeUInt16BE(3, 2);
  b.writeUInt16BE(0, 4); b.writeUInt16BE(0xffff, 6); b.writeUInt16BE(0, 8); b.writeUInt16BE(0, 10); // RGB red
  b.writeUInt16BE(1, 14); b.writeUInt16BE(Math.round(120 * 182.04), 16); b.writeUInt16BE(0xffff, 18); b.writeUInt16BE(0xffff, 20); // HSB green
  b.writeUInt16BE(2, 24); b.writeUInt16BE(0xffff, 26); b.writeUInt16BE(0xffff, 28); b.writeUInt16BE(0, 30); b.writeUInt16BE(0xffff, 32); // CMYK yellow (inverted)
  return b;
})();
const ase = (() => {
  const name = Buffer.from('Blue\0', 'utf16le').swap16();
  const body = Buffer.concat([Buffer.from([0, name.length / 2]), name, Buffer.from('RGB '), Buffer.alloc(12), Buffer.from([0, 0])]);
  body.writeFloatBE(0, name.length + 6); body.writeFloatBE(0.5, name.length + 10); body.writeFloatBE(1, name.length + 14);
  const head = Buffer.alloc(12); head.write('ASEF', 0); head.writeUInt16BE(1, 4); head.writeUInt16BE(0, 6); head.writeUInt32BE(1, 8);
  const block = Buffer.alloc(6); block.writeUInt16BE(1, 0); block.writeUInt32BE(body.length, 2);
  return Buffer.concat([head, block, body]);
})();
/** A one-entry zip (deflated) holding Swatches.json, as Procreate writes. */
const swatches = (() => {
  const json = Buffer.from(JSON.stringify([{ name: 'Sunset', swatches: [{ hue: 0, saturation: 1, brightness: 1, alpha: 1, colorSpace: 0 }, null, { hue: 0.5, saturation: 1, brightness: 0.5, alpha: 1, colorSpace: 0 }] }]));
  const data = zlib.deflateRawSync(json), name = Buffer.from('Swatches.json');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(json.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(json.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOff = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
})();
const gpl = 'GIMP Palette\nName: Test\n#\n255   0   0\tRed\n  0 128 255\tSky\n';
fs.writeFileSync(`${out}/t.aco`, aco); fs.writeFileSync(`${out}/t.ase`, ase); fs.writeFileSync(`${out}/t.swatches`, swatches); fs.writeFileSync(`${out}/t.gpl`, gpl);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ed = (fn, arg) => page.evaluate(([src, a]) => new Function('ed', 'a', `return (${src})(ed, a)`)(window.doodlehive.ed, a), [fn.toString(), arg]);

await page.goto(url);
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await page.locator('.topbar .color-btn').click();
const pop = page.locator('.color-pop');
check(await pop.isVisible(), 'colour popover opens');
check((await pop.locator('.cp-palette-sel option').allInnerTexts()).join() === 'Default', 'palette menu starts with Default only');
check(await pop.locator('.cp-swatches').first().locator('.cp-swatch').count() === 24, 'the default palette shows its 24 swatches');

// ---- Imports ----
const importFile = async (file) => {
  const chooser = page.waitForEvent('filechooser');
  await pop.locator('button[data-tip^="Import a palette"]').click();
  await (await chooser).setFiles(file);
  await page.waitForTimeout(300);
};
const swatchesOf = () => pop.locator('.cp-swatches').first().locator('.cp-swatch').evaluateAll((els) => els.map((e) => e.dataset.tip.split(' ')[0]));
await importFile(`${out}/t.aco`);
check((await pop.locator('.cp-palette-sel').inputValue()) !== '' && (await pop.locator('.cp-palette-sel option:checked').innerText()) === 't', 'the .aco import becomes the current palette');
check((await swatchesOf()).join() === '#ff0000,#00ff00,#ffff00', `.aco RGB, HSB and CMYK swatches read (${await swatchesOf()})`);
await importFile(`${out}/t.ase`);
check((await swatchesOf()).join() === '#0080ff', `.ase RGB float swatch read (${await swatchesOf()})`);
await importFile(`${out}/t.swatches`);
check((await pop.locator('.cp-palette-sel option:checked').innerText()) === 'Sunset' && (await swatchesOf()).join() === '#ff0000,#008080', `Procreate .swatches read, named after the set (${await swatchesOf()})`);
await importFile(`${out}/t.gpl`);
check((await swatchesOf()).join() === '#ff0000,#0080ff', `.gpl rows read (${await swatchesOf()})`);
check(await pop.locator('.cp-palette-sel option').count() === 5, 'four palettes added');

// ---- Editing ----
await ed((e) => e.setColor('#123456', true));
await pop.locator('button[data-tip="Add the current colour"]').click();
check((await swatchesOf()).at(-1) === '#123456', 'the current colour is added to the palette');
await pop.locator('.cp-swatches').first().locator('.cp-swatch').first().click({ modifiers: ['Alt'] });
check((await swatchesOf()).join() === '#0080ff,#123456', 'Alt+click removes a swatch');
await pop.locator('.cp-swatches').first().locator('.cp-swatch').first().click();
check((await ed((e) => e.color)) === '#0080ff', 'clicking a swatch picks it');
await pop.locator('.cp-palette-sel').selectOption({ label: 'Sunset' });
check((await swatchesOf()).join() === '#ff0000,#008080', 'switching palettes shows the other set');
// Persists (prefs save a moment after the change).
await page.waitForTimeout(700);
await page.reload();
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await page.locator('.topbar .color-btn').click();
check((await pop.locator('.cp-palette-sel option:checked').innerText()) === 'Sunset' && (await swatchesOf()).join() === '#ff0000,#008080', 'palettes and the chosen one survive a reload');
await pop.locator('button[data-tip="Delete palette"]').click();
check((await pop.locator('.cp-palette-sel').inputValue()) === '' && (await pop.locator('.cp-palette-sel option').count()) === 4, 'Delete drops the palette and returns to Default');

// ---- Harmony ----
await ed((e) => e.setColor('#ff0000', true));
check(await pop.locator('.cp-harmony button.active').innerText() === 'Off' && (await pop.locator('.cp-swatches').nth(1).isHidden()), 'harmony starts off');
await pop.locator('.cp-harmony button', { hasText: 'Complementary' }).click();
const harm = () => pop.locator('.cp-swatches').nth(1).locator('.cp-swatch').evaluateAll((els) => els.map((e) => e.dataset.tip));
check((await harm()).join() === '#00ffff', `complementary of red is cyan (${await harm()})`);
await pop.locator('.cp-harmony button', { hasText: 'Triadic' }).click();
check((await harm()).join() === '#00ff00,#0000ff', `triadic gives green and blue (${await harm()})`);
await pop.locator('.cp-harmony button', { hasText: 'Shades' }).click();
check((await harm()).length === 6, 'shades offers six variations');
await ed((e) => e.setColor('#0000ff', true));
await pop.locator('.cp-harmony button', { hasText: 'Complementary' }).click();
check((await harm()).join() === '#ffff00', 'harmony follows the current colour');
await page.screenshot({ path: `${out}/01-picker.png` });

check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
