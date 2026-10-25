// Two-person room test: dev login, profile setup, shared room, permissions, live strokes, bubbles, chat, kick.
// Needs `npm run dev` (server with dev login on) running. Usage: node tests/room.mjs [http://localhost:5173/]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const url = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '') + '/app';
const out = 'test-results/room';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };

async function person(name, color, target = url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`${name} console: ${m.text()} ${m.location().url}`); });
  await page.goto(target);
  await page.waitForURL(/\/login/);
  await page.fill('#dev-name', name + Math.floor(Math.random() * 1e6));
  await page.getByRole('button', { name: 'Dev login' }).click();
  await page.waitForSelector('#display-name');
  await page.fill('#display-name', name + ' ✿');
  await page.locator('.gswatch').first().click();
  await page.fill('#fav-hex', color);
  await page.locator('.field-label', { hasText: 'Profile colour' }).click({ position: { x: 5, y: 5 } });
  await page.locator('.social-add').click();
  await page.locator('.social-choice[aria-label="Bluesky"]').click();
  await page.fill('#link-bluesky', name.toLowerCase() + '.bsky.social');
  await page.press('#link-bluesky', 'Enter');
  await page.waitForSelector('.social-chip');
  await page.screenshot({ path: `${out}/00-${name}-setup.png` });
  await page.getByRole('button', { name: 'Start drawing' }).click();
  return page;
}

const ed = (page, fn, arg) => page.evaluate(([src, a]) => new Function('ed', 'a', `return (${src})(ed, a)`)(window.doodlehive.ed, a), [fn.toString(), arg]);

async function stroke(page, pts, hold = 0) {
  const box = await page.locator('canvas.stage').boundingBox();
  await page.evaluate(async ([pts, box, hold]) => {
    const c = document.querySelector('canvas.stage');
    const fire = (type, p) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'pen', clientX: box.x + p[0], clientY: box.y + p[1], pressure: 0.7, buttons: type === 'pointerup' ? 0 : 1, bubbles: true,
    }));
    fire('pointerdown', pts[0]);
    for (const p of pts.slice(1)) { fire('pointermove', p); await new Promise((r) => setTimeout(r, 16)); }
    await new Promise((r) => setTimeout(r, hold));
    fire('pointerup', pts[pts.length - 1]);
  }, [pts, box, hold]);
}
const line = (x0, y0, x1, y1, n = 30) => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1)]);

// ---- Alice creates a room ----
const alice = await person('Alice', '#e8578a');
await alice.locator('.create-tile').click();
await alice.locator('.home-card', { hasText: 'Shared room' }).click();
await alice.fill('#room-name', 'Sketch night');
await alice.getByText('Unlimited').first().click().catch(() => {});
await alice.getByRole('button', { name: 'Create room' }).click();
await alice.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
const roomId = await ed(alice, (e) => e.room.id);
check(/^[a-z0-9]{8}$/.test(roomId), 'room created: ' + roomId);
await alice.screenshot({ path: `${out}/01-alice-room.png` });

// Make Alice premium with the admin tool (needs DB_PATH to match the running server's database).
const aliceHandle = await ed(alice, (e) => e.me.handle);
execSync(`npx tsx server/admin.ts premium ${aliceHandle} 30`, { stdio: 'ignore' });

// ---- Bob joins by invite link ----
const bob = await person('Bob', '#3fbf7f', `${url}?room=${roomId}`);
await bob.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
await alice.waitForFunction(() => window.doodlehive.ed.room.members.length === 2);
check(true, 'Bob joined; Alice sees 2 members');

const folders = await ed(alice, (e) => [...e.doc.nodes.values()].filter((n) => n.kind === 'folder' && n.props.user).map((n) => n.props.owner));
check(folders.length === 2, 'one user folder per member');
const bobLayer = await ed(bob, (e) => ({ id: e.activeLayer, parent: e.doc.layer(e.activeLayer)?.parent, me: e.room.you }));
check(bobLayer.parent === 'uf_' + bobLayer.me, 'Bob’s first layer lives in his folder');

