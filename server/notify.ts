import { db, isPremium, newId, USER_COLS, UserRow } from './db.ts';
import { sendTo } from './live.ts';
import type { Notice, NoticeKind } from '../src/shared/notices.ts';

// Notifications are rows per user; `key` lets a repeat replace the old one instead of piling up.

db.exec(`
  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notices_user ON notices (user_id, created_at);
`);

const KEEP = 100;
const WARN_MS = 24 * 3600_000;

export function notify(userId: string, kind: NoticeKind, text: string, data: Record<string, unknown> = {}, key?: string) {
  if (key) db.prepare('DELETE FROM notices WHERE user_id = ? AND key = ?').run(userId, key);
  db.prepare('INSERT INTO notices (id, user_id, key, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newId('n_'), userId, key ?? null, kind, text, JSON.stringify(data), Date.now());
  db.prepare(`DELETE FROM notices WHERE user_id = ? AND id NOT IN (SELECT id FROM notices WHERE user_id = ? ORDER BY created_at DESC LIMIT ${KEEP})`).run(userId, userId);
  sendTo(userId, { type: 'notices' });
}

export function dropNotice(userId: string, key: string) {
  if (db.prepare('DELETE FROM notices WHERE user_id = ? AND key = ?').run(userId, key).changes) sendTo(userId, { type: 'notices' });
}

export function listNotices(userId: string): { unread: number; notices: Notice[] } {
  const rows = db.prepare('SELECT id, kind, text, data, read, created_at FROM notices WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId) as
    { id: string; kind: NoticeKind; text: string; data: string; read: number; created_at: number }[];
  const unread = (db.prepare('SELECT count(*) AS n FROM notices WHERE user_id = ? AND read = 0').get(userId) as { n: number }).n;
  return { unread, notices: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, data: JSON.parse(r.data), read: !!r.read, at: r.created_at })) };
}

export function readNotices(userId: string) { db.prepare('UPDATE notices SET read = 1 WHERE user_id = ?').run(userId); }
export function clearNotices(userId: string) { db.prepare('DELETE FROM notices WHERE user_id = ?').run(userId); }

/** One warning per expiry date, once it is under a day away. */
export function premiumWarning(u: UserRow) {
  const until = u.premium_until;
  if (!until || !isPremium(u) || until - Date.now() > WARN_MS || u.premium_warned === until) return;
  db.prepare('UPDATE users SET premium_warned = ? WHERE id = ?').run(until, u.id);
  const hours = Math.max(1, Math.round((until - Date.now()) / 3600_000));
  notify(u.id, 'system', `Your premium runs out in ${hours === 1 ? 'an hour' : hours + ' hours'}.`, { premium: until }, 'premium-' + until);
}

export function premiumWarnings() {
  const rows = db.prepare(`SELECT ${USER_COLS} FROM users WHERE premium = 1 AND premium_until IS NOT NULL AND premium_until BETWEEN ? AND ?`).all(Date.now(), Date.now() + WARN_MS) as unknown as UserRow[];
  for (const u of rows) premiumWarning(u);
}
