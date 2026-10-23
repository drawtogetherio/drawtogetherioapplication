// Patreon linking against a mock Patreon. Needs the server started with PATREON_CLIENT_ID/SECRET, PATREON_CAMPAIGN_ID=c1 and PATREON_API=http://localhost:8799.
// Usage: node tests/patreon.mjs [http://localhost:8787]
import http from 'node:http';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const suffix = Math.floor(Math.random() * 1e6);
const call = (method, path, body, cookie, extra = {}) => fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), ...extra });
const login = async (name) => { const r = await call('POST', '/auth/dev', { name }); const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; await call('PATCH', '/api/me', { done: true }, cookie); return { cookie, me: await r.json() }; };

// The mock: one Patreon user whose membership we can change between calls.
const patron = { id: 'p-1', name: 'Ren on Patreon', status: 'active_patron', campaign: 'c1' };
let tokenCalls = 0;
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/oauth2/authorize') {
    check(u.searchParams.get('client_id') === 'test-client' && u.searchParams.get('scope') === 'identity identity.memberships', 'the authorize link carries the client id and scopes');
    res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=code-${patron.id}&state=${u.searchParams.get('state')}` });
    return res.end();
  }
  if (u.pathname === '/api/oauth2/token') {
    tokenCalls++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = new URLSearchParams(body);
      const ok = f.get('client_secret') === 'test-secret' && (f.get('grant_type') === 'refresh_token' ? f.get('refresh_token') === 'refresh-1' : f.get('code') === 'code-p-1');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 2_678_400 } : { error: 'invalid_grant' }));
    });
    return;
  }
  if (u.pathname === '/api/oauth2/v2/identity') {
    if (req.headers.authorization !== 'Bearer access-1') { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      data: { type: 'user', id: patron.id, attributes: { full_name: patron.name } },
      included: [{ type: 'member', id: 'm-1', attributes: { patron_status: patron.status }, relationships: { campaign: { data: { type: 'campaign', id: patron.campaign } } } }],
    }));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => mock.listen(8799, r));

const cfg = await (await call('GET', '/api/config')).json();
check(cfg.patreonLink === true, 'the server advertises Patreon linking (start it with the PATREON_* test variables)');
const ren = await login('Ren' + suffix);
check(ren.me.patreon === null && !ren.me.premium, 'a new account has no Patreon link and no premium');

// The OAuth round trip, step by step.
let r = await call('GET', '/auth/patreon?next=/app', undefined, ren.cookie);
const oauth = (r.headers.get('set-cookie') ?? '').split(';')[0];
check(r.status === 302 && r.headers.get('location').startsWith('http://localhost:8799/oauth2/authorize?'), 'Link Patreon sends the person to Patreon');
r = await fetch(r.headers.get('location'), { redirect: 'manual' });
const back = new URL(r.headers.get('location'));
check(back.pathname === '/auth/patreon/callback', 'Patreon sends them back to the callback');
r = await call('GET', back.pathname + back.search, undefined, `${ren.cookie}; ${oauth}`);
check(r.status === 302 && r.headers.get('location').endsWith('/app?patreon=linked'), 'the callback links the account and returns to the app');
let me = await (await call('GET', '/api/me', undefined, ren.cookie)).json();
check(me.patreon?.name === 'Ren on Patreon' && me.patreon.active && me.premium && me.premiumUntil === null, 'an active patron has premium');
const room = await (await call('POST', '/api/rooms', { name: 'Kept', settings: { infinite: true }, share: { visibility: 'open' } }, ren.cookie)).json();
check(room.ephemeral === false, 'so their rooms are kept like any premium account’s');

r = await call('GET', back.pathname + '?code=bad&state=nope', undefined, ren.cookie);
check(r.headers.get('location').endsWith('?patreon=failed'), 'a callback without the matching state fails');

// Membership changes show up on the next check.
patron.status = 'former_patron';
me = await (await call('POST', '/api/me/patreon', undefined, ren.cookie)).json();
check(me.patreon?.active === false && !me.premium, 'Check again drops premium once the membership lapses');
patron.status = 'active_patron'; patron.campaign = 'other';
me = await (await call('POST', '/api/me/patreon', undefined, ren.cookie)).json();
check(!me.premium, 'a membership to a different campaign does not count');
patron.campaign = 'c1';
me = await (await call('POST', '/api/me/patreon', undefined, ren.cookie)).json();
check(me.premium, 'and an active membership restores it');

// One Patreon account links to one Doodlehive account.
const sam = await login('Sam' + suffix);
r = await call('GET', '/auth/patreon', undefined, sam.cookie);
const samOauth = (r.headers.get('set-cookie') ?? '').split(';')[0];
r = await fetch(r.headers.get('location'), { redirect: 'manual' });
const samBack = new URL(r.headers.get('location'));
r = await call('GET', samBack.pathname + samBack.search, undefined, `${sam.cookie}; ${samOauth}`);
check(r.headers.get('location').endsWith('?patreon=taken'), 'a Patreon account already linked elsewhere is refused');
check(!(await (await call('GET', '/api/me', undefined, sam.cookie)).json()).premium, 'and grants nothing');

me = await (await call('DELETE', '/api/me/patreon', undefined, ren.cookie)).json();
check(me.patreon === null && !me.premium, 'Unlink removes the link and the premium that came with it');
r = await call('GET', '/auth/patreon', undefined, (await (async () => { const g = await call('POST', '/auth/guest', {}); return (g.headers.get('set-cookie') ?? '').split(';')[0]; })()));
check(r.status === 403 || r.status === 401, 'guests cannot link');
check(tokenCalls >= 2, 'tokens were exchanged');

mock.close();
if (failed) process.exit(1);
console.log('all passed');