// ---- Live strokes + bubble ----
const aliceLayer = await ed(alice, (e) => e.activeLayer);
const pending = stroke(alice, line(400, 300, 700, 420), 700);
await bob.waitForTimeout(500);
const liveCount = await ed(bob, (e) => e.view.remoteLive.size);
check(liveCount === 1, 'Bob sees Alice’s stroke while she draws');
const gaps = await ed(bob, (e) => {
  // What is on Bob's screen, not just in the buffer: columns without ink across the part drawn so far.
  const live = [...e.view.remoteLive.values()][0], b = live.buffer.contentBounds();
  if (!b) return -1;
  const vp = e.view.viewport, p0 = vp.toScreen(b.x, b.y), p1 = vp.toScreen(b.x + b.w, b.y + b.h), dpr = e.view.dpr;
  const x0 = Math.round(Math.min(p0.x, p1.x) * dpr) + 6, x1 = Math.round(Math.max(p0.x, p1.x) * dpr) - 6;
  const y0 = Math.round(Math.min(p0.y, p1.y) * dpr), y1 = Math.round(Math.max(p0.y, p1.y) * dpr);
  const d = e.view.canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data, w = x1 - x0, h = y1 - y0;
  let gaps = 0;
  for (let x = 0; x < w; x++) { let ink = false; for (let y = 0; y < h && !ink; y++) ink = d[(y * w + x) * 4] < 128; if (!ink) gaps++; }
  return gaps;
});
check(gaps === 0, `the live stroke is one continuous line (${gaps} empty columns)`);
await bob.screenshot({ path: `${out}/02-bob-sees-bubble.png` });
await pending;
await bob.waitForFunction((id) => window.doodlehive.ed.doc.layer(id)?.surface.size > 0, aliceLayer);
check(await ed(bob, (e) => e.view.remoteLive.size) === 0, 'live preview replaced by the real stroke');

// ---- Permissions ----
const canEdit = await ed(bob, (e, id) => e.canEdit(id), aliceLayer);
check(!canEdit, 'Bob cannot edit Alice’s layer');
const hostCan = await ed(alice, (e, id) => e.canEdit(id), bobLayer.id);
check(hostCan, 'Alice (owner) can edit Bob’s layer');
// Bob tries anyway via a raw op; server must reject it.

// ---- A refused edit is taken back locally, without a reconnect ----
await ed(alice, (e) => { e._status0 = e.room.status; });
await ed(bob, (e, id) => e.run([{ t: 'layer.props', id: 'op_test_reject', layer: id, props: { opacity: 0.5 } }], 'test'), aliceLayer);
await bob.waitForSelector('.toast:has-text("belongs to someone else")', { timeout: 4000 }).then(() => check(true, 'a refused edit shows its reason'), () => check(false, 'a refused edit shows its reason'));
await bob.waitForTimeout(300);
check(await ed(bob, (e, id) => e.doc.layer(id).props.opacity === 1 && e.room.status === 'open' && e.doc.history.done.length === 0, aliceLayer), 'the refused edit is rolled back without a reconnect');
await bob.waitForTimeout(600);
check(await ed(bob, (e, id) => e.doc.layer(id).props.opacity === 1 && e.room.status === 'open', aliceLayer), 'still in step a moment later');

