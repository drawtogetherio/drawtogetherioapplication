// iPad push notifications against a mock APNs: device registration, friend requests and invites as pushes,
// the signed token, dead tokens dropped; then the app page with the native plugins faked: asking,
// registering, the badge, opening a tapped invite, forgetting the device on log out.
// Starts its own server on :8796 (serving dist/, so run `npm run build` first) with a throwaway database.
// Usage: node tests/push.mjs
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Mock APNs (HTTP/2 without TLS) ----
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pushes = [];
const gone = new Set();
const apns = http2.createServer();
apns.on('stream', (stream, headers) => {
  let body = '';
  stream.setEncoding('utf8');
  stream.on('data', (c) => { body += c; });
  stream.on('end', () => {
    const token = headers[':path'].replace('/3/device/', '');
    const [h, c, sig] = String(headers.authorization).replace('bearer ', '').split('.');
    const signed = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig ?? '', 'base64url'));
    pushes.push({ token, headers, payload: JSON.parse(body), signed, claims: JSON.parse(Buffer.from(c, 'base64url')), head: JSON.parse(Buffer.from(h, 'base64url')) });
    const status = gone.has(token) ? 410 : 200;
    stream.respond({ ':status': status });
    stream.end(status === 200 ? '' : JSON.stringify({ reason: 'Unregistered' }));
  });
});
await new Promise((r) => apns.listen(8797, r));

