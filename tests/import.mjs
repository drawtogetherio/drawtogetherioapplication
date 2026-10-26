// Brush import: Photoshop .abr (v2 and v6) and a Procreate .brushset, each built here, through the library's Import button;
// imported brushes give out no share code until the owner confirms the rights.
// Usage: node tests/import.mjs http://localhost:4180/app.html
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import zlib from 'node:zlib';

const url = process.argv[2] ?? 'http://localhost:4180/app.html';
const out = 'test-results/import';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
let failed = 0;
page.on('pageerror', (e) => errors.push(e.message));
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const ed = (fn, arg) => page.evaluate(([src, a]) => new Function('ed', 'a', `return (${src})(ed, a)`)(window.doodlehive.ed, a), [fn.toString(), arg]);
const isId = (v) => /^[0-9a-f]{32}$/.test(v ?? '');

// ---- Byte helpers ----
const u8 = (...v) => Buffer.from(v);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const f64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return b; };
const cat = (...b) => Buffer.concat(b.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'latin1'))));
const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** An 8-bit greyscale PNG from a pixel function. */
const png = (w, h, px) => {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = px(x, y);
  const chunk = (type, data) => { const td = cat(type, data), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return cat(u32(data.length), td, c); };
  return cat(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', cat(u32(w), u32(h), u8(8, 0, 0, 0, 0))), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
};
/** A stored (uncompressed) zip. */
const zip = (files) => {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name), c = crc(data);
    const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }, le16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    const local = cat(le32(0x04034b50), le16(20), le16(0), le16(0), le16(0), le16(0), le32(c), le32(data.length), le32(data.length), le16(n.length), le16(0), n, data);
    central.push(cat(le32(0x02014b50), le16(20), le16(20), le16(0), le16(0), le16(0), le16(0), le32(c), le32(data.length), le32(data.length), le16(n.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(off), n));
    parts.push(local); off += local.length;
  }
  const cd = cat(...central), le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }, le16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  return cat(...parts, cd, le32(0x06054b50), le16(0), le16(0), le16(files.length), le16(files.length), le32(cd.length), le32(off), le16(0));
};

// ---- Photoshop ----
const ustr = (s) => cat(u32(s.length + 1), Buffer.from(s + '\0', 'utf16le').swap16());
const key = (k) => (k.length === 4 ? cat(u32(0), k) : cat(u32(k.length), k));
const val = (v) => {
  if (v === true || v === false) return cat('bool', u8(v ? 1 : 0));
  if (typeof v === 'string') return cat('TEXT', ustr(v));
  if (typeof v === 'number') return cat('doub', f64(v));
  if (Array.isArray(v)) return cat('VlLs', u32(v.length), ...v.map(val));
  if (v.unit) return cat('UntF', v.unit, f64(v.v));
  if (v.enum) return cat('enum', key(v.enum[0]), key(v.enum[1]));
  return cat('Objc', desc(v));
};
const desc = (o) => {
  const keys = Object.keys(o).filter((k) => k !== '_class');
  return cat(ustr(''), key(o._class ?? 'null'), u32(keys.length), ...keys.map((k) => cat(key(k), val(o[k]))));
};
const prc = (v) => ({ unit: '#Prc', v }), pxl = (v) => ({ unit: '#Pxl', v }), ang = (v) => ({ unit: '#Ang', v });
const block = (type, data) => cat('8BIM', type, u32(data.length), data, Buffer.alloc((4 - (data.length & 3)) & 3));
const sample = (id, w, h, px, minor) => {
  const pix = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pix[y * w + x] = px(x, y);
  const body = cat(u8(id.length), id, Buffer.alloc((id.length + 1) & 1), Buffer.alloc(minor === 1 ? 10 : 264), i32(0), i32(0), i32(h), i32(w), i16(8), u8(0), pix);
  return cat(u32(body.length), body, Buffer.alloc((4 - (body.length & 3)) & 3));
};
const abr6 = cat(u16(6), u16(2),
  block('samp', cat(sample('tipA', 16, 16, (x, y) => (Math.abs(x - 7.5) < 2 || Math.abs(y - 7.5) < 2 ? 255 : 0), 2), sample('tipB', 8, 8, (x) => (x < 4 ? 255 : 0), 2))),
  block('patt', Buffer.alloc(12)),
  block('desc', cat(u32(16), desc({ Brsh: [
    { _class: 'brushPreset', 'Nm  ': 'Scatter Star', Spcn: prc(40), Brsh: { _class: 'sampledBrush', Dmtr: pxl(50), Angl: ang(90), sampledData: 'tipA' },
      useTipDynamics: true, szVr: { _class: 'null', jitter: prc(30), bVTy: { enum: ['bVTy', 'prsr'] } }, minimumDiameter: prc(20),
      useScatter: true, scatterDynamics: { _class: 'null', jitter: prc(50) }, 'Cnt ': 1,
      useTexture: true, textureDepth: prc(60), textureScale: prc(200),
      dualBrush: { _class: 'null', useDualBrush: true, Brsh: { _class: 'sampledBrush', Dmtr: pxl(25), sampledData: 'tipB' } },
      useColorDynamics: true, 'H   ': prc(20), Strt: prc(0), Brgh: prc(10) },
    { _class: 'brushPreset', 'Nm  ': 'Hard Round', Spcn: prc(10), Brsh: { _class: 'computedBrush', Dmtr: pxl(12), Hrdn: prc(100), Angl: ang(0), Rndn: prc(100) } },
  ] }))));
