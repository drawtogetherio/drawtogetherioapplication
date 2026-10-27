// .hivecanvas and .hivelapse: export, open, compaction of heavy device logs, moving to the server as a file,
// timelapse recording and video. Needs `npm run dev` with DB_PATH set (pages come from Vite, so source
// modules can be imported in the page).
// Usage: DB_PATH=... node tests/hivecanvas.mjs [http://localhost:5173]
// HIVE_OPS=path/to/ops.jsonl also moves that real canvas log through the same steps.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const out = 'test-results/hivecanvas';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const admin = (args) => execSync(`npx tsx server/admin.ts ${args}`, { stdio: 'pipe', env: process.env }).toString();
// Reference logs are files Vite serves from the project folder; big ones don't fit through page.route.
const refs = { set: (name, text) => fs.writeFileSync(`${out}/${name}`, text), get: (name) => fs.readFileSync(`${out}/${name}`, 'utf8') };

async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|404)/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.goto(base + '/app');
  await page.waitForURL(/\/login/);
  const handle = name + Math.floor(Math.random() * 1e6);
  await page.fill('#dev-name', handle);
  await page.getByRole('button', { name: 'Dev login' }).click();
  await page.waitForSelector('#display-name');
  await page.fill('#display-name', name);
  await page.getByRole('button', { name: 'Start drawing' }).click();
  await page.waitForSelector('.home:not([hidden])');
  return [page, handle];
}

const dh = (page, fn, arg) => page.evaluate(([src, a]) => new Function('dh', 'a', `return (${src})(dh, a)`)(window.doodlehive, a), [fn.toString(), arg]);
async function stroke(page, y) {
  const box = await page.locator('canvas.stage').boundingBox();
  await page.mouse.move(box.x + 200, box.y + y); await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 200 + i * 12, box.y + y + Math.sin(i / 2) * 20);
  await page.mouse.up();
  await page.waitForTimeout(150);
}
const home = async (page) => {
  await page.locator('[aria-label="Menu"]').click(); await page.locator('.menu-pop .menu-item', { hasText: 'Back to home' }).click();
  await page.waitForSelector('.home:not([hidden])');
};

/** Pixels of the open canvas against the canvas rebuilt from a reference log: count of channel differences over 2. */
const compare = (page, ref) => page.evaluate(async (ref) => {
  const { DrawDoc } = await import('/src/core/document.ts');
  const { renderRegion } = await import('/src/engine/compositor.ts');
  const { rectUnion } = await import('/src/core/geom.ts');
  const text = await (await fetch('/test-results/hivecanvas/' + ref)).text();
  const cur = window.doodlehive.ed.doc;
  const doc = new DrawDoc({ ...cur.settings });
  for (const line of text.split('\n')) if (line) { const op = JSON.parse(line); await doc.prepare(op); doc.apply(op, { record: false }); }
  let r = null;
  for (const d of [doc, cur]) for (const l of d.layers) r = rectUnion(r, l.surface.tileBounds());
  if (!r) return { bad: 0, max: 0, px: 0 };
  let bad = 0, max = 0;
  const STEP = 1024;
  for (let y = r.y; y < r.y + r.h; y += STEP) for (let x = r.x; x < r.x + r.w; x += STEP) {
    const q = { x, y, w: Math.min(STEP, r.x + r.w - x), h: Math.min(STEP, r.y + r.h - y) };
    const a = renderRegion(doc, q, { paper: true }).getContext('2d').getImageData(0, 0, q.w, q.h).data;
    const b = renderRegion(cur, q, { paper: true }).getContext('2d').getImageData(0, 0, q.w, q.h).data;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d > 2) bad++; }
  }
  return { bad, max, px: r.w * r.h };
}, ref);

const localOps = (page, id) => page.evaluate(async (id) => (await (await import('/src/io/localStore.ts')).loadOps(id)).map((o) => JSON.stringify(o)).join('\n'), id);