// ---- Performance preferences: no live strokes, edits in batches ----
await ed(bob, (e) => { e.prefs.showLive = false; e.room.batchMs = 2000; });
const boundsBefore = JSON.stringify(await ed(bob, (e, id) => e.doc.layer(id).surface.contentBounds(), aliceLayer));
const pending2 = stroke(alice, line(400, 500, 700, 520), 600);
await bob.waitForTimeout(500);
check(await ed(bob, (e) => e.view.remoteLive.size) === 0, 'with live strokes off, Bob sees only the bubble');
await pending2;
await alice.waitForTimeout(300);
check(JSON.stringify(await ed(bob, (e, id) => e.doc.layer(id).surface.contentBounds(), aliceLayer)) === boundsBefore, 'the finished stroke waits for the batch window');
await bob.waitForFunction(([id, b0]) => JSON.stringify(window.doodlehive.ed.doc.layer(id).surface.contentBounds()) !== b0, [aliceLayer, boundsBefore], { timeout: 5000 }).then(() => check(true, 'and lands within the window'), () => check(false, 'and lands within the window'));
await ed(bob, (e) => { e.prefs.showLive = true; e.room.batchMs = 0; });
await bob.evaluate((id) => window.doodlehive.ed.room.send({ type: 'op', op: { t: 'layer.props', id: 'hack1', layer: id, props: { visible: false } } }), aliceLayer);
await alice.waitForTimeout(400);
check(await ed(alice, (e, id) => e.doc.layer(id).props.visible, aliceLayer), 'server rejects edits to someone else’s layer');

// ---- Undo syncs ----
await stroke(alice, line(400, 500, 700, 520));
await bob.waitForTimeout(300);
const before = await ed(bob, (e, id) => e.doc.log.length, aliceLayer);
await alice.keyboard.press('Control+z');
await bob.waitForFunction((n) => window.doodlehive.ed.doc.log.length > n, before);
check(true, 'Alice’s undo reached Bob');

// ---- Effects bar survives other people's strokes ----
await bob.locator('[aria-label="Effects"]').click();
await bob.locator('.effects-pop .menu-item', { hasText: 'Gaussian blur' }).click();
await bob.waitForSelector('.effect-bar');
await stroke(alice, line(400, 560, 700, 580));
await bob.waitForTimeout(400);
check(await bob.locator('.effect-bar').count() === 1, 'Bob’s effects bar stays open while Alice draws');
await bob.locator('.effect-bar [aria-label="Cancel"]').click();

// ---- Chat + typing ----
await alice.locator('canvas.stage').hover();
await alice.keyboard.press('Enter');
await alice.keyboard.type('hello bob', { delay: 30 });
await bob.waitForSelector('.chat-typing .dots', { timeout: 3000 }).then(() => check(true, 'typing indicator shows'), () => check(false, 'typing indicator shows'));
await bob.screenshot({ path: `${out}/03-bob-typing.png` });
await alice.keyboard.press('Enter');
await bob.waitForSelector('.chat-msg:has-text("hello bob")');
check(true, 'chat message delivered');
check(await alice.locator('.chat-form').isHidden(), 'chat closes once the message is sent');
check(await bob.locator('.chat-msg:has-text("hello bob") .chat-pic').count() === 1, 'the message carries Alice’s picture');

// ---- @mention with autofill, emoji shortcode, chime toast ----
await alice.locator('canvas.stage').hover();
await alice.keyboard.press('Enter');
await alice.keyboard.type('hey @bo', { delay: 30 });
await alice.waitForSelector('.chat-suggest:not([hidden]) .suggest-item.active:has-text("Bob")', { timeout: 3000 }).then(() => check(true, 'typing @bo suggests Bob'), () => check(false, 'typing @bo suggests Bob'));
await alice.keyboard.press('Enter');
check(await alice.locator('.chat-input').inputValue() === 'hey @Bob ✿ ', 'Enter fills in the display name');
await alice.keyboard.type('look :smi', { delay: 20 });
await alice.waitForSelector('.chat-suggest:not([hidden]) .suggest-item:has-text(":smile:")', { timeout: 2000 }).then(() => check(true, ':smi suggests :smile:'), () => check(false, ':smi suggests :smile:'));
await alice.keyboard.press('Escape');
check(!(await alice.locator('.chat-form').isHidden()) && await alice.locator('.chat-suggest').isHidden(), 'Escape closes only the suggestions');
await alice.keyboard.type('le:', { delay: 20 });
await alice.keyboard.press('Enter');
await bob.waitForSelector('.chat-msg.mentioned .mention:has-text("@Bob")', { timeout: 4000 }).then(() => check(true, 'Bob sees his name highlighted in his colour'), () => check(false, 'Bob sees his name highlighted in his colour'));
check((await bob.locator('.chat-msg.mentioned .chat-text').textContent()).includes('😄'), ':smile: became an emoji');
await bob.waitForSelector('.toast:has-text("mentioned you")', { timeout: 3000 }).then(() => check(true, 'Bob gets a mention toast'), () => check(false, 'Bob gets a mention toast'));
check(await alice.locator('.chat-msg.mentioned').count() === 0, 'Alice’s own message is not highlighted for her');
await bob.screenshot({ path: `${out}/03a-bob-mentioned.png` });