const rle = (w, h, px) => { // PackBits per scanline, scanline lengths first
  const rows = [];
  for (let y = 0; y < h; y++) { const r = []; for (let x = 0; x < w; x++) r.push(px(x, y)); let o = []; let i = 0; while (i < r.length) { let n = 1; while (i + n < r.length && r[i + n] === r[i] && n < 127) n++; o.push(257 - n, r[i]); i += n; } rows.push(Buffer.from(o)); }
  return cat(...rows.map((r) => i16(r.length)), ...rows);
};
const abr2 = cat(u16(2), u16(2),
  u16(1), (() => { const b = cat(i32(0), i16(25), i16(30), i16(100), i16(45), i16(50)); return cat(u32(b.length), b); })(),
  u16(2), (() => { const b = cat(i32(0), i16(30), ustr('Soft Blob'), u8(1), Buffer.alloc(8), i32(0), i32(0), i32(12), i32(20), i16(8), u8(1), rle(20, 12, () => 255)); return cat(u32(b.length), b); })());

// ---- Procreate: an NSKeyedArchiver binary plist ----
class UID { constructor(n) { this.n = n; } }
const bplist = (root) => {
  const objs = [];
  const add = (v) => { objs.push(v); return objs.length - 1; };
  const enc = (v, ref) => {
    const len = (m, n) => (n < 15 ? u8((m << 4) | n) : cat(u8((m << 4) | 15, 0x11), u16(n)));
    if (v === null) return u8(0);
    if (v === true || v === false) return u8(v ? 9 : 8);
    if (v instanceof UID) return u8(0x80, v.n);
    if (typeof v === 'number') return Number.isInteger(v) ? cat(u8(0x13), (() => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return b; })()) : cat(u8(0x23), f64(v));
    if (typeof v === 'string') return cat(len(5, v.length), v);
    if (Buffer.isBuffer(v)) return cat(len(4, v.length), v);
    if (Array.isArray(v)) return cat(len(0xa, v.length), ...v.map(ref));
    const keys = Object.keys(v);
    return cat(len(0xd, keys.length), ...keys.map(ref), ...keys.map((k) => ref(v[k])));
  };
  // Every value becomes its own object so refs are simple.
  const flat = (v) => { const i = add(null); objs[i] = v; return i; };
  const walk = (v) => { const i = flat(v); return i; };
  walk(root);
  const bodies = [], offsets = [];
  for (let i = 0; i < objs.length; i++) {
    const v = objs[i];
    const ref = (x) => u8(walk(x));
    bodies.push(enc(v, ref));
  }
  // Second pass: objects added during the first pass need encoding too.
  for (let i = bodies.length; i < objs.length; i++) bodies.push(enc(objs[i], (x) => u8(walk(x))));
  let off = 8;
  const body = [];
  for (const b of bodies) { offsets.push(off); body.push(b); off += b.length; }
  const table = cat(...offsets.map((o) => u16(o)));
  const trailer = cat(Buffer.alloc(6), u8(2, 1), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(objs.length)); return b; })(), Buffer.alloc(8), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(off)); return b; })());
  return cat('bplist00', ...body, table, trailer);
};
const archive = (brush) => bplist({ $version: 100000, $archiver: 'NSKeyedArchiver', $top: { root: new UID(1) }, $objects: ['$null', { ...brush, $class: new UID(2) }, { $classname: 'SilicaBrush', $classes: ['SilicaBrush', 'NSObject'] }] });
const ink = archive({ name: 'Wet Ink', paintSize: 0.3, plotSpacing: 0.04, paintOpacity: 0.8, shapeScatter: 0.25, grainDepth: 0.7, grainScale: 0.5, dynamicsJitterHue: 0.1, dynamicsPressureSize: 0.9, shapeInverted: false, bundledGrainPath: null });
const dots = archive({ paintSize: 0.2, plotSpacing: 0.25 });
const brushset = zip([
  ['brushset.plist', Buffer.from('<plist/>')],
  ['Inks/Brush.archive', ink], ['Inks/Shape.png', png(64, 64, (x, y) => (Math.hypot(x - 31.5, y - 31.5) < 28 ? 255 : 0))], ['Inks/Grain.png', png(64, 64, (x) => (x % 8 < 4 ? 255 : 40))],
  ['Dots/Brush.archive', dots], ['Dots/Shape.png', png(64, 64, (x, y) => (Math.hypot(x - 31.5, y - 31.5) < 28 ? 0 : 255))], // black dot on white: detected and flipped
  ['Dots/Sub01/Brush.archive', dots], ['Dots/Sub01/Shape.png', png(32, 32, (x) => (x < 16 ? 255 : 0))],
  ['Reset/Inks/Brush.archive', ink], ['Reset/Inks/Shape.png', png(8, 8, () => 255)],
]);
fs.writeFileSync(`${out}/sample.abr`, abr6); fs.writeFileSync(`${out}/old.abr`, abr2); fs.writeFileSync(`${out}/myset.brushset`, brushset);

