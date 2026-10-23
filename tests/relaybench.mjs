// Server relay benchmark: N bot members draw in one room (live chunks, cursors, stroke ops, like the app)
// and every bot timestamps what it receives from the others. Reports relay latency for ops and live chunks.
// Needs the server running with dev login on. Usage: node tests/relaybench.mjs [--url http://localhost:8787] [--bots 4] [--secs 15]
import WebSocket from 'ws';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const base = arg('url', 'http://localhost:8787').replace(/\/$/, '');
const BOTS = Number(arg('bots', 4)), SECS = Number(arg('secs', 15));
const tag = Math.floor(Math.random() * 1e6).toString(36);
const brush = { size: 28, opacity: 1, flow: 1, hardness: 0.85, spacing: 0.08, pressureSize: 0.8, pressureFlow: 0.4, minSize: 0.15, smoothing: 0.3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const id = (p = 'op_') => p + tag + (seq++).toString(36);
const sent = new Map(); // op/stroke id -> send time
const opLat = [], liveLat = [];

async function login(name) {
  const r = await fetch(base + '/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!r.ok) throw new Error('login ' + r.status);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const hostCookie = await login('Relay' + tag);
const created = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie: hostCookie, origin: base }, body: JSON.stringify({ name: 'Relay bench', settings: { infinite: true, background: '#ffffff' }, share: { visibility: 'open' } }) });
const roomId = (await created.json()).id;

async function bot(i) {
  const cookie = i === 0 ? hostCookie : await login(`Relay${i}x${tag}`);
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${roomId}`, { headers: { cookie } });
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  let layer = '';
  await new Promise((res) => ws.on('message', (d) => {
    const m = JSON.parse(String(d)), now = performance.now();
    if (m.type === 'welcome') {
      layer = id('ly_');
      send({ type: 'op', op: { t: 'layer.add', id: id(), parent: 'uf_' + m.you, index: 0, layer: { id: layer, name: 'L', visible: true, opacity: 1, blend: 'normal', alphaLock: false } } });
      setTimeout(res, 300);
    } else if (m.type === 'op' && sent.has(m.op.id)) opLat.push(now - sent.get(m.op.id));
    else if (m.type === 'live' && sent.has(m.live.stroke + ':' + m.live.pts.length + ':' + m.live.pts[0])) liveLat.push(now - sent.get(m.live.stroke + ':' + m.live.pts.length + ':' + m.live.pts[0]));
  }));
  return { ws, send, layer };
}

const bots = [];
for (let i = 0; i < BOTS; i++) bots.push(await bot(i));
const end = performance.now() + SECS * 1000;
await Promise.all(bots.map(async (b, i) => {
  let k = 0;
  while (performance.now() < end) {
    const stroke = id(), pts = [];
    let from = 0, lastLive = performance.now();
    for (let s = 0; s < 90; s++) {
      pts.push(100 * i + s * 5 + k, 200 * i + Math.sin(s / 6) * 30, 0.7);
      if (performance.now() - lastLive >= 33) {
        const chunk = pts.slice(from);
        sent.set(stroke + ':' + chunk.length + ':' + chunk[0], performance.now());
        b.send({ type: 'live', live: { stroke, layer: b.layer, erase: false, brush, color: '#3355ff', pts: chunk } });
        from = pts.length; lastLive = performance.now();
      }
      if (s % 3 === 0) b.send({ type: 'cursor', x: pts[pts.length - 3] | 0, y: pts[pts.length - 2] | 0, drawing: true });
      await sleep(16);
    }
    sent.set(stroke, performance.now());
    b.send({ type: 'op', op: { t: 'stroke', id: stroke, layer: b.layer, erase: false, brush, color: '#3355ff', pts } });
    k++;
    await sleep(250);
  }
}));
await sleep(500);
for (const b of bots) b.ws.close();

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : 0; };
console.log(JSON.stringify({
  bots: BOTS, secs: SECS,
  opRelayP50: q(opLat, 0.5), opRelayP95: q(opLat, 0.95), opRelayMax: q(opLat, 1), ops: opLat.length,
  liveRelayP50: q(liveLat, 0.5), liveRelayP95: q(liveLat, 0.95), liveRelayMax: q(liveLat, 1), lives: liveLat.length,
}, null, 2));