// ---- Friends from a chat picture; notifications in the menu ----
await bob.locator('.chat-msg:has-text("hello bob") .chat-pic').click();
await bob.waitForSelector('.modal .profile-card');
check(await bob.locator('.modal .btn', { hasText: 'Block' }).count() === 1, 'the picture opens the profile card with Block');
await bob.locator('.modal .btn', { hasText: 'Add friend' }).click();
await bob.waitForSelector('.toast:has-text("Friend request sent")', { timeout: 4000 }).then(() => check(true, 'Add friend sends a request'), () => check(false, 'Add friend sends a request'));
await bob.locator('.modal [title="Close"]').click();
await alice.waitForSelector('[aria-label="Menu"] .red-dot:not([hidden])', { timeout: 5000 }).then(() => check(true, 'Alice’s menu button shows a red dot'), () => check(false, 'Alice’s menu button shows a red dot'));
await alice.locator('[aria-label="Menu"]').click();
await alice.waitForTimeout(150);
await alice.screenshot({ path: `${out}/03b-alice-menu-dot.png` });
await alice.locator('.menu-bell').click();
await alice.waitForSelector('.modal .notice-row');
await alice.screenshot({ path: `${out}/03c-alice-notices.png` });
await alice.locator('.modal .notice-row .accept').click();
await bob.waitForFunction(async () => (await (await fetch('/api/friends')).json()).friends.length === 1, null, { timeout: 4000 })
  .then(() => check(true, 'accepting from the drawing menu makes them friends'), () => check(false, 'accepting from the drawing menu makes them friends'));
await alice.waitForFunction(() => document.querySelector('[aria-label="Menu"] .red-dot').hidden, null, { timeout: 4000 })
  .then(() => check(true, 'the red dot clears once read'), () => check(false, 'the red dot clears once read'));
await alice.locator('.modal [title="Close"]').click();

