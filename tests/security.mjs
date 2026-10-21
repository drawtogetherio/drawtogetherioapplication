// Server hardening: cross-site requests, rate limits, headers, path traversal, op validation.
// Needs the API server with dev login on. Usage: node tests/security.mjs [http://localhost:8787]
import WebSocket from 'ws';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---- Cross-site writes are refused ----
let r = await post('/auth/guest', { name: 'Evil' }, { Origin: 'https://evil.example' });
check(r.status === 403, 'cross-site POST is blocked');
r = await post('/auth/guest', { name: 'Evil' }, { 'Sec-Fetch-Site': 'cross-site' });
check(r.status === 403, 'cross-site fetch metadata is blocked');

// ---- Headers ----
r = await fetch(base + '/api/config');
check(r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY', 'nosniff and no framing');
check((r.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), 'content security policy');
r = await fetch(base + '/app');
check(r.headers.get('content-security-policy') !== null && r.headers.get('referrer-policy') === 'same-origin', 'pages get the headers too');

// ---- Static files stay inside dist ----
r = await fetch(base + '/%2e%2e/package.json');
check(!(await r.text()).includes('"scripts"'), 'no path traversal');
r = await fetch(base + '/assets/');
check(r.status === 404 && (await r.text()).includes('Not found · Doodlehive'), 'directories and unknown paths get the 404 page');
r = await fetch(base + '/app/anything');
check(r.status === 200, 'app sub-paths still load the app');

// ---- Private rooms read as missing ----
const login = async (name) => ((await post('/auth/dev', { name: name + suffix }, { Origin: base })).headers.get('set-cookie') ?? '').split(';')[0];
const owner = await login('Owner'), other = await login('Other');
const secret = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner, Origin: base }, body: JSON.stringify({ name: 'Secret', settings: { infinite: true }, share: { visibility: 'private' } }) })).json();
r = await fetch(base + `/app?room=${secret.id}`, { headers: { Cookie: other } });
check(r.status === 404 && (await r.text()).includes('Not found · Doodlehive'), 'a private room is a 404 page for others');
r = await fetch(base + `/app?room=${secret.id}`, { headers: { Cookie: owner } });
check(r.status === 200, 'and the app for its owner');
r = await fetch(base + '/app?room=nope');
check(r.status === 404, 'an unknown room is a 404 page');
r = await fetch(base + '/admin', { headers: { Cookie: other } });
check(r.status === 404 && (await r.text()).includes('Not found · Doodlehive'), 'so is /admin for anyone who isn’t one');

// ---- Log in ----
r = await post('/auth/dev', { name: 'Sec' + suffix });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
check(r.ok && cookie.startsWith('dw_session='), 'dev login');
const auth = { Cookie: cookie, Origin: base };
const api = (method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- Rate limit ----
let last = 0;
for (let i = 0; i < 125; i++) last = (await fetch(base + '/api/handle/check?h=abc', { headers: auth })).status;
check(last === 429, 'handle checks are rate limited');

// ---- Room ops are validated before anything else ----
const room = await (await api('POST', '/api/rooms', { name: 'Sec', settings: { infinite: true }, share: { visibility: 'open' } })).json();
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${room.id}`, { headers: { Cookie: cookie, Origin: base } });
const messages = [];
const next = (type, pred = () => true) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), 5000);
  const look = () => { const i = messages.findIndex((m) => m.type === type && pred(m)); if (i >= 0) { clearTimeout(t); res(messages.splice(i, 1)[0]); return true; } return false; };
  if (!look()) ws.on('message', function h() { if (look()) ws.off('message', h); });
});
ws.on('message', (d) => messages.push(JSON.parse(String(d))));
await new Promise((res) => ws.on('open', res));
const welcome = await next('welcome');
const folder = welcome.ops.find((o) => o.t === 'folder.add' && o.folder.owner === welcome.you).folder.id;
const brush = { size: 10, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: 1, pressureFlow: 0, minSize: 0.1, smoothing: 0.3 };

ws.send(JSON.stringify({ type: 'op', op: { t: 'layer.add', id: 'op1', parent: folder, index: 0, layer: { id: 'ly1', name: 'L', visible: true, opacity: 1, blend: 'normal', alphaLock: false } } }));
ws.send(JSON.stringify({ type: 'op', op: { t: 'stroke', id: 'op2', layer: 'ly1', erase: false, brush: { ...brush, size: 1e9 }, color: '#000000', pts: [0, 0, 1] } }));
let rej = await next('reject');
check(rej.opId === 'op2' && rej.reason === 'Unknown edit', 'absurd brush size is refused');

ws.send(JSON.stringify({ type: 'op', op: { t: 'layer.props', id: 'op3', layer: 'ly1', props: { owner: 'someone-else' } } }));
rej = await next('reject');
check(rej.opId === 'op3', 'layer owner can’t be changed through props');

ws.send(JSON.stringify({ type: 'op', op: { t: 'fill', id: 'op4', layer: 'ly1', x: 0, y: 0, color: '#ff0000', tolerance: 0.1, sampleAll: true, expand: 1, region: { x: 0, y: 0, w: 100000, h: 100000 } } }));
rej = await next('reject');
check(rej.opId === 'op4', 'giant fill region is refused');

ws.send(JSON.stringify({ type: 'op', op: { t: 'layer.add', id: 'op5', parent: folder, index: 0, layer: { id: 'ly2', name: 'x'.repeat(5000), visible: true, opacity: 1, blend: 'normal', alphaLock: false } } }));
rej = await next('reject');
check(rej.opId === 'op5', 'huge layer name is refused');

ws.send(JSON.stringify({ type: 'op', op: { t: 'stroke', id: 'op6', layer: 'ly1', erase: false, brush, color: '#000000', pts: [0, 0, 1, 5, 5, 1] } }));
ws.send(JSON.stringify({ type: 'chat', text: 'still here' }));
await next('chat', (m) => m.msg.text === 'still here');
check(!messages.some((m) => m.type === 'reject' && m.opId === 'op6'), 'a normal stroke still goes through');

ws.send(JSON.stringify({ type: 'set-host', user: 'nobody' }));
await new Promise((res) => setTimeout(res, 200));
check(!messages.some((m) => m.type === 'members' && m.members.some((x) => x.id === 'nobody')), 'unknown users can’t become hosts');
ws.close();

// ---- Cross-site websocket ----
const bad = new WebSocket(`${base.replace('http', 'ws')}/ws/${room.id}`, { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
const badResult = await new Promise((res) => { bad.on('open', () => res('open')); bad.on('error', () => res('refused')); });
check(badResult === 'refused', 'cross-site websocket is refused');

process.exit(failed ? 1 : 0);
