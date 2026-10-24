import { db, getUser, hasBlocked, publicProfile, USER_COLS, UserRow } from './db.ts';
import { connectedIds, isConnected, sendTo } from './live.ts';
import { dropNotice, notify } from './notify.ts';
import { liveRooms, roomsWithUser, type Room } from './rooms.ts';
import type { Presence, PublicProfile } from '../src/shared/profile.ts';

// Online: an app tab is open, they're in a room, or they were seen recently.

const ONLINE_MS = 75_000;
const lastSeen = new Map<string, number>();

export function touch(userId: string) { lastSeen.set(userId, Date.now()); }
export function forget(userId: string) { lastSeen.delete(userId); }
export function isOnline(userId: string) {
  return isConnected(userId) || roomsWithUser(userId).length > 0 || (lastSeen.get(userId) ?? 0) > Date.now() - ONLINE_MS;
}

export function onlineIds(): Set<string> {
  const now = Date.now(), ids = new Set(connectedIds());
  for (const [id, t] of lastSeen) if (t > now - ONLINE_MS) ids.add(id);
  for (const r of liveRooms()) for (const c of r.clients) ids.add(c.userId);
  return ids;
}

export function presenceOf(u: UserRow): Presence {
  if (u.presence_mode === 'invisible' || !isOnline(u.id)) return 'offline';
  return u.presence_mode === 'away' ? 'away' : u.presence_mode === 'dnd' ? 'dnd' : 'online';
}

export function notifyFriends(userId: string) {
  for (const id of friendIds(userId)) sendTo(id, { type: 'friends' });
}

export interface FriendRoom { id: string; name: string }
export interface Friend extends PublicProfile { online: boolean; presence: Presence; room: FriendRoom | null }
export interface FriendsList { friends: Friend[]; incoming: PublicProfile[]; outgoing: PublicProfile[] }

const MAX_FRIENDS = 500;
const MAX_PENDING = 100;

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

interface Row { user_a: string; user_b: string; requested_by: string; accepted: number }

function row(x: string, y: string): Row | undefined {
  const [a, b] = pair(x, y);
  return db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b) as Row | undefined;
}

export function areFriends(x: string, y: string) { return !!row(x, y)?.accepted; }

export function friendIds(me: string): string[] {
  const rows = db.prepare('SELECT user_a, user_b FROM friendships WHERE accepted = 1 AND (user_a = ? OR user_b = ?)').all(me, me) as { user_a: string; user_b: string }[];
  return rows.map((r) => (r.user_a === me ? r.user_b : r.user_a));
}

/** Rooms that show a Join button in a friends list. */
export function canJoinFromFriends(me: string, room: Room): boolean {
  const s = room.info.share;
  if (room.info.ownerId === me) return true;
  if (hasBlocked(room.info.ownerId, me)) return false;
  if (s.visibility === 'friends') return areFriends(me, room.info.ownerId);
  return s.visibility === 'open' && s.friendsCanJoin;
}

function friendRoom(me: string, friend: string): FriendRoom | null {
  const r = roomsWithUser(friend).find((x) => canJoinFromFriends(me, x));
  return r ? { id: r.info.id, name: r.info.name } : null;
}

export function listFriends(me: string): FriendsList {
  const rows = db.prepare('SELECT * FROM friendships WHERE user_a = ? OR user_b = ?').all(me, me) as unknown as Row[];
  const out: FriendsList = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows) {
    const other = r.user_a === me ? r.user_b : r.user_a;
    const u = getUser(other);
    if (!u) continue;
    const p = publicProfile(u);
    if (r.accepted) {
      const presence = presenceOf(u);
      out.friends.push({ ...p, presence, online: presence !== 'offline', room: presence === 'offline' ? null : friendRoom(me, other) });
    }
    else if (r.requested_by === me) out.outgoing.push(p);
    else out.incoming.push(p);
  }
  out.friends.sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName));
  return out;
}

export class FriendError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** A request to someone who already asked you accepts instead. */
export function requestFriend(me: UserRow, handle: string): 'requested' | 'accepted' {
  const h = handle.trim().replace(/^@/, '');
  const them = db.prepare(`SELECT ${USER_COLS} FROM users WHERE lower(handle) = lower(?)`).get(h) as UserRow | undefined;
  if (!them) throw new FriendError(404, `No one has the handle @${h}.`);
  if (them.id === me.id) throw new FriendError(400, 'That’s you!');
  if (them.provider === 'guest') throw new FriendError(400, `@${them.handle} is a guest. Guests can’t be added as friends.`);
  if (hasBlocked(me.id, them.id)) throw new FriendError(409, `You blocked @${them.handle}. Unblock them first.`);
  if (hasBlocked(them.id, me.id)) throw new FriendError(403, `@${them.handle} isn’t accepting friend requests.`);
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
  sendTo(them.id, { type: 'friends' });
  notify(them.id, 'friend', `${me.display_name} sent you a friend request`, person(me), 'friend-' + me.id);
  return 'requested';
}

export function acceptFriend(me: string, other: string) {
  const r = row(me, other);
  if (!r || r.accepted || r.requested_by === me) throw new FriendError(404, 'That request is gone.');
  const [a, b] = pair(me, other);
  db.prepare('UPDATE friendships SET accepted = 1 WHERE user_a = ? AND user_b = ?').run(a, b);
  sendTo(other, { type: 'friends' });
  dropNotice(me, 'friend-' + other);
  const u = getUser(me);
  if (u) notify(other, 'friend-accepted', `${u.display_name} accepted your friend request`, person(u), 'accepted-' + me);
}

export function removeFriend(me: string, other: string) {
  const [a, b] = pair(me, other);
  db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(a, b);
  sendTo(other, { type: 'friends' });
  dropNotice(me, 'friend-' + other);
  dropNotice(other, 'friend-' + me);
}

const person = (u: UserRow) => ({ user: u.id, handle: u.handle, name: u.display_name });

// ---- Blocking ----

const MAX_BLOCKS = 1000;

export function listBlocked(me: string): PublicProfile[] {
  const rows = db.prepare('SELECT blocked_id FROM blocks WHERE user_id = ? ORDER BY created_at DESC').all(me) as { blocked_id: string }[];
  return rows.map((r) => getUser(r.blocked_id)).filter((u): u is UserRow => !!u).map(publicProfile);
}

/** Ends the friendship and any pending request, and removes them from rooms you host. */
export function blockUser(me: UserRow, id: string) {
  const them = getUser(id);
  if (!them || them.id === me.id) throw new FriendError(404, 'No such person.');
  if ((db.prepare('SELECT count(*) AS n FROM blocks WHERE user_id = ?').get(me.id) as { n: number }).n >= MAX_BLOCKS) throw new FriendError(409, 'Your block list is full.');
  db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(me.id, id, Date.now());
  if (row(me.id, id)) removeFriend(me.id, id);
  for (const r of roomsWithUser(id)) if (r.isHost(me.id)) r.expel(id);
}

export function unblockUser(me: string, id: string) {
  db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(me, id);
}