// ---- Blocking ----
const cara = await person('Cara', '#4f7cff', `${url}?room=${roomId}`);
await cara.waitForFunction(() => window.doodlehive.ed.room?.status === 'open');
// Enough happened before Cara joined (SNAPSHOT_EVERY=5) that her welcome carried a snapshot, not every stroke.
const caraLog = await ed(cara, (e) => e.doc.log.map((o) => o.t));
check(caraLog.includes('tiles') && caraLog.filter((t) => t === 'stroke').length <= 3, `joining replays a snapshot, not every stroke (${caraLog.join(' ')})`);
await cara.locator('canvas.stage').hover();
await cara.keyboard.press('Enter');
await cara.keyboard.type('hi from cara');
await cara.keyboard.press('Enter');
await alice.waitForSelector('.chat-msg:has-text("hi from cara")');
await alice.locator('.chat-msg:has-text("hi from cara") .chat-pic').click();
await alice.locator('.modal .btn.danger', { hasText: 'Block' }).click();
await alice.locator('.modal .btn.primary', { hasText: 'Block' }).click();
await alice.waitForSelector('.toast:has-text("is blocked")');
await alice.waitForTimeout(300);
check(await alice.locator('.chat-msg:has-text("hi from cara")').count() === 0, 'blocked person’s messages disappear');
check(await ed(alice, (e) => e.me.blocked.length) === 1, 'the profile remembers who is blocked');
await cara.waitForFunction(() => window.doodlehive.ed.room?.status !== 'open', null, { timeout: 4000 }).then(() => check(true, 'the blocked person is dropped from the host’s room'), () => check(false, 'the blocked person is dropped from the host’s room'));
await cara.goto(`${url}?room=${roomId}`);
await cara.waitForSelector('.toast:has-text("can’t join this room")', { timeout: 5000 }).then(() => check(true, 'and can’t rejoin'), () => check(false, 'and can’t rejoin'));
await alice.locator('.members-btn').click();
await alice.waitForSelector('.member-row');
check(await alice.locator('.member-row', { hasText: 'Cara' }).count() === 0, 'the member list hides them');
await alice.locator('.members-btn').click();
const caraId = await ed(cara, (e) => e.me.id);
await alice.evaluate((id) => fetch('/api/blocks/' + id, { method: 'DELETE' }), caraId);
await cara.goto(`${url}?room=${roomId}`);
await cara.waitForFunction(() => window.doodlehive.ed.room?.status === 'open', null, { timeout: 5000 }).then(() => check(true, 'unblocking lets them back in'), () => check(false, 'unblocking lets them back in'));
await cara.context().close();
await alice.waitForFunction(() => window.doodlehive.ed.room.members.length === 2);

// ---- Members panel, badges ----
await bob.locator('.members-btn').click();
await bob.waitForSelector('.member-row');
const crown = await bob.locator('.member-row', { hasText: 'Alice' }).locator('.badges svg').count();
check(crown === 3, 'premium owner shows crown, star and Early bee (' + crown + ')');
await bob.screenshot({ path: `${out}/04-members.png` });
await bob.keyboard.press('Escape');

// ---- Hide others' folders ----
await ed(bob, (e) => { e.settings.hideOthersFolders = true; e.emit('settings'); });
await bob.locator('[aria-label="Layers (L)"]').click();
await bob.waitForTimeout(200);
await bob.screenshot({ path: `${out}/05-bob-layers-hidden-others.png` });
const visibleFolders = await bob.locator('.folder-row').count();
check(visibleFolders === 1, 'hide-others shows only your own folder (' + visibleFolders + ')');
await ed(bob, (e) => { e.settings.hideOthersFolders = false; e.emit('settings'); });
await bob.waitForTimeout(200);
check(await bob.locator('.folder-row').count() === 3, 'all folders listed again (Cara’s stays)');
await alice.locator('[aria-label="Layers (L)"]').click();
await alice.waitForTimeout(200);
await alice.screenshot({ path: `${out}/06-alice-layers.png` });
check(await alice.locator('.layer-actions [aria-label="Delete layer"]').isVisible(), 'Delete layer is visible in the Layers panel');
await alice.locator('[aria-label="Layers (L)"]').click();