// ---- A free account: draw, undo a lot, export a .hivecanvas, open it again ----
const [ren] = await person('Ren');
await ren.locator('.create-tile').click();
await ren.locator('.home-card', { hasText: 'Draw alone' }).click();
await ren.fill('#room-name', 'Hive study');
await ren.getByRole('button', { name: 'Create canvas' }).click();
await ren.waitForFunction(() => window.doodlehive.session.local && !window.doodlehive.ed.room);
await ren.mouse.move(400, 400);
for (let i = 0; i < 6; i++) await stroke(ren, 220 + i * 50);
for (let i = 0; i < 3; i++) { await ren.keyboard.press('Control+z'); await ren.waitForTimeout(100); }
await stroke(ren, 520);
const id = await dh(ren, (dh) => dh.session.local.meta.id);
await dh(ren, (dh) => dh.session.local.flush());
refs.set('ren.jsonl', await localOps(ren, id));
check((await dh(ren, (dh) => dh.ed.doc.log.filter((o) => o.t === 'tiles').length)) === 3, 'undos are in the log as tiles');

await ren.locator('[aria-label="Menu"]').click();
await ren.locator('.menu-pop .menu-item', { hasText: 'Export' }).click();
await ren.locator('.segmented button', { hasText: '.hivecanvas' }).click();
await ren.fill('input[aria-label="File name"]', 'hive study');
const [dl] = await Promise.all([ren.waitForEvent('download'), ren.locator('.modal').getByRole('button', { name: 'Export' }).click()]);
const hcPath = `${out}/hive study.hivecanvas`;
await dl.saveAs(hcPath);
check(dl.suggestedFilename() === 'hive study.hivecanvas', 'export saves a .hivecanvas');
const hc = fs.readFileSync(hcPath);
check(hc.subarray(0, 4).toString('hex') === '504b0304' && hc.includes('manifest.json') && hc.includes('tree.json') && hc.includes('layers/'), 'it is a zip with a manifest, tree and layer tiles');

// ---- Timelapse: recorded on the device while drawing ----
await dh(ren, async () => { const { lapse } = await import('/src/io/lapse.ts'); await lapse.flush(); });
const frames = await dh(ren, async (dh) => { const { loadLapse } = await import('/src/io/lapse.ts'); return (await loadLapse(dh.session.local.meta.id))?.frames.length ?? 0; });
check(frames >= 1, `the timelapse has frames (${frames})`);
await stroke(ren, 600);
await ren.locator('[aria-label="Menu"]').click();
await ren.locator('.menu-pop .menu-item', { hasText: 'Export' }).click();
await ren.locator('.modal').getByRole('button', { name: 'Timelapse…' }).click();
await ren.waitForSelector('.modal-head h2:text("Timelapse")');
check(await ren.locator('.modal-body', { hasText: 'never uploaded' }).isVisible(), 'the timelapse dialog says frames stay on the device');
await ren.screenshot({ path: `${out}/01-timelapse-dialog.png` });
const [lapseDl] = await Promise.all([ren.waitForEvent('download'), ren.locator('.modal').getByRole('button', { name: 'Save .hivelapse' }).click()]);
const hlPath = `${out}/hive study.hivelapse`;
await lapseDl.saveAs(hlPath);
check(lapseDl.suggestedFilename().endsWith('.hivelapse') && fs.readFileSync(hlPath).includes('frames/0/'), 'a .hivelapse saves with its frames');
const [vid] = await Promise.all([ren.waitForEvent('download', { timeout: 60_000 }), ren.locator('.modal').getByRole('button', { name: 'Save video' }).click()]);
await vid.saveAs(`${out}/${vid.suggestedFilename()}`);
const vsize = fs.statSync(`${out}/${vid.suggestedFilename()}`).size;
check(/-timelapse\.(mp4|webm)$/.test(vid.suggestedFilename()) && vsize > 5000, `the timelapse video is made on the device (${vid.suggestedFilename()}, ${vsize} bytes)`);
await ren.keyboard.press('Escape');
await ren.locator('.modal-overlay').evaluateAll((els) => els.forEach((e) => e.remove()));
await home(ren);

