// Profile dialog: premium section states, GIF pictures with a crop, banners, the merged colour/gradient picker. Needs the server with dev login.
// Usage: DB_PATH=... node tests/profile.mjs [http://localhost:8787]
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const out = 'test-results/profile';
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);
const call = (method, path, body, cookie) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const login = async (name) => { const r = await call('POST', '/auth/dev', { name }); const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; await call('PATCH', '/api/me', { done: true, displayName: name }, cookie); return { cookie, me: await r.json() }; };
const me = async (who) => (await call('GET', '/api/me', undefined, who.cookie)).json();
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); // 1 × 1 GIF

const ren = await login('Ren' + suffix), sam = await login('Sam' + suffix);
execSync(`npx tsx server/admin.ts premium ${ren.me.handle} 30`, { stdio: 'ignore' });
await call('POST', '/api/friends', { handle: ren.me.handle }, sam.cookie);
await call('POST', '/api/friends', { handle: sam.me.handle }, ren.cookie);

// The server refuses GIFs from free accounts whatever the client does.
let r = await fetch(`${base}/api/me/avatar-animated?x=0&y=0&w=1&h=1`, { method: 'PUT', headers: { Cookie: sam.cookie, Origin: base }, body: gif });
check(r.status === 403, 'a free account cannot upload a GIF picture');

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
const open = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'dw_session', value: who.cookie.split('=')[1], url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/app`);
  await page.waitForSelector('.me-pic');
  await page.locator('.me-pic').click();
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.waitForSelector('.profile-form');
  return page;
};

// ---- Free account ----
const samPage = await open(sam);
check(await samPage.locator('.premium-box.locked .premium-lock', { hasText: 'Link Patreon for these perks' }).count() === 1, 'without premium the perks are blurred behind a Patreon prompt');
check(await samPage.locator('.premium-lock a.btn', { hasText: 'Link Patreon' }).count() === 1 && await samPage.locator('.premium-lock a.btn', { hasText: 'See Patreon' }).count() === 1, 'with links to link Patreon and to the Patreon page');
check(await samPage.locator('#gradient-on').isDisabled(), 'the gradient toggle is locked');
await samPage.setInputFiles('#avatar-file', { name: 'a.gif', mimeType: 'image/gif', buffer: gif });
await samPage.waitForSelector('.field-error:has-text("GIF pictures are part of premium")');
check(true, 'a GIF is turned down with a message');
await samPage.locator('.modal').evaluate((el) => { el.scrollTop = el.scrollHeight; });
await samPage.screenshot({ path: `${out}/01-free.png` });
await samPage.keyboard.press('Escape');

// ---- Premium account: GIF picture with a crop ----
const renPage = await open(ren);
check(await renPage.locator('.premium-box:not(.locked) .perks li').count() === 5, 'premium shows its perks');
await renPage.setInputFiles('#avatar-file', { name: 'a.gif', mimeType: 'image/gif', buffer: gif });
await renPage.waitForSelector('.crop-stage');
await renPage.locator('#crop-zoom').fill('2');
await renPage.getByRole('button', { name: 'Use picture' }).click();
await renPage.waitForSelector('.avatar-edit img[src*="/anim"]');
let m = await me(ren);
check(m.avatarAnimated && m.avatar && m.avatarCrop && Math.abs(m.avatarCrop.w - 2) < 0.01, `a GIF is cropped on display and gets a still (${JSON.stringify(m.avatarCrop)})`);
check((await renPage.locator('.avatar-edit img').getAttribute('style')).includes('width:200%'), 'the dialog shows the cropped GIF');

// ---- Banner ----
const png = Buffer.from(await renPage.evaluate(async () => {
  const c = new OffscreenCanvas(600, 200), x = c.getContext('2d');
  x.fillStyle = '#2d7fd3'; x.fillRect(0, 0, 600, 200); x.fillStyle = '#f4c25b'; x.fillRect(0, 0, 300, 200);
  return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())];
}));
await renPage.setInputFiles('#banner-file', { name: 'b.png', mimeType: 'image/png', buffer: png });
await renPage.waitForSelector('.modal[aria-label="Crop your banner"] .crop-stage');
const stage = await renPage.locator('.crop-stage').boundingBox();
check(Math.abs(stage.width / stage.height - 3) < 0.05, 'the banner crop window is 3:1');
await renPage.getByRole('button', { name: 'Use picture' }).click();
await renPage.waitForSelector('.banner-edit.has-banner');
m = await me(ren);
r = await fetch(base + m.banner);
check(r.ok && r.headers.get('content-type').startsWith('image/'), 'the banner is stored and served');

// ---- Colour and gradient in one picker ----
check(await renPage.locator('.swatch-pop').isHidden() && await renPage.locator('.gswatch:visible').count() === 1, 'one colour swatch under the name, picker closed');
await renPage.locator('#gradient-on').check();
await renPage.locator('.gswatch[aria-label="Gradient end"]').click();
await renPage.waitForSelector('.swatch-pop:not([hidden]) #fav-hex');
await renPage.fill('#fav-hex', '#00ff00');
check((await renPage.locator('.gswatch[aria-label="Gradient end"]').getAttribute('style')).includes('rgb(0, 255, 0)'), 'the pop-up picker edits the chosen gradient end');
check(await renPage.locator('.name-preview.gradient-name').innerText() === 'Ren' + suffix, 'with the name previewed in the gradient');
await renPage.locator('.name-preview').click();
check(await renPage.locator('.swatch-pop').isHidden(), 'clicking elsewhere closes the picker');
await renPage.screenshot({ path: `${out}/02-premium.png` });
check(await renPage.locator('#handle').evaluate((el) => el.readOnly) && await renPage.locator('.handle-state').innerText() === '', 'the handle is locked and says nothing');
await renPage.locator('[aria-label="Change handle"]').click();
check(!(await renPage.locator('#handle').evaluate((el) => el.readOnly)), 'the pencil unlocks it');
await renPage.getByRole('button', { name: 'Save', exact: true }).click();
await renPage.waitForSelector('.profile-form', { state: 'detached' });
m = await me(ren);
check(m.gradient?.[1] === '#00ff00', 'saving keeps the gradient');

// ---- The card ----
await renPage.waitForSelector('.me-card.has-banner');
check((await renPage.locator('.me-card').getAttribute('style')).includes('--banner:url('), 'the home card shows the banner');
await samPage.goto(`${base}/app`);
await samPage.locator('.friends-list .friend-row', { hasText: 'Ren' }).click();
await samPage.waitForSelector('.profile-card .profile-banner');
check(await samPage.locator('.profile-card-head.under-banner .avatar img[src*="/anim"]').count() === 1, 'a friend’s card shows the banner with the GIF over it');
await samPage.screenshot({ path: `${out}/03-card.png` });
await samPage.keyboard.press('Escape');

// ---- A still replaces the GIF; removing the picture drops both ----
await renPage.goto(`${base}/app`);
await renPage.locator('.me-pic').click();
await renPage.getByRole('button', { name: 'Edit profile' }).click();
check(await renPage.locator('.avatar-edit .pic-overlay').count() === 1 && await renPage.locator('.banner-edit .pic-overlay').count() === 1, 'picture and banner upload from a hover overlay');
await renPage.setInputFiles('#avatar-file', { name: 'b.png', mimeType: 'image/png', buffer: png });
await renPage.waitForSelector('.crop-stage');
await renPage.getByRole('button', { name: 'Use picture' }).click();
await renPage.waitForSelector('.avatar-edit img:not([src*="/anim"])');
m = await me(ren);
check(m.avatar && !m.avatarAnimated, 'a still picture replaces a GIF one');
await renPage.getByRole('button', { name: 'Remove picture' }).click();
await renPage.waitForSelector('.avatar-edit .avatar:not(:has(img))');
m = await me(ren);
check(!m.avatar && !m.avatarAnimated, 'Remove clears the still and the GIF');
await browser.close();
check(!errors.length, 'no page errors ' + errors.join(' | '));

if (failed) process.exit(1);
console.log('all passed');