// ---- Server ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-push-'));
const base = 'http://localhost:8796';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: {
    ...process.env, PORT: '8796', DB_PATH: path.join(dir, 'db.sqlite'), DEV_LOGIN: '1', PUBLIC_URL: base,
    APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'), APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM456', APNS_HOST: 'http://127.0.0.1:8797',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/config'); break; } catch { await wait(250); } }

const suffix = Math.floor(Math.random() * 1e6);
const call = (method, p, body, cookie) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const login = async (name) => { const r = await call('POST', '/auth/dev', { name }); const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; await call('PATCH', '/api/me', { done: true }, cookie); return { cookie, me: await r.json() }; };
const until = async (n) => { for (let i = 0; i < 40 && pushes.length < n; i++) await wait(50); return pushes.length >= n; };

try {
  check((await (await call('GET', '/api/config')).json()).push === true, 'the server says push is on');
  const ida = await login('Ida' + suffix), noor = await login('Noor' + suffix);
  const tokenA = 'a1'.repeat(32), tokenB = 'b2'.repeat(32);

  check((await call('POST', '/api/me/devices', { token: 'not-hex' }, noor.cookie)).status === 400, 'a malformed token is refused');
  check((await call('POST', '/api/me/devices', { token: tokenA }, '')).status === 401, 'registering needs a login');
  check((await call('POST', '/api/me/devices', { token: tokenA, env: 'sandbox' }, noor.cookie)).ok, 'Noor registers her iPad');

  // Friend request
  await call('POST', '/api/friends', { handle: 'Ida' + suffix }, noor.cookie); // Ida has no iPad yet: nothing sent
  await call('POST', '/api/me/devices', { token: tokenB, env: 'production' }, ida.cookie);
  await call('DELETE', '/api/friends/' + noor.me.id, undefined, ida.cookie);
  await wait(200);
  pushes.length = 0;
  await call('POST', '/api/friends', { handle: 'Ida' + suffix }, noor.cookie);
  check(await until(1), 'a friend request is pushed');
  let p = pushes[0];
  check(p?.token === tokenB, 'to the receiver\'s device only');
  check(p?.payload.aps.alert.body === `Noor${suffix} sent you a friend request`, 'with the notice text');
  check(p?.payload.kind === 'friend' && p.payload.aps.badge >= 1, 'with its kind and the unread count as the badge');
  check(p?.headers['apns-topic'] === 'net.doodlehive.app' && p.headers['apns-push-type'] === 'alert' && p.headers['apns-collapse-id'] === 'friend-' + noor.me.id, 'topic, push type and collapse id are set');
  check(p?.signed && p.head.alg === 'ES256' && p.head.kid === 'KEY123' && p.claims.iss === 'TEAM456', 'the bearer token is signed with the .p8 key');

  // Accepted, then an invite
  pushes.length = 0;
  await call('POST', `/api/friends/${noor.me.id}/accept`, undefined, ida.cookie);
  check(await until(1) && pushes[0].token === tokenA && pushes[0].payload.kind === 'friend-accepted', 'the sender hears it was accepted');
  const room = await (await call('POST', '/api/rooms', { name: 'Studio', settings: { infinite: true }, share: { visibility: 'open', requireLogin: false, friendsCanJoin: true, approveJoins: false } }, ida.cookie)).json();
  pushes.length = 0;
  await call('POST', `/api/rooms/${room.id}/invite`, { user: noor.me.id }, ida.cookie);
  check(await until(1), 'an invite is pushed');
  p = pushes[0];
  check(p?.payload.kind === 'invite' && p.payload.room === room.id && p.payload.aps.alert.body.includes('invited you to Studio'), 'it carries the room to open');

  // Reading clears the badge count for the next push
  await call('POST', '/api/notices/read', undefined, noor.cookie);
  pushes.length = 0;
  await call('POST', `/api/rooms/${room.id}/invite`, { user: noor.me.id }, ida.cookie);
  check(await until(1) && pushes[0].payload.aps.badge === 1, 'the badge counts only unread notices');

  // A token Apple no longer knows is dropped
  gone.add(tokenA);
  pushes.length = 0;
  await call('POST', `/api/rooms/${room.id}/invite`, { user: noor.me.id }, ida.cookie);
  await until(1);
  gone.delete(tokenA);
  pushes.length = 0;
  await call('POST', `/api/rooms/${room.id}/invite`, { user: noor.me.id }, ida.cookie);
  await wait(400);
  check(pushes.length === 0, 'after a 410 the device gets nothing more');

  // The same iPad moves to whoever logs in on it; removing it stops pushes
  await call('POST', '/api/me/devices', { token: tokenA, env: 'sandbox' }, noor.cookie);
  await call('POST', '/api/me/devices', { token: tokenA, env: 'sandbox' }, ida.cookie);
  pushes.length = 0;
  await call('POST', `/api/rooms/${room.id}/invite`, { user: noor.me.id }, ida.cookie);
  await wait(400);
  check(pushes.length === 0, 'a token re-registered by another account stops reaching the first');
  await call('DELETE', '/api/me/devices/' + tokenB, undefined, ida.cookie);
  await call('DELETE', '/api/me/devices/' + tokenA, undefined, ida.cookie);
  pushes.length = 0;
  await call('DELETE', '/api/friends/' + noor.me.id, undefined, ida.cookie);
  await call('POST', '/api/friends', { handle: 'Ida' + suffix }, noor.cookie);
  await wait(400);
  check(pushes.length === 0, 'after removing its devices an account gets no pushes');

  // ---- The app page, as the iPad app runs it ----
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const plugin = (extra) => ({ listeners: {}, addListener(event, cb) { (this.listeners[event] ??= []).push(cb); return { remove() {} }; }, ...extra });
      window.__log = [];
      const push = plugin({
        checkPermissions: async () => ({ receive: 'prompt' }),
        requestPermissions: async () => { window.__log.push('asked'); return { receive: 'granted' }; },
        register: async () => { setTimeout(() => push.listeners.registration?.forEach((cb) => cb({ value: 'c3'.repeat(32) })), 10); },
        removeAllDeliveredNotifications: async () => { window.__log.push('cleared'); },
      });
      window.Capacitor = { isNativePlatform: () => true, Plugins: {
        PushNotifications: push,
        Doodlehive: plugin({ info: async () => ({ apns: 'sandbox', pencilOnly: false, hoverPreview: true, squeeze: false }), setBadge: async (o) => { window.__log.push('badge ' + o.count); } }),
      } };
      window.__tap = (data) => push.listeners.pushNotificationActionPerformed?.forEach((cb) => cb({ actionId: 'tap', notification: { data } }));
    });
    await page.goto(base + '/app');
    await page.waitForURL(/\/login/);
    await page.fill('#dev-name', 'Ida' + suffix);
    await page.getByRole('button', { name: 'Dev login' }).click();
    await page.waitForSelector('.home:not([hidden])');
    await page.waitForFunction(() => window.__log.includes('asked'), null, { timeout: 5000 }).catch(() => {});
    check(await page.evaluate(() => window.__log.includes('asked')), 'the app asks for notification permission after login');
    await call('DELETE', '/api/friends/' + noor.me.id, undefined, ida.cookie);
    await wait(300);
    pushes.length = 0;
    await call('POST', '/api/friends', { handle: 'Ida' + suffix }, noor.cookie);
    check(await until(1) && pushes[0].token === 'c3'.repeat(32) && pushes[0].payload.kind === 'friend', 'it registers its token, and pushes reach it');
    await page.waitForFunction(() => window.__log.some((l) => /^badge [1-9]/.test(l)), null, { timeout: 5000 }).catch(() => {});
    check(await page.evaluate(() => window.__log.some((l) => /^badge [1-9]/.test(l))), 'the app badge follows the unread count');
    await page.locator('.bell-btn').click();
    await page.waitForFunction(() => window.__log.includes('badge 0') && window.__log.includes('cleared'), null, { timeout: 5000 }).catch(() => {});
    check(await page.evaluate(() => window.__log.includes('badge 0') && window.__log.includes('cleared')), 'opening the bell clears the badge and the delivered pushes');
    await page.locator('.bell-btn').click();
    await page.evaluate((id) => window.__tap({ kind: 'invite', room: id }), room.id);
    await page.waitForFunction((id) => window.doodlehive.ed.room?.id === id, room.id, { timeout: 8000 })
      .then(() => check(true, 'tapping an invite push opens the room'), () => check(false, 'tapping an invite push opens the room'));
    await page.evaluate(() => window.doodlehive.session.logout('/login'));
    await page.waitForURL(/\/login/);
    pushes.length = 0;
    await call('DELETE', '/api/friends/' + noor.me.id, undefined, ida.cookie);
    await call('POST', '/api/friends', { handle: 'Ida' + suffix }, noor.cookie);
    await wait(400);
    check(pushes.length === 0, 'logging out forgets the device');
    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally { await browser.close(); }
} finally {
  server.kill();
  apns.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
