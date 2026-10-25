// Pictures on R2, against a mock R2 that checks every request's signature. Starts its own servers.
// Usage: node tests/media.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const PORT = 8796, R2 = 8797, base = `http://localhost:${PORT}`, media = `http://localhost:${R2}/pub`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png2 = Buffer.concat([png, Buffer.from([0])]);

// The mock: S3-style PUT/DELETE under /media/ (signed), public GET under /pub/.
const objects = new Map();
let badSig = 0;
const hex = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
function verify(req, body) {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=test-key\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([\w;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  const [, day, signed, sig] = m;
  if (crypto.createHash('sha256').update(body).digest('hex') !== req.headers['x-amz-content-sha256']) return false;
  const names = signed.split(';');
  const canonical = [req.method, req.url, '', ...names.map((n) => `${n}:${req.headers[n]}`), '', signed, req.headers['x-amz-content-sha256']].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${day}/auto/s3/aws4_request`, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = ['auto', 's3', 'aws4_request'].reduce((k, p) => hex(k, p), hex('AWS4test-secret', day));
  return names.includes('host') && crypto.createHmac('sha256', key).update(toSign).digest('hex') === sig;
}
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url.startsWith('/pub/')) {
      const o = objects.get(req.url.slice(5));
      if (!o) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': o.type, 'Cache-Control': o.cache }); return res.end(o.body);
    }
    if (!req.url.startsWith('/media/')) { res.writeHead(404); return res.end(); }
    if (!verify(req, body)) { badSig++; res.writeHead(403); return res.end('SignatureDoesNotMatch'); }
    const key = decodeURIComponent(req.url.slice(7));
    if (req.method === 'PUT') objects.set(key, { body, type: req.headers['content-type'], cache: req.headers['cache-control'] });
    else if (req.method === 'DELETE') objects.delete(key);
    res.writeHead(200); res.end();
  });
});
await new Promise((r) => mock.listen(R2, r));

const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dh-media-')), 'test.db');
const r2env = { R2_ENDPOINT: `http://localhost:${R2}`, R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret', R2_MEDIA_BUCKET: 'media', MEDIA_URL: media };
async function start(env) {
  const p = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT), DB_PATH: db, DEV_LOGIN: '1', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes('Pages in'); i++) await new Promise((r) => setTimeout(r, 100));
  return { stop: () => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); }), log: () => log };
}
const call = (method, p, body, cookie, raw) => fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
const login = async (name) => { const r = await call('POST', '/auth/dev', { name }); const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; await call('PATCH', '/api/me', { done: true }, cookie); return { cookie, me: await r.json() }; };
const me = async (who) => (await call('GET', '/api/me', undefined, who.cookie)).json();

// 1. Without R2 the picture goes in the database, as before.
let srv = await start({});
const ren = await login('Ren' + Math.floor(Math.random() * 1e6));
await call('PUT', '/api/me/banner', undefined, ren.cookie, png);
let m = await me(ren);
check(m.banner?.startsWith('/avatars/'), 'without R2, a banner is served by the server');
await srv.stop();

// 2. With R2, old pictures move over at startup and new ones go straight there.
srv = await start(r2env);
check(srv.log().includes('Pictures: R2 bucket media'), 'the startup log names the bucket');
for (let i = 0; i < 50 && objects.size === 0; i++) await new Promise((r) => setTimeout(r, 100));
m = await me(ren);
check(m.banner?.startsWith(media + '/u/'), `the banner already in the database moved to R2 (${m.banner})`);
let r = await fetch(m.banner);
check(r.ok && Buffer.from(await r.arrayBuffer()).equals(png) && r.headers.get('content-type') === 'image/png', 'R2 holds the same bytes with the right type');
check(r.headers.get('cache-control')?.includes('immutable'), 'objects are cached for good');
r = await call('GET', `/avatars/${ren.me.id}/banner`, undefined, ren.cookie);
check(r.status === 301 && r.headers.get('location') === m.banner, 'the old banner link redirects to R2');

r = await call('PUT', '/api/me/avatar', undefined, ren.cookie, png);
const first = (await r.json()).avatar;
check(first?.startsWith(media + '/u/') && objects.size === 2, 'a new picture is uploaded to R2');
r = await call('PUT', '/api/me/avatar', undefined, ren.cookie, png2);
const second = (await r.json()).avatar;
await new Promise((r) => setTimeout(r, 200));
check(second !== first && objects.size === 2 && !objects.has(first.slice(media.length + 1)), 'replacing a picture gets a new URL and removes the old one');
await call('DELETE', '/api/me/banner', undefined, ren.cookie);
await new Promise((r) => setTimeout(r, 200));
m = await me(ren);
check(m.banner === null && objects.size === 1, 'removing the banner removes it from R2');
const csp = r.headers.get('content-security-policy') ?? (await call('GET', '/api/me', undefined, ren.cookie)).headers.get('content-security-policy');
check(csp.includes(`img-src 'self' data: blob: http://localhost:${R2}`), 'the page may load images from the media host');
check(badSig === 0, 'every request to R2 was signed correctly');
await srv.stop();

// 3. A beta on a copy of the data never deletes the live site's pictures.
srv = await start({ ...r2env, BETA: '1' });
await call('PUT', '/api/me/avatar', undefined, ren.cookie, png);
await new Promise((r) => setTimeout(r, 200));
m = await me(ren);
check(m.avatar.startsWith(media + '/beta/u/') && objects.has(second.slice(media.length + 1)), 'beta writes under beta/ and leaves the live picture alone');
await srv.stop();

mock.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