// Opening the file makes a new device canvas that looks the same.
await ren.locator('.create-tile').click();
const [chooser] = await Promise.all([ren.waitForEvent('filechooser'), ren.locator('.home-card', { hasText: 'Open a file' }).click()]);
await chooser.setFiles(hcPath);
await ren.waitForFunction((old) => window.doodlehive.session.local && window.doodlehive.session.local.meta.id !== old, id);
check((await dh(ren, (dh) => dh.session.local.meta.name)) === 'hive study', 'opening a .hivecanvas makes a device canvas with its name');
const opened = await compare(ren, 'ren.jsonl');
check(opened.bad === 0, `the opened canvas matches the original (max channel difference ${opened.max})`);
check((await dh(ren, (dh) => dh.ed.doc.log.some((o) => o.t === 'stroke'))) === false, 'it carries no undo history, only the picture');
await home(ren);

// Opening a .hivelapse shows its timelapse.
await ren.locator('.create-tile').click();
const [chooser2] = await Promise.all([ren.waitForEvent('filechooser'), ren.locator('.home-card', { hasText: 'Open a file' }).click()]);
await chooser2.setFiles(hlPath);
await ren.waitForSelector('.modal-head h2:text("Timelapse")');
check(await ren.locator('.modal-body', { hasText: 'frame' }).isVisible(), 'opening a .hivelapse shows its timelapse');
await ren.locator('.modal-overlay').evaluateAll((els) => els.forEach((e) => e.remove()));

