// Beta running on a copy of the live database. Starts its own live and beta servers.
// Usage: node tests/sync.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const LIVE = 8794, BETA = 8795, SECRET = 'test-sync-secret-0123456789abcdef';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-sync-'));
const liveDb = path.join(dir, 'live.db'), betaDb = path.join(dir, 'beta.db');

function start(port, db, env) {
  const p = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(port), DB_PATH: db, DEV_LOGIN: '1', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let log = '';
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  p.stdout.on('data', (d) => { log += d; });
  return {
    ready: async () => { for (let i = 0; i < 150 && !log.includes('Pages in'); i++) await new Promise((r) => setTimeout(r, 100)); },
    stop: () => { p.kill('SIGTERM'); return exited; }, exited, log: () => log,
  };
}
const at = (port) => {
  const base = `http://localhost:${port}`;
  const call = (method, p, body, cookie, headers = {}) => fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (name) => { const r = await call('POST', '/auth/dev', { name }); const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; await call('PATCH', '/api/me', { done: true }, cookie); return { cookie, me: await r.json() }; };
  return { call, login };
};
const live = at(LIVE), beta = at(BETA);
const name = 'Ren' + Math.floor(Math.random() * 1e6);

const liveSrv = start(LIVE, liveDb, { SYNC_SECRET: SECRET, SYNC_FROM: `http://localhost:${BETA}` });
await liveSrv.ready();
const ren = await live.login(name);
await live.call('PATCH', '/api/me', { status: 'on live' }, ren.cookie);
new DatabaseSync(liveDb).prepare(`UPDATE users SET patreon_tokens = 'secret-tokens' WHERE id = ?`).run(ren.me.id);

let r = await live.call('GET', '/api/sync/snapshot', undefined, undefined, { Authorization: 'Bearer wrong-secret-wrong-secret-wrong-s' });
check(r.status === 404, 'a wrong secret gets nothing');
r = await live.call('GET', '/api/sync/snapshot');
check(r.status === 404, 'no secret gets nothing');
check(!liveSrv.log().includes('Copied the live database'), 'SYNC_FROM does nothing outside beta');

const betaEnv = { BETA: '1', SYNC_FROM: `http://localhost:${LIVE}`, SYNC_SECRET: SECRET, ADMIN_HANDLES: ren.me.handle };
let betaSrv = start(BETA, betaDb, betaEnv);
await betaSrv.ready();
check(betaSrv.log().includes('Copied the live database'), 'beta copies live on its first start');
let me = await beta.call('GET', '/api/me', undefined, ren.cookie);
check(me.status === 401, 'live sessions don’t come along');
const copy = new DatabaseSync(betaDb);
const row = copy.prepare('SELECT status, patreon_tokens FROM users WHERE id = ?').get(ren.me.id);
check(row?.status === 'on live' && row.patreon_tokens === null, 'the account is there, without its Patreon tokens');
r = await beta.call('GET', '/api/sync/snapshot', undefined, undefined, { Authorization: 'Bearer ' + SECRET });
check(r.status === 404, 'beta never hands out its own data');

// Changes on beta stay on beta, and a restart within the day keeps them.
const renBeta = await beta.login(name);
await beta.call('PATCH', '/api/me', { status: 'on beta' }, renBeta.cookie);
await betaSrv.stop();
betaSrv = start(BETA, betaDb, betaEnv);
await betaSrv.ready();
check(!betaSrv.log().includes('Copied the live database'), 'a restart within the day keeps beta’s data');
me = await (await beta.call('GET', '/api/me', undefined, renBeta.cookie)).json();
check(me.status === 'on beta', 'beta’s own changes are still there');
me = await (await live.call('GET', '/api/me', undefined, ren.cookie)).json();
check(me.status === 'on live', 'live is untouched by beta');

// An admin's "copy now" restarts beta with a fresh copy.
me = await (await beta.call('GET', '/api/admin/sync', undefined, renBeta.cookie)).json();
check(me.on && me.last > 0, 'the admin page sees when beta was last copied');
r = await beta.call('POST', '/api/admin/sync', undefined, renBeta.cookie);
check(r.ok, 'an admin can ask for a fresh copy');
const code = await betaSrv.exited;
check(code === 75, `beta exits with a restart code (${code})`);
betaSrv = start(BETA, betaDb, betaEnv);
await betaSrv.ready();
check(betaSrv.log().includes('Copied the live database'), 'the next start copies live again');
const renAgain = await beta.login(name);
me = await (await beta.call('GET', '/api/me', undefined, renAgain.cookie)).json();
check(me.status === 'on live', 'beta is back to live’s data');

await betaSrv.stop();
await liveSrv.stop();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
