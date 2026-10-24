import net from 'node:net';
import { db, getSite, getUser, isAdmin, publicProfile, setSite, USER_COLS, UserRow } from './db.ts';
import { HttpError, Req, Res, json, jsonBody } from './http.ts';
import { deleteRoom, disconnectUser, liveRooms } from './rooms.ts';
import { closeStreams } from './live.ts';
import { forgetDevices } from './push.ts';
import { forget, onlineIds } from './social.ts';
import { readStats } from './stats.ts';
import { sweep } from './sweep.ts';
import { cleanBadges, sanitizeDisplayName, validateDisplayName } from '../src/shared/profile.ts';

// Admin-only API under /api/admin. Addresses are kept in memory per signed-in person so an admin can
// ban one; only the ban list itself is stored.

const ips = new Map<string, string>();
export function lastIp(userId: string, ip: string) { if (ip) ips.set(userId, ip); }

const bans = new Set((db.prepare('SELECT ip FROM ip_bans').all() as { ip: string }[]).map((r) => r.ip));
export const bannedIp = (ip: string) => bans.has(ip);

const DAY = 864e5;
const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;

function log(admin: UserRow, action: string, target = '') {
  db.prepare('INSERT INTO admin_log (admin_id, action, target, at) VALUES (?, ?, ?, ?)').run(admin.id, action, target, Date.now());
}

function signOut(userId: string, reason: string) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  forgetDevices(userId);
  disconnectUser(userId, reason);
  closeStreams(userId);
  forget(userId);
}

function adminUser(u: UserRow, online: Set<string>) {
  return {
    ...publicProfile(u), provider: u.provider, admin: isAdmin(u), banned: !!u.banned, createdAt: u.created_at,
    hasPremium: !!u.premium, online: online.has(u.id), ip: ips.get(u.id) ?? null,
    rooms: count('SELECT count(*) AS n FROM rooms WHERE owner_id = ?', u.id),
  };
}

