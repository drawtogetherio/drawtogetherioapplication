// A canvas carried from one room into a new one: the old room's members keep their layers and folders.
// Needs the API server with dev login on. Usage: node tests/handoff.mjs [http://localhost:8787]
import WebSocket from 'ws';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);

const login = async (name) => ((await fetch(base + '/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: name + suffix }) })).headers.get('set-cookie') ?? '').split(';')[0];
const api = (cookie, method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
const share = { visibility: 'open', requireLogin: false, friendsCanJoin: true, approveJoins: false };

async function connect(cookie, room) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${room}`, { headers: { Cookie: cookie, Origin: base } });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const next = (type, pred = () => true) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + type)), 5000);
    const look = () => { const i = messages.findIndex((m) => m.type === type && pred(m)); if (i >= 0) { clearTimeout(t); res(messages.splice(i, 1)[0]); return true; } return false; };
    if (!look()) ws.on('message', function h() { if (look()) ws.off('message', h); });
  });
  await new Promise((res) => ws.on('open', res));
  const welcome = await next('welcome');
  const op = (o) => ws.send(JSON.stringify({ type: 'op', op: o }));
  /** Sends an op and resolves with its rejection reason, or null once it comes back accepted. */
  const send = (o) => { op(o); return Promise.race([next('ack', (m) => m.id === o.id).then(() => null), next('reject', (m) => m.opId === o.id).then((m) => m.reason)]); };
  return { ws, welcome, send, messages };
}

const layer = (id) => ({ id, name: 'L', visible: true, opacity: 1, blend: 'normal', alphaLock: false });

// ---- Host A's room: Cara draws in her folder ----
const a = await login('HostA'), b = await login('HostB'), c = await login('Cara');
const first = await (await api(a, 'POST', '/api/rooms', { name: 'First', settings: { infinite: true }, share })).json();
const ca = await connect(a, first.id), cb = await connect(b, first.id), cc = await connect(c, first.id);
const cara = cc.welcome.you, caraFolder = 'uf_' + cara;
check(!await cc.send({ t: 'folder.add', id: 'op_f1', parent: caraFolder, index: 0, folder: { id: 'fd_cara', name: 'Sketch', visible: true } }), 'Cara adds a folder in her room folder');
check(!await cc.send({ t: 'layer.add', id: 'op_l1', parent: 'fd_cara', index: 0, layer: layer('ly_cara') }), 'and a layer in it');

// ---- B starts a new room from the same canvas (as its device copy would send it) ----
const replay = new WebSocket(`${base.replace('http', 'ws')}/ws/${first.id}`, { headers: { Cookie: b, Origin: base } });
const log = await new Promise((res) => replay.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'welcome') res(m.ops); }));
replay.close();
for (const s of [ca, cb, cc]) s.ws.close();
const second = await (await api(b, 'POST', '/api/rooms', { name: 'Second', settings: { infinite: true }, share, ops: log })).json();
check(!!second.id, 'Host B opens a room from the canvas');

const cc2 = await connect(c, second.id);
const added = (id) => cc2.welcome.ops.find((o) => (o.t === 'layer.add' && o.layer.id === id) || (o.t === 'folder.add' && o.folder.id === id));
check(added(caraFolder)?.folder.owner === cara && added(caraFolder)?.folder.user === true, 'Cara’s room folder is still hers');
check(added('fd_cara')?.folder.owner === cara, 'so is her own folder');
check(added('ly_cara')?.layer.owner === cara, 'and her layer');
check(cc2.welcome.ops.filter((o) => o.t === 'folder.add' && o.folder.id === caraFolder).length === 1, 'she isn’t given a second room folder');
check(!await cc2.send({ t: 'layer.props', id: 'op_p1', layer: 'ly_cara', props: { name: 'Still mine' } }), 'Cara can edit her layer in the new room');
check(!await cc2.send({ t: 'layer.add', id: 'op_l2', parent: 'fd_cara', index: 0, layer: layer('ly_cara2') }), 'and add to her folder');
check(!await cc2.send({ t: 'layer.add', id: 'op_l3', parent: caraFolder, index: 0, layer: layer('ly_cara3') }), 'and to her room folder');
const hostA = cc2.welcome.ops.find((o) => o.t === 'folder.add' && o.folder.user && o.folder.id !== caraFolder && o.folder.id !== 'uf_' + cb.welcome.you);
check(!!hostA && !!await cc2.send({ t: 'layer.add', id: 'op_l4', parent: hostA.folder.id, index: 0, layer: layer('ly_x') }), 'but not to Host A’s folder');
cc2.ws.close();

// ---- Owners that aren't real people fall back to the new room's owner ----
const forged = await (await api(b, 'POST', '/api/rooms', { name: 'Forged', settings: { infinite: true }, share, ops: [
  { t: 'folder.add', id: 'op_1', parent: null, index: 0, folder: { id: 'uf_nobody', name: 'Nobody', visible: true, owner: 'nobody', user: true } },
  { t: 'layer.add', id: 'op_2', parent: 'uf_nobody', index: 0, layer: { ...layer('ly_n'), owner: 'nobody' } },
] })).json();
const cb2 = await connect(b, forged.id);
check(cb2.welcome.ops.every((o) => o.t !== 'folder.add' || o.folder.id !== 'uf_nobody' || (o.folder.owner === cb2.welcome.you && !o.folder.user)), 'an unknown member’s folder becomes the owner’s plain folder');
check(cb2.welcome.ops.find((o) => o.t === 'layer.add' && o.layer.id === 'ly_n')?.layer.owner === cb2.welcome.you, 'and their layer the owner’s');
cb2.ws.close();

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
