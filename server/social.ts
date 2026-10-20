import { db, getUser, publicProfile, USER_COLS, UserRow } from './db.ts';
import type { PublicProfile } from '../src/shared/profile.ts';

// ---- Presence ----
// Someone is "online" if their app checked in recently (the home screen polls, rooms keep it fresh).

const ONLINE_MS = 75_000;
const lastSeen = new Map<string, number>();

export function touch(userId: string) { lastSeen.set(userId, Date.now()); }
export function isOnline(userId: string) { return (lastSeen.get(userId) ?? 0) > Date.now() - ONLINE_MS; }

// ---- Friends ----

export interface Friend extends PublicProfile { online: boolean }
export interface FriendsList { friends: Friend[]; incoming: PublicProfile[]; outgoing: PublicProfile[] }

const MAX_FRIENDS = 500;
const MAX_PENDING = 100;

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

interface Row { user_a: string; user_b: string; requested_by: string; accepted: number }

function row(x: string, y: string): Row | undefined {
  const [a, b] = pair(x, y);
  return db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b) as Row | undefined;
}

export function listFriends(me: string): FriendsList {
  const rows = db.prepare('SELECT * FROM friendships WHERE user_a = ? OR user_b = ?').all(me, me) as unknown as Row[];
  const out: FriendsList = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows) {
    const other = r.user_a === me ? r.user_b : r.user_a;
    const u = getUser(other);
    if (!u) continue;
    const p = publicProfile(u);
    if (r.accepted) out.friends.push({ ...p, online: isOnline(other) });
    else if (r.requested_by === me) out.outgoing.push(p);
    else out.incoming.push(p);
  }
  // Online first, then alphabetical.
  out.friends.sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName));
  return out;
}

export class FriendError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Send a request by handle. If they already asked you, this accepts instead. */
export function requestFriend(me: UserRow, handle: string): 'requested' | 'accepted' {
  const h = handle.trim().replace(/^@/, '');
  const them = db.prepare(`SELECT ${USER_COLS} FROM users WHERE lower(handle) = lower(?)`).get(h) as UserRow | undefined;
  if (!them) throw new FriendError(404, `No one has the handle @${h}.`);
  if (them.id === me.id) throw new FriendError(400, 'That’s you!');
  const existing = row(me.id, them.id);
  if (existing?.accepted) throw new FriendError(409, `You’re already friends with ${them.display_name}.`);
  if (existing && existing.requested_by === me.id) throw new FriendError(409, 'Request already sent.');
  if (existing) { acceptFriend(me.id, them.id); return 'accepted'; }
  const counts = db.prepare(`SELECT
      sum(accepted) AS friends,
      sum(CASE WHEN accepted = 0 AND requested_by = ? THEN 1 ELSE 0 END) AS pending
    FROM friendships WHERE user_a = ? OR user_b = ?`).get(me.id, me.id, me.id) as { friends: number | null; pending: number | null };
  if ((counts.friends ?? 0) >= MAX_FRIENDS) throw new FriendError(409, 'Your friends list is full.');
  if ((counts.pending ?? 0) >= MAX_PENDING) throw new FriendError(429, 'Too many requests waiting. Wait for some answers first.');
  const [a, b] = pair(me.id, them.id);
  db.prepare('INSERT INTO friendships (user_a, user_b, requested_by, accepted, created_at) VALUES (?, ?, ?, 0, ?)').run(a, b, me.id, Date.now());
  return 'requested';
}

export function acceptFriend(me: string, other: string) {
  const r = row(me, other);
  if (!r || r.accepted || r.requested_by === me) throw new FriendError(404, 'That request is gone.');
  const [a, b] = pair(me, other);
  db.prepare('UPDATE friendships SET accepted = 1 WHERE user_a = ? AND user_b = ?').run(a, b);
}

/** Unfriend, decline a request, or cancel one you sent. */
export function removeFriend(me: string, other: string) {
  const [a, b] = pair(me, other);
  db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(a, b);
}
