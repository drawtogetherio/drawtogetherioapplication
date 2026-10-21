import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { HANDLE_FOODS, HANDLE_MAX, HANDLE_WORDS, MyProfile, PublicProfile, isValidHandle, suggestHandle } from '../src/shared/profile.ts';
import { DEFAULT_THEME, canUseTheme } from '../src/shared/themes.ts';
import { cleanPrefs } from '../src/shared/prefs.ts';
import { cleanBadges } from '../src/shared/profile.ts';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,            -- 'discord' | 'dev' | 'guest'
    provider_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    favorite_color TEXT NOT NULL,
    links TEXT NOT NULL DEFAULT '{}',
    avatar BLOB,
    avatar_type TEXT,
    avatar_version INTEGER NOT NULL DEFAULT 0,
    premium INTEGER NOT NULL DEFAULT 0,
    premium_until INTEGER,             -- ms epoch, null = no expiry
    needs_setup INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, provider_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_handle ON users (lower(handle));
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    settings TEXT NOT NULL,
    hosts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_ops (
    room_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    op TEXT NOT NULL,
    PRIMARY KEY (room_id, seq)
  );
`);

// Columns added after the first release.
function addColumn(table: string, col: string, def: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'theme', `TEXT NOT NULL DEFAULT '${DEFAULT_THEME}'`);
addColumn('users', 'status', `TEXT NOT NULL DEFAULT ''`);
addColumn('users', 'gradient', 'TEXT'); // "#aabbcc,#ddeeff"
addColumn('users', 'avatar_anim', 'BLOB');
addColumn('users', 'avatar_anim_version', 'INTEGER NOT NULL DEFAULT 0');
addColumn('rooms', 'private', 'INTEGER NOT NULL DEFAULT 0');
addColumn('rooms', 'updated_at', 'INTEGER');
addColumn('rooms', 'thumb', 'BLOB');
addColumn('rooms', 'thumb_version', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'presence_mode', `TEXT NOT NULL DEFAULT 'auto'`);
addColumn('users', 'premium_warned', 'INTEGER'); // the premium_until a warning went out for
addColumn('users', 'prefs', `TEXT NOT NULL DEFAULT '{}'`);
// visibility has its own column so the home screen can filter on it; the other share flags are JSON.
addColumn('rooms', 'visibility', `TEXT NOT NULL DEFAULT 'open'`);
addColumn('rooms', 'share', `TEXT NOT NULL DEFAULT '{}'`);
addColumn('rooms', 'watch_key', 'TEXT');
addColumn('users', 'admin', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'banned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'badges', `TEXT NOT NULL DEFAULT '[]'`);
db.exec(`UPDATE rooms SET visibility = 'private' WHERE private = 1 AND visibility <> 'private'`);
db.exec(`
  -- One row per pair, with user_a < user_b. Pending until the other person accepts.
  CREATE TABLE IF NOT EXISTS friendships (
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b)
  );
  CREATE INDEX IF NOT EXISTS friendships_b ON friendships (user_b);
  CREATE INDEX IF NOT EXISTS rooms_owner ON rooms (owner_id);
  CREATE TABLE IF NOT EXISTS ip_bans (ip TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
`);

export interface UserRow {
  id: string; provider: string; provider_id: string; handle: string; display_name: string;
  favorite_color: string; links: string; has_avatar: number; avatar_type: string | null;
  avatar_version: number; premium: number; premium_until: number | null; needs_setup: number; created_at: number; theme: string;
  status: string; gradient: string | null; has_anim: number; avatar_anim_version: number; presence_mode: string; premium_warned: number | null; prefs: string;
  admin: number; banned: number; badges: string;
}

export const USER_COLS = `id, provider, provider_id, handle, display_name, favorite_color, links, avatar IS NOT NULL AS has_avatar,
  avatar_type, avatar_version, premium, premium_until, needs_setup, created_at, theme, status, gradient,
  avatar_anim IS NOT NULL AS has_anim, avatar_anim_version, presence_mode, premium_warned, prefs, admin, banned, badges`;

export const newId = (prefix: string, bytes = 9) => prefix + crypto.randomBytes(bytes).toString('base64url');

const PALETTE = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#d81b60'];

/** Guests can never be admins, whatever the row says. */
export const isAdmin = (u: UserRow) => !!u.admin && u.provider !== 'guest';

export function isPremium(u: UserRow) {
  return !!u.premium && (u.premium_until == null || u.premium_until > Date.now());
}

export function publicProfile(u: UserRow): PublicProfile {
  return {
    id: u.id, handle: u.handle, displayName: u.display_name, favoriteColor: u.favorite_color,
    avatar: u.has_avatar ? `/avatars/${u.id}?v=${u.avatar_version}` : null,
    links: JSON.parse(u.links), premium: isPremium(u), premiumUntil: u.premium_until, status: u.status,
    gradient: isPremium(u) && u.gradient ? (u.gradient.split(',') as [string, string]) : null,
    avatarAnimated: isPremium(u) && u.has_anim ? `/avatars/${u.id}/anim?v=${u.avatar_anim_version}` : null,
    guest: u.provider === 'guest',
    badges: cleanBadges(safeJson(u.badges)),
  };
}

export function myProfile(u: UserRow): MyProfile {
  const theme = canUseTheme(u.theme, isPremium(u)) ? u.theme : DEFAULT_THEME;
  return {
    ...publicProfile(u), needsSetup: !!u.needs_setup, provider: u.provider as MyProfile['provider'], theme,
    presenceMode: u.presence_mode as MyProfile['presenceMode'], prefs: cleanPrefs(safeJson(u.prefs)), admin: isAdmin(u),
  };
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }

export function getUser(id: string): UserRow | undefined {
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function handleTaken(handle: string, exceptUser?: string) {
  const row = db.prepare('SELECT id FROM users WHERE lower(handle) = lower(?)').get(handle) as { id: string } | undefined;
  return !!row && row.id !== exceptUser;
}

export function freeHandle(): string {
  for (let i = 0; i < 40; i++) {
    const h = HANDLE_WORDS[crypto.randomInt(HANDLE_WORDS.length)] + HANDLE_FOODS[crypto.randomInt(HANDLE_FOODS.length)];
    if (!handleTaken(h)) return h;
  }
  for (;;) {
    const h = HANDLE_WORDS[crypto.randomInt(HANDLE_WORDS.length)] + HANDLE_FOODS[crypto.randomInt(HANDLE_FOODS.length)] + crypto.randomInt(10, 9999);
    if (!handleTaken(h)) return h;
  }
}

export function freeHandleLike(base: string): string {
  const b = suggestHandle(base) || 'artist';
  if (!handleTaken(b)) return b;
  for (let n = 2; ; n++) {
    const tail = String(n);
    const h = (b.slice(0, HANDLE_MAX - tail.length).replace(/\.+$/, '') || 'artist') + tail;
    if (isValidHandle(h) && !handleTaken(h)) return h;
  }
}

export function findOrCreateUser(provider: 'discord' | 'dev', providerId: string, displayName: string, handleHint: string): UserRow {
  let u = db.prepare(`SELECT ${USER_COLS} FROM users WHERE provider = ? AND provider_id = ?`).get(provider, providerId) as UserRow | undefined;
  if (!u) {
    const id = newId('u_');
    db.prepare(`INSERT INTO users (id, provider, provider_id, handle, display_name, favorite_color, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, provider, providerId, freeHandleLike(handleHint), displayName, PALETTE[crypto.randomInt(PALETTE.length)], Date.now());
    u = getUser(id)!;
  }
  // ADMIN_HANDLES names the first admins; the rest are made in the dashboard.
  if (!u.admin && config.adminHandles.some((h) => h.toLowerCase() === u!.handle.toLowerCase())) {
    db.prepare('UPDATE users SET admin = 1 WHERE id = ?').run(u.id);
    u = getUser(u.id)!;
  }
  return u;
}

export function createGuest(displayName: string): UserRow {
  const id = newId('u_');
  db.prepare(`INSERT INTO users (id, provider, provider_id, handle, display_name, favorite_color, needs_setup, created_at)
    VALUES (?, 'guest', ?, ?, ?, ?, 0, ?)`).run(id, id, freeHandle(), displayName, PALETTE[crypto.randomInt(PALETTE.length)], Date.now());
  return getUser(id)!;
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + 30 * 864e5);
  return token;
}

export function sessionUser(token: string | undefined): UserRow | undefined {
  if (!token) return undefined;
  const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token) as { user_id: string; expires_at: number } | undefined;
  if (!s || s.expires_at < Date.now()) return undefined;
  return getUser(s.user_id);
}

export function deleteSession(token: string) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