export async function adminRoute(req: Req, res: Res, url: URL, me: UserRow, changed: (userId: string) => void) {
  const p = url.pathname, m = req.method ?? 'GET';
  if (!isAdmin(me)) throw new HttpError(404, 'Not found.');

  if (p === '/api/admin/stats' && m === 'GET') {
    const online = onlineIds(), live = liveRooms();
    const now = Date.now();
    return json(res, 200, {
      online: online.size,
      drawing: new Set(live.flatMap((r) => [...r.clients].map((c) => c.userId))).size,
      liveRooms: live.map((r) => ({ id: r.info.id, name: r.info.name, owner: getUser(r.info.ownerId)?.handle ?? '?', people: r.members().length })),
      users: {
        total: count(`SELECT count(*) AS n FROM users WHERE provider <> 'guest'`),
        guests: count(`SELECT count(*) AS n FROM users WHERE provider = 'guest'`),
        premium: count('SELECT count(*) AS n FROM users WHERE (premium = 1 AND (premium_until IS NULL OR premium_until > ?)) OR patreon_active = 1', now),
        today: count('SELECT count(*) AS n FROM users WHERE created_at > ?', now - DAY),
        banned: count('SELECT count(*) AS n FROM users WHERE banned = 1'),
      },
      rooms: count('SELECT count(*) AS n FROM rooms'),
      ipBans: bans.size,
      counters: readStats(),
    });
  }

  if (p === '/api/admin/users' && m === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim().replace(/^@/, '').slice(0, 40);
    const filter = url.searchParams.get('filter') ?? '';
    const where = filter === 'premium' ? 'AND premium = 1' : filter === 'banned' ? 'AND banned = 1' : filter === 'admin' ? 'AND admin = 1' : filter === 'guests' ? `AND provider = 'guest'` : '';
    const rows = db.prepare(`SELECT ${USER_COLS} FROM users WHERE (handle LIKE ? OR display_name LIKE ?) ${where} ORDER BY created_at DESC LIMIT 60`)
      .all(`%${q}%`, `%${q}%`) as unknown as UserRow[];
    const online = onlineIds();
    return json(res, 200, rows.map((u) => adminUser(u, online)));
  }

  let mm = /^\/api\/admin\/users\/([\w-]+)$/.exec(p);
  if (mm && (m === 'PATCH' || m === 'DELETE')) {
    const u = getUser(mm[1]);
    if (!u) throw new HttpError(404, 'No such person.');
    const self = u.id === me.id;
    if (m === 'DELETE') {
      if (self || isAdmin(u)) throw new HttpError(400, 'Admins can’t be deleted. Remove admin first.');
      signOut(u.id, 'Account removed');
      for (const r of db.prepare('SELECT id FROM rooms WHERE owner_id = ?').all(u.id) as { id: string }[]) deleteRoom(r.id);
      db.prepare('DELETE FROM friendships WHERE user_a = ? OR user_b = ?').run(u.id, u.id);
      db.prepare('DELETE FROM notices WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      log(me, 'delete', '@' + u.handle);
      return json(res, 200, { ok: true });
    }
    const b = await jsonBody(req);
    const set = (sql: string, ...args: (string | number | null)[]) => db.prepare(`UPDATE users SET ${sql} WHERE id = ?`).run(...args, u.id);
    if (b.premium !== undefined) {
      const v = b.premium;
      if (v === 'off') set('premium = 0, premium_until = NULL, premium_warned = NULL');
      else if (v === 'forever') set('premium = 1, premium_until = NULL, premium_warned = NULL');
      else if (typeof v === 'number' && v > 0 && v <= 3650) set('premium = 1, premium_until = ?, premium_warned = NULL', Date.now() + v * DAY);
      else throw new HttpError(400, 'Premium is days, "forever" or "off".');
      log(me, `premium ${v}`, '@' + u.handle);
    }
    if (b.badges !== undefined) { set('badges = ?', JSON.stringify(cleanBadges(b.badges))); log(me, 'badges ' + cleanBadges(b.badges).join(',') || 'badges none', '@' + u.handle); }
    if (b.displayName !== undefined) {
      const name = sanitizeDisplayName(String(b.displayName));
      const err = validateDisplayName(name);
      if (err) throw new HttpError(400, err, 'displayName');
      set('display_name = ?', name);
      log(me, 'rename', '@' + u.handle);
    }
    if (b.clearStatus) { set(`status = ''`); log(me, 'clear status', '@' + u.handle); }
    if (b.removeAvatar) { set('avatar = NULL, avatar_type = NULL, avatar_anim = NULL, avatar_version = avatar_version + 1'); log(me, 'remove avatar', '@' + u.handle); }
    if (b.admin !== undefined) {
      if (self) throw new HttpError(400, 'You can’t change your own admin access.');
      if (u.provider === 'guest') throw new HttpError(400, 'Guests can’t be admins.');
      set('admin = ?', b.admin ? 1 : 0);
      log(me, b.admin ? 'make admin' : 'remove admin', '@' + u.handle);
    }
    if (b.banned !== undefined) {
      if (self || (isAdmin(u) && b.banned)) throw new HttpError(400, 'Admins can’t be banned. Remove admin first.');
      set('banned = ?', b.banned ? 1 : 0);
      if (b.banned) signOut(u.id, 'Banned');
      log(me, b.banned ? 'ban' : 'unban', '@' + u.handle);
    }
    if (b.signOut) { signOut(u.id, 'Signed out by an admin'); log(me, 'sign out', '@' + u.handle); }
    changed(u.id);
    return json(res, 200, adminUser(getUser(u.id)!, onlineIds()));
  }

  if (p === '/api/admin/ip-bans' && m === 'GET') {
    return json(res, 200, db.prepare('SELECT ip, reason, created_at AS createdAt FROM ip_bans ORDER BY created_at DESC').all());
  }
  if (p === '/api/admin/ip-bans' && (m === 'POST' || m === 'DELETE')) {
    const b = await jsonBody(req);
    const ip = String(b.ip ?? '').trim();
    if (!net.isIP(ip)) throw new HttpError(400, 'That isn’t an IP address.', 'ip');
    if (m === 'DELETE') {
      db.prepare('DELETE FROM ip_bans WHERE ip = ?').run(ip);
      bans.delete(ip);
      log(me, 'unban ip');
      return json(res, 200, { ok: true });
    }
    if (ip === ips.get(me.id)) throw new HttpError(400, 'That’s your own address.', 'ip');
    db.prepare('INSERT OR REPLACE INTO ip_bans (ip, reason, created_at) VALUES (?, ?, ?)').run(ip, String(b.reason ?? '').slice(0, 120), Date.now());
    bans.add(ip);
    for (const [userId, addr] of ips) if (addr === ip) signOut(userId, 'Banned');
    log(me, 'ban ip');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/admin/site' && m === 'GET') return json(res, 200, getSite());
  if (p === '/api/admin/site' && m === 'PATCH') {
    const b = await jsonBody(req);
    const site = setSite(b);
    log(me, `site: early badge ${site.earlyBadge ? 'on' : 'off'}, notice ${site.notice.on ? 'on' : 'off'}`);
    return json(res, 200, site);
  }
  if (p === '/api/admin/sweep' && m === 'POST') { const r = sweep(); log(me, `sweep: ${r.guests} guests`); return json(res, 200, r); }

  if (p === '/api/admin/log' && m === 'GET') {
    return json(res, 200, db.prepare(`SELECT l.action, l.target, l.at, u.handle AS admin FROM admin_log l LEFT JOIN users u ON u.id = l.admin_id
      ORDER BY l.id DESC LIMIT 100`).all());
  }
  throw new HttpError(404, 'Not found.');
}
