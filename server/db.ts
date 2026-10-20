import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { HANDLE_FOODS, HANDLE_WORDS, MyProfile, PublicProfile } from '../src/shared/profile.ts';
import { DEFAULT_THEME, canUseTheme } from '../src/shared/themes.ts';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,            -- 'discord' | 'dev'
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
const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
if (!userCols.includes('theme')) db.exec(`ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT '${DEFAULT_THEME}'`);

export interface UserRow {
  id: string; provider: string; provider_id: string; handle: string; display_name: string;
  favorite_color: string; links: string; avatar: Uint8Array | null; avatar_type: string | null;
  avatar_version: number; premium: number; premium_until: number | null; needs_setup: number; created_at: number; theme: string;
}

export const newId = (prefix: string, bytes = 9) => prefix + crypto.randomBytes(bytes).toString('base64url');

const PALETTE = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#d81b60'];

export function isPremium(u: UserRow) {
  return !!u.premium && (u.premium_until == null || u.premium_until > Date.now());
}

export function publicProfile(u: UserRow): PublicProfile {
  return {
    id: u.id, handle: u.handle, displayName: u.display_name, favoriteColor: u.favorite_color,
    avatar: u.avatar ? `/avatars/${u.id}?v=${u.avatar_version}` : null,
    links: JSON.parse(u.links), premium: isPremium(u), premiumUntil: u.premium_until,
  };
}

export function myProfile(u: UserRow): MyProfile {
  // A premium theme falls back to the default once premium runs out.
  const theme = canUseTheme(u.theme, isPremium(u)) ? u.theme : DEFAULT_THEME;
  return { ...publicProfile(u), needsSetup: !!u.needs_setup, provider: u.provider as 'discord' | 'dev', theme };
}

export function getUser(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function handleTaken(handle: string, exceptUser?: string) {
  const row = db.prepare('SELECT id FROM users WHERE lower(handle) = lower(?)').get(handle) as { id: string } | undefined;
  return !!row && row.id !== exceptUser;
}

/** A free <Word><Food> handle, adding a number if every tried pair is taken. */
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

export function findOrCreateUser(provider: 'discord' | 'dev', providerId: string, displayName: string): UserRow {
  const existing = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').get(provider, providerId) as UserRow | undefined;
  if (existing) return existing;
  const id = newId('u_');
  db.prepare(`INSERT INTO users (id, provider, provider_id, handle, display_name, favorite_color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, provider, providerId, freeHandle(), displayName, PALETTE[crypto.randomInt(PALETTE.length)], Date.now());
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
