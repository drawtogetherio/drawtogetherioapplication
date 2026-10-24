import http2 from 'node:http2';
import crypto from 'node:crypto';
import { db } from './db.ts';
import { config } from './config.ts';

// Push notifications for the iPad app, sent straight to Apple (APNs) over HTTP/2 with a token key (.p8).
// The app registers its device token after login; a token belongs to whoever registered it last.

db.exec(`
  CREATE TABLE IF NOT EXISTS push_devices (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    env TEXT NOT NULL,                 -- 'sandbox' (builds run from Xcode) | 'production' (TestFlight, App Store)
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices (user_id);
`);

export type PushEnv = 'sandbox' | 'production';
const TOKEN_RE = /^[0-9a-f]{64,200}$/;
const MAX_DEVICES = 10;
const HOSTS: Record<PushEnv, string> = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' };

export const pushEnabled = () => !!config.apns;

export function addDevice(userId: string, token: string, env: unknown) {
  if (!TOKEN_RE.test(token)) return false;
  db.prepare(`INSERT INTO push_devices (token, user_id, env, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, env = excluded.env, created_at = excluded.created_at`)
    .run(token, userId, env === 'production' ? 'production' : 'sandbox', Date.now());
  db.prepare(`DELETE FROM push_devices WHERE user_id = ? AND token NOT IN (SELECT token FROM push_devices WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`).run(userId, userId);
  return true;
}

export function removeDevice(userId: string, token: string) {
  db.prepare('DELETE FROM push_devices WHERE user_id = ? AND token = ?').run(userId, token);
}

/** Signed out, banned or deleted: none of their iPads hears from us again. */
export function forgetDevices(userId: string) {
  db.prepare('DELETE FROM push_devices WHERE user_id = ?').run(userId);
}

// ---- APNs ----

let jwt: { token: string; at: number } | null = null;
/** Apple wants a fresh token at most every hour and at least every 20 minutes apart; 40 minutes sits between. */
function bearer(): string {
  const a = config.apns!;
  if (jwt && Date.now() - jwt.at < 40 * 60_000) return jwt.token;
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'ES256', kid: a.keyId })}.${enc({ iss: a.teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = crypto.sign('sha256', Buffer.from(body), { key: a.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwt = { token: `${body}.${sig}`, at: Date.now() };
  return jwt.token;
}

const sessions = new Map<string, http2.ClientHttp2Session>();
function session(origin: string) {
  let s = sessions.get(origin);
  if (s && !s.closed && !s.destroyed) return s;
  s = http2.connect(origin);
  s.on('error', () => sessions.delete(origin));
  s.on('close', () => sessions.delete(origin));
  s.setTimeout(10 * 60_000, () => s!.close());
  s.unref();
  sessions.set(origin, s);
  return s;
}

function post(env: PushEnv, token: string, payload: string, headers: Record<string, string>): Promise<{ status: number; reason: string }> {
  const origin = config.apns!.host ?? HOSTS[env];
  return new Promise((resolve) => {
    let req: http2.ClientHttp2Stream;
    try {
      req = session(origin).request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${bearer()}`, ...headers });
    } catch { resolve({ status: 0, reason: 'connect' }); return; }
    let status = 0, data = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (c: string) => { data += c; });
    req.on('end', () => { let reason = ''; try { reason = JSON.parse(data).reason ?? ''; } catch { /* empty body on success */ } resolve({ status, reason }); });
    req.on('error', () => resolve({ status: 0, reason: 'network' }));
    req.setTimeout(15_000, () => { req.close(); resolve({ status: 0, reason: 'timeout' }); });
    req.end(payload);
  });
}

export interface Push { body: string; badge: number; data: Record<string, unknown>; collapse?: string }

/** Sends to every device the person has registered; tokens Apple no longer knows are dropped. */
export async function push(userId: string, p: Push) {
  if (!config.apns) return;
  const devices = db.prepare('SELECT token, env FROM push_devices WHERE user_id = ?').all(userId) as { token: string; env: PushEnv }[];
  if (!devices.length) return;
  const payload = JSON.stringify({ aps: { alert: { title: 'Doodlehive', body: p.body }, badge: p.badge, sound: 'default' }, ...p.data });
  const headers: Record<string, string> = { 'apns-topic': config.apns.topic, 'apns-push-type': 'alert', 'apns-priority': '10' };
  // A newer notice about the same thing replaces the older one on the lock screen.
  if (p.collapse) headers['apns-collapse-id'] = p.collapse.slice(0, 64);
  await Promise.all(devices.map(async (d) => {
    let r = await post(d.env, d.token, payload, headers);
    // A Release build run from Xcode still gets a sandbox token; try the other server once and remember which worked.
    if (r.status === 400 && r.reason === 'BadDeviceToken' && !config.apns!.host) {
      const other: PushEnv = d.env === 'sandbox' ? 'production' : 'sandbox';
      r = await post(other, d.token, payload, headers);
      if (r.status === 200) db.prepare('UPDATE push_devices SET env = ? WHERE token = ?').run(other, d.token);
    }
    if (r.status === 410 || (r.status === 400 && (r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic'))) {
      db.prepare('DELETE FROM push_devices WHERE token = ?').run(d.token);
    } else if (r.status !== 200) {
      console.warn(`push to ${userId} failed: ${r.status} ${r.reason}`);
    }
  }));
}

export function closePush() { for (const s of sessions.values()) s.close(); }