// The server never takes a timelapse.
const lapseStatus = await ren.evaluate(async (b) => (await fetch('/api/rooms/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(b) })).status, [...fs.readFileSync(hlPath)]);
check(lapseStatus === 400 || lapseStatus === 403, `the server refuses a .hivelapse (${lapseStatus})`);

// ---- A heavy device log: compacted on open, and moved to the server as a .hivecanvas ----
const heavyOps = process.env.HIVE_OPS ? fs.readFileSync(process.env.HIVE_OPS, 'utf8') : null;
const seed = async (page, text, name) => page.evaluate(async ([text, name]) => {
  const { putCanvas, appendOps, newLocalId } = await import('/src/io/localStore.ts');
  const me = window.doodlehive.ed.me;
  const id = newLocalId(), now = Date.now();
  await putCanvas({ id, user: me.id, name, settings: { width: 2048, height: 2048, infinite: true, background: '#ffffff' }, share: { visibility: 'private', requireLogin: false, friendsCanJoin: true, approveJoins: false }, room: null, createdAt: now, updatedAt: now, thumb: null });
  const ops = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (let i = 0; i < ops.length; i += 500) await appendOps(id, ops.slice(i, i + 500), i);
  return id;
}, [text, name]);

const [pia, piaHandle] = await person('Pia');
if (heavyOps) {
  refs.set('heavy.jsonl', heavyOps);
  // Free first: opening rewrites the log as a snapshot.
  const hid = await pia.evaluate(async () => {
    const text = await (await fetch('/test-results/hivecanvas/heavy.jsonl')).text();
    const { putCanvas, appendOps, newLocalId } = await import('/src/io/localStore.ts');
    const me = window.doodlehive.ed.me, id = newLocalId(), now = Date.now();
    await putCanvas({ id, user: me.id, name: 'Heavy canvas', settings: { width: 2048, height: 2048, infinite: true, background: '#ffffff' }, share: { visibility: 'private', requireLogin: false, friendsCanJoin: true, approveJoins: false }, room: null, createdAt: now, updatedAt: now, thumb: null });
    const ops = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (let i = 0; i < ops.length; i += 500) await appendOps(id, ops.slice(i, i + 500), i);
    return id;
  });
  const before = (await localOps(pia, hid)).length;
  await pia.reload();
  await pia.waitForSelector('.home:not([hidden]) .project-tile');
  let t = Date.now();
  await pia.locator('.tile-open', { hasText: 'Heavy canvas' }).first().click();
  await pia.waitForFunction(() => window.doodlehive.session.local && window.doodlehive.ed.doc.layers.length > 0, null, { timeout: 300_000 });
  await dh(pia, (dh) => dh.session.local.flush());
  await pia.waitForTimeout(1000);
  const after = (await localOps(pia, hid)).length;
  check(after < before / 4, `opening compacts the device log (${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB, ${((Date.now() - t) / 1000).toFixed(0)} s)`);
  const c1 = await compare(pia, 'heavy.jsonl');
  check(c1.bad === 0, `the compacted canvas matches the full log (max channel difference ${c1.max}, ${c1.px} px)`);
  await home(pia);
  // Premium: the heavy canvas moves to the server as one small file.
  admin(`premium ${piaHandle} forever`);
  await pia.reload();
  await pia.waitForSelector('.home:not([hidden]) .project-tile');
  // Put the full log back, as it was on ren's device.
  await pia.evaluate(async ([id]) => {
    const text = await (await fetch('/test-results/hivecanvas/heavy.jsonl')).text();
    const { replaceOps } = await import('/src/io/localStore.ts');
    await replaceOps(id, text.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }, [hid]);
  await pia.evaluate(() => {
    const f = window.fetch;
    window.fetch = (url, init) => { if (String(url).includes('/api/rooms/import')) window.__upload = init.body.size; return f(url, init); };
  });
  t = Date.now();
  await pia.locator('.tile-open', { hasText: 'Heavy canvas' }).first().click();
  await pia.waitForFunction(() => window.doodlehive.ed.room?.status === 'open', null, { timeout: 300_000 });
  const upload = await pia.evaluate(() => window.__upload ?? 0);
  check(upload > 0 && upload < 48 * 1024 * 1024, `it moves to the server as a ${(upload / 1e6).toFixed(1)} MB .hivecanvas (${((Date.now() - t) / 1000).toFixed(0)} s)`);
  const c2 = await compare(pia, 'heavy.jsonl');
  check(c2.bad === 0, `the server canvas matches the full log (max channel difference ${c2.max})`);
  check(!(await pia.evaluate(async (id) => !!(await (await import('/src/io/localStore.ts')).getCanvas(id)), hid)), 'the device copy is gone after the move');
  await pia.screenshot({ path: `${out}/02-heavy-on-server.png` });
  await home(pia);
} else {
  admin(`premium ${piaHandle} forever`);
  await pia.reload();
  await pia.waitForSelector('.home:not([hidden])');
  const sid = await seed(pia, refs.get('ren.jsonl'), 'Moved canvas');
  await pia.reload();
  await pia.waitForSelector('.home:not([hidden]) .project-tile');
  await pia.locator('.tile-open', { hasText: 'Moved canvas' }).first().click();
  await pia.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
  const c = await compare(pia, 'ren.jsonl');
  check(c.bad === 0 && !(await pia.evaluate(async (id) => !!(await (await import('/src/io/localStore.ts')).getCanvas(id)), sid)), 'a device canvas moves to the server as a .hivecanvas and looks the same');
  await home(pia);
}

// Premium opening a .hivecanvas puts it on the server.
await pia.locator('.create-tile').click();
const [chooser3] = await Promise.all([pia.waitForEvent('filechooser'), pia.locator('.home-card', { hasText: 'Open a file' }).click()]);
await chooser3.setFiles(hcPath);
await pia.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
const c3 = await compare(pia, 'ren.jsonl');
check(c3.bad === 0 && !(await dh(pia, (dh) => dh.ed.room.info.ephemeral)), 'premium opens a .hivecanvas straight onto the server');

if (errors.length) { console.log('page errors:'); for (const e of errors) console.log('  ' + e); failed++; }
await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