// ---- Through the app ----
await page.goto(url);
await page.selectOption('#canvas-preset', 'square');
await page.getByText('Create canvas').click();
await page.locator('.topbar [aria-label^="Brush (B)"]').click();
await page.waitForSelector('.brush-library');
check(await page.locator('[aria-label^="Import brushes"]').count() === 1, 'library header has one Import button');
const file = page.locator('input.import-file');
const toast = async () => { await page.waitForFunction(() => /Added|brush/.test(document.querySelector('.toast')?.textContent ?? '') && !/Reading/.test(document.querySelector('.toast').textContent)); return page.locator('.toast').textContent(); };
const brushes = () => ed((e) => e.prefs.customBrushes.map((b) => ({ name: b.name, cat: b.cat, ...b.params })));

await file.setInputFiles({ name: 'sample.abr', mimeType: 'application/octet-stream', buffer: abr6 });
check((await toast()).includes('Added 2 brushes'), 'v6 .abr: two brushes added (' + await page.locator('.toast').textContent() + ')');
let list = await brushes();
const star = list.find((b) => b.name === 'Scatter Star'), round = list.find((b) => b.name === 'Hard Round');
check(!!star && isId(star.shape) && star.size === 50 && star.spacing === 0.4 && star.angle === 90, 'sampled brush: tip asset, size 50, spacing 40%, angle 90 ' + JSON.stringify(star));
check(star && star.scatter === 1 && star.sizeJitter === 0.3 && star.pressureSize === 1 && star.minSize === 0.2, 'scatter 50% → 1.0, size jitter, pressure size, min size');
check(star && star.hueJitter === 0.2 && star.brightJitter === 0.1 && star.satJitter === undefined, 'colour dynamics: hue and brightness, no saturation');
check(star && isId(star.dual) && star.dualScale === 0.5 && star.grain === 0.6 && star.grainScale === 2, 'dual tip at half size, texture depth 60% and scale 2');
check(star && star.cat === 'sample', 'brushes land in a category named after the file');
check(!!round && round.shape === undefined && round.size === 12 && round.hardness === 1 && round.spacing === 0.1, 'computed brush: round, size 12, hard, spacing 10% ' + JSON.stringify(round));
check(await page.getByRole('tab', { name: 'sample' }).getAttribute('aria-selected') === 'true', 'the new category is shown');