// ---- Edit log: the host removes one of Alice's strokes ----
await bob.locator('canvas.stage').hover();
await stroke(bob, line(200, 600, 500, 650));
await alice.waitForFunction((id) => window.doodlehive.ed.doc.layer(id)?.surface.size > 0, bobLayer.id);
check(await alice.locator('[aria-label="Edit log"]').count() === 1 && await bob.locator('[aria-label="Edit log"]').count() === 0, 'only hosts see the edit log button');
await alice.locator('[aria-label="Edit log"]').click();
await alice.waitForSelector('.edit-log');
await alice.screenshot({ path: `${out}/07-edit-log.png` });
await alice.locator('.log-person', { hasText: 'Bob' }).click();
const bobRows = await alice.locator('.log-row:has-text("Stroke")').count();
check(bobRows >= 1 && (await alice.locator('.log-row').count()) === (await alice.locator('.log-row:has-text("Stroke"), .log-row:has-text("Layer"), .log-row:has-text("Pixels")').count()), `Bob's edits are listed (${bobRows} strokes)`);
await alice.locator('.log-row:has-text("Stroke") .btn', { hasText: 'Remove' }).first().click();
await alice.locator('.modal .btn.primary', { hasText: 'Remove' }).click();
await alice.waitForSelector('.log-row.removed', { timeout: 20000 }).then(() => check(true, 'the stroke is removed'), () => check(false, 'the stroke is removed'));
await bob.waitForFunction((id) => !window.doodlehive.ed.doc.layer(id).surface.contentBounds(), bobLayer.id, { timeout: 5000 }).then(() => check(true, 'Bob’s layer is empty again for Bob too'), () => check(false, 'Bob’s layer is empty again for Bob too'));
check(await ed(alice, (e) => e.doc.history.done.at(-1)?.label === 'Remove edit'), 'the removal is one undoable edit for the host');
await alice.locator('.modal-head .icon-btn').click();

await alice.locator('[aria-label="Menu"]').click();
await alice.waitForTimeout(150);
await alice.screenshot({ path: `${out}/06b-alice-menu.png` });
await alice.locator('[aria-label="Menu"]').click();

// ---- Avatar upload is shrunk to a small square ----
const bigPng = await alice.screenshot({ fullPage: false });
await alice.locator('[aria-label="Menu"]').click();
await alice.getByRole('button', { name: 'Edit profile' }).click();
await alice.setInputFiles('#avatar-file', { name: 'big.png', mimeType: 'image/png', buffer: bigPng });
await alice.waitForSelector('.crop-stage');
await alice.locator('#crop-zoom').fill('1.6');
await alice.screenshot({ path: `${out}/07a-crop.png` });
await alice.getByRole('button', { name: 'Use picture' }).click();
await alice.waitForSelector('.avatar-edit img');
const av = await alice.evaluate(async () => {
  const src = document.querySelector('.avatar-edit img').src;
  const r = await fetch(src); const b = await r.blob();
  const bmp = await createImageBitmap(b);
  return { bytes: b.size, type: b.type, w: bmp.width, h: bmp.height };
});
check(av.w === 128 && av.h === 128 && av.bytes < 48 * 1024, `avatar stored small: ${av.w}x${av.h} ${av.type} ${(av.bytes / 1024).toFixed(1)}KB (upload was ${(bigPng.length / 1024).toFixed(0)}KB)`);
await alice.getByRole('button', { name: 'Save' }).click();
await bob.waitForFunction(() => !!window.doodlehive.ed.room.members.find((m) => m.displayName.startsWith('Alice'))?.avatar, null, { timeout: 4000 })
  .then(() => check(true, 'Bob sees Alice’s new picture'), () => check(false, 'Bob sees Alice’s new picture'));

// ---- Kick ----
await alice.locator('.members-btn').click();
await alice.locator('.member-row', { hasText: 'Bob' }).click();
await alice.locator('.modal .btn.danger', { hasText: 'Remove' }).click();
await alice.locator('.modal .btn.primary', { hasText: 'Remove' }).click();
await bob.waitForSelector('text=A host removed you', { timeout: 4000 }).then(() => check(true, 'Bob sees he was removed'), () => check(false, 'Bob sees he was removed'));
await alice.waitForFunction(() => window.doodlehive.ed.room.members.length === 1);
check(true, 'Alice’s member list updated');
await bob.screenshot({ path: `${out}/07-bob-kicked.png` });

// Rejoin is blocked for a while.
await bob.getByRole('button', { name: 'Back to start' }).click();
await bob.goto(`${url}?room=${roomId}`);
await bob.waitForTimeout(1500);
check(await ed(bob, (e) => e.room?.status !== 'open'), 'kicked user cannot rejoin right away');

console.log(errors.length ? 'Errors:\n' + errors.join('\n') : 'No page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