await file.setInputFiles({ name: 'old.abr', mimeType: 'application/octet-stream', buffer: abr2 });
check((await toast()).includes('Added 2'), 'v2 .abr: two brushes added');
list = await brushes();
const b1 = list.find((b) => b.name === 'Brush 1'), blob = list.find((b) => b.name === 'Soft Blob');
check(!!b1 && b1.size === 30 && b1.hardness === 0.5 && b1.spacing === 0.25 && b1.angle === 45, 'v2 computed: size, hardness, spacing, angle ' + JSON.stringify(b1));
check(!!blob && isId(blob.shape) && blob.size === 20 && blob.spacing === 0.3, 'v2 sampled: RLE tip became an asset, size from its width ' + JSON.stringify(blob));

await file.setInputFiles({ name: 'myset.brushset', mimeType: 'application/octet-stream', buffer: brushset });
check((await toast()).includes('Added 2'), 'Procreate set: Reset and Sub01 folders skipped, two brushes added');
list = await brushes();
const wet = list.find((b) => b.name === 'Wet Ink'), dot = list.find((b) => b.name === 'Dots');
check(!!wet && isId(wet.shape) && wet.size === 46 && wet.spacing === 0.2 && wet.opacity === 0.8 && wet.pressureSize === 0.9, 'Procreate: size, spacing √, opacity, pressure ' + JSON.stringify(wet));
check(wet && wet.scatter === 0.5 && wet.hueJitter === 0.1 && isId(wet.texture) && wet.grain === 0.7 && wet.grainScale === 1.75, 'Procreate: scatter, hue jitter, grain image with depth and scale');
check(!!dot && isId(dot.shape) && isId(dot.dual) && dot.cat === 'myset', 'unnamed brush takes its folder name, Sub01 becomes its dual tip ' + JSON.stringify(dot));

// The Dots tip was black on white; detected and flipped, so it paints a disc, not a frame.
const read = (x, y, w, h) => ed((e, r) => {
  const c = document.createElement('canvas'); c.width = r[2]; c.height = r[3];
  const g = c.getContext('2d'); g.translate(-r[0], -r[1]); e.layer.surface.drawTo(g, { x: r[0], y: r[1], w: r[2], h: r[3] });
  const d = g.getImageData(0, 0, r[2], r[3]).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 40) continue; const px = (i / 4) % r[2], py = Math.floor(i / 4 / r[2]); x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); n++; }
  return { x0, y0, x1, y1, n, fill: n / ((x1 - x0 + 1) * (y1 - y0 + 1)) };
}, [x, y, w, h]);
await page.keyboard.press('Escape');
await ed((e, b) => e.run([{ t: 'stroke', id: 'imp1', layer: e.activeLayer, erase: false, brush: { ...b, size: 60, dual: undefined, pressureSize: 0, scatter: 0 }, color: '#000000', pts: [300, 300, 1] }], 'stroke'), { ...dot, name: undefined, cat: undefined });
let r = await read(240, 240, 120, 120);
check(r.n > 1500 && r.fill > 0.6 && r.fill < 0.9, `flipped Procreate tip paints a disc (fill ${r.fill.toFixed(2)})`);
await ed((e) => e.undo());
await ed((e, b) => e.run([{ t: 'stroke', id: 'imp2', layer: e.activeLayer, erase: false, brush: { ...b, size: 60, pressureSize: 0 }, color: '#000000', pts: [300, 300, 1] }], 'stroke'), { ...blob, name: undefined, cat: undefined });
r = await read(240, 240, 120, 120);
check(r.x1 - r.x0 > (r.y1 - r.y0) * 1.4, `v2 RLE tip keeps its 20×12 shape (${r.x1 - r.x0 + 1}×${r.y1 - r.y0 + 1})`);
await ed((e) => e.undo());

// Bad files
await page.locator('.topbar [aria-label^="Brush (B)"]').click();
await page.waitForSelector('.brush-library');
await file.setInputFiles({ name: 'junk.abr', mimeType: 'application/octet-stream', buffer: Buffer.from('not a brush file at all') });
check((await toast()).includes('can’t be read'), 'junk: a clear message, nothing added');
await file.setInputFiles({ name: 'empty.brushset', mimeType: 'application/octet-stream', buffer: zip([['brushset.plist', Buffer.from('<plist/>')]]) });
check((await toast()).includes('No brushes'), 'a set with no brushes says so');
check((await brushes()).length === 6, 'six brushes imported in all');

// ---- No share code until the owner confirms the rights ----
const imported = () => ed((e) => e.prefs.customBrushes.filter((b) => b.imported).map((b) => b.name));
check((await imported()).length === 6, 'every imported brush is flagged');
await page.getByRole('tab', { name: 'sample' }).click();
const share = page.locator('.modal[aria-label="Share this brush?"]');
const copyCode = async (name) => {
  await page.locator('.brush-row', { hasText: name }).hover();
  await page.locator(`[aria-label="More for ${name}"]`).click();
  await page.locator('.brush-menu .menu-item', { hasText: 'Copy code' }).click();
};
await copyCode('Scatter Star');
await share.waitFor();
check((await share.locator('.btn.primary').textContent()) === 'I have the rights', 'Copy code on an imported brush asks about the rights first');
await share.locator('.btn', { hasText: 'Cancel' }).click();
check((await imported()).includes('Scatter Star') && !/copied|hive-/.test(await page.locator('.toast').textContent()), 'cancelling copies nothing and keeps the flag');
await copyCode('Scatter Star');
await share.locator('.btn.primary').click();
await page.waitForFunction(() => /copied|hive-/.test(document.querySelector('.toast')?.textContent ?? ''));
check(!(await imported()).includes('Scatter Star'), 'confirming hands out the code and clears the flag for good');
await copyCode('Scatter Star');
check(await share.count() === 0, 'the question is asked once per brush');
await page.locator('.brush-row', { hasText: 'Hard Round' }).hover();
await page.locator('[aria-label="More for Hard Round"]').click();
await page.locator('.brush-menu .menu-item', { hasText: 'Edit' }).click();
await page.waitForSelector('.brush-edit');
check(await page.locator('.brush-edit .brush-code').isHidden() && await page.locator('.brush-edit button', { hasText: 'Get a share code' }).isVisible(), 'the editor shows no code for an imported brush, only the share button');
await page.locator('.brush-edit button', { hasText: 'Get a share code' }).click();
await share.locator('.btn.primary').click();
check(await page.locator('.brush-edit .brush-code').isVisible() && (await page.locator('.brush-edit .brush-code').inputValue()).startsWith('hive-'), 'confirming there reveals the code');
await page.locator('.modal-actions .btn', { hasText: 'Cancel' }).click();
await page.getByRole('tab', { name: 'myset' }).click();
await page.locator('.brush-row', { hasText: 'Wet Ink' }).hover();
await page.locator('[aria-label="More for Wet Ink"]').click();
await page.locator('.brush-menu .menu-item', { hasText: 'Clone' }).click();
await page.waitForSelector('.brush-edit');
check(await page.locator('.brush-edit .brush-code').isHidden(), 'a clone of an imported brush is still imported');
await page.locator('.modal-actions .btn', { hasText: 'Cancel' }).click();

// Persistence
await page.waitForTimeout(700);
await page.reload();
await page.waitForSelector('#canvas-preset');
check((await brushes()).length === 6 && (await ed((e) => e.prefs.brushCategories)).join() === 'sample,old,myset' && (await imported()).length === 4, 'brushes, categories and the imported flags survive a reload');

await page.screenshot({ path: `${out}/library.png` });
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
