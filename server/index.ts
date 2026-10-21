import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { config } from './config.ts';
import {
  createGuest, createSession, db, deleteSession, findOrCreateUser, freeHandle, getUser, handleTaken, isPremium, myProfile, publicProfile, sessionUser, UserRow,
} from './db.ts';
import { cleanShare, createRoom, deleteRoom, getRoom, projectsOf, roomsWithUser, saveShare } from './rooms.ts';
import { FriendError, acceptFriend, areFriends, forget, listFriends, notifyFriends, removeFriend, requestFriend, touch } from './social.ts';
import { closeAllStreams, isConnected, openStream, sendTo, streamCount } from './live.ts';
import { allow, clientIp, sameSite, securityHeaders } from './guard.ts';
import {
  AVATAR_ANIM_MAX_BYTES, AVATAR_ANIM_MAX_SIZE, AVATAR_MAX_BYTES, LINK_PLATFORMS, STATUS_MAX, cleanStatus, handleError, PRESENCE_MODES, type PresenceMode, isRandomHandle, normalizeColor, normalizeLink, sanitizeDisplayName, validateDisplayName,
} from '../src/shared/profile.ts';
import { ROOM_NAME_MAX, WATCH_KEY_RE, type ShareSettings } from '../src/shared/protocol.ts';
import { THEMES, canUseTheme } from '../src/shared/themes.ts';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

const COOKIE = 'dw_session';
const SESSION_MS = 30 * 864e5;
const MINUTE = 60_000, HOUR = 3600_000;

class HttpError extends Error {
  constructor(public status: number, message: string, public field?: string) { super(message); }
}

function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: Res, name: string, value: string, maxAgeSec: number) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (config.secureCookies) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join('; ')]);
}

function json(res: Res, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirect(res: Res, to: string) { res.writeHead(302, { Location: to }); res.end(); }

async function body(req: Req, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'That file is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req: Req): Promise<Record<string, unknown>> {
  try { return JSON.parse((await body(req, 64 * 1024)).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
}

function limit(key: string, n: number, windowMs: number) {
  if (!allow(key, n, windowMs)) throw new HttpError(429, 'Too many requests. Try again in a bit.');
}

function requireUser(req: Req): UserRow {
  const u = sessionUser(cookies(req)[COOKIE]);
  if (!u) throw new HttpError(401, 'Please log in.');
  touch(u.id);
  return u;
}

function requireMember(req: Req, what: string): UserRow {
  const u = requireUser(req);
  if (u.provider === 'guest') throw new HttpError(403, `Log in with Discord to ${what}.`);
  return u;
}

function gifSize(buf: Buffer): { w: number; h: number } | null {
  const sig = buf.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isWebp = (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
const isPng = (b: Buffer) => b.subarray(0, 8).equals(PNG_SIG);
const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8;

function checkThumb(buf: Buffer): string {
  if (isWebp(buf)) return 'image/webp';
  if (isPng(buf)) return 'image/png';
  if (isJpeg(buf)) return 'image/jpeg';
  throw new HttpError(400, 'Thumbnails must be WebP, PNG or JPEG.');
}

function checkAvatar(buf: Buffer): string {
  if (buf.length > AVATAR_MAX_BYTES) throw new HttpError(413, 'That image is too large.');
  if (isWebp(buf)) {
    if (buf.includes(Buffer.from('ANIM'))) throw new HttpError(400, 'Animated images aren’t supported.');
    return 'image/webp';
  }
  if (isPng(buf)) {
    if (buf.includes(Buffer.from('acTL'))) throw new HttpError(400, 'Animated images aren’t supported.');
    return 'image/png';
  }
  if (isJpeg(buf)) return 'image/jpeg';
  throw new HttpError(400, 'Use a PNG, JPEG or WebP image.');
}

function safeNext(next: string | null | undefined) {
  return next && /^\/(?![/\\])/.test(next) ? next.slice(0, 200) : '/app';
}

function ownRoom(req: Req, id: string) {
  const u = requireUser(req);
  const row = db.prepare('SELECT owner_id FROM rooms WHERE id = ?').get(id) as { owner_id: string } | undefined;
  if (!row) throw new HttpError(404, 'That canvas doesn’t exist.');
  if (row.owner_id !== u.id) throw new HttpError(403, 'Only the owner can do that.');
  return u;
}

function login(res: Res, user: UserRow) {
  setCookie(res, COOKIE, createSession(user.id), SESSION_MS / 1000);
}

function profileChanged(userId: string) {
  for (const r of roomsWithUser(userId)) r.profileChanged();
  notifyFriends(userId);
}

function sendImage(res: Res, buf: Uint8Array | null | undefined, type: string, cache: string) {
  if (!buf) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': `${cache}, max-age=31536000, immutable` });
  res.end(Buffer.from(buf));
}

async function route(req: Req, res: Res) {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const m = req.method ?? 'GET';
  securityHeaders(res);

  if (p === '/healthz') return json(res, 200, { ok: true });
  const host = String(req.headers.host ?? '');
  const canonical = new URL(config.publicUrl).host;
  if (config.production && host === 'www.' + canonical) {
    res.writeHead(301, { Location: config.publicUrl + (req.url ?? '/') });
    return res.end();
  }
  const api = p.startsWith('/api/') || p.startsWith('/auth/');
  if (api) {
    if (m !== 'GET' && m !== 'HEAD' && !sameSite(req)) throw new HttpError(403, 'Blocked.');
    limit('ip:' + clientIp(req), 600, MINUTE);
  }

  // ---- Auth ----
  if (p === '/api/config' && m === 'GET') {
    return json(res, 200, { discord: !!config.discord, devLogin: config.devLogin, linkPlatforms: LINK_PLATFORMS.map((x) => x.id), downloads: config.downloads });
  }
  if (p === '/auth/discord' && m === 'GET') {
    if (!config.discord) return json(res, 503, { error: 'Discord login isn’t set up on this server yet.' });
    const state = crypto.randomBytes(16).toString('base64url');
    setCookie(res, 'dw_oauth', state + '|' + safeNext(url.searchParams.get('next')), 600);
    const q = new URLSearchParams({
      client_id: config.discord.clientId, redirect_uri: config.publicUrl + '/auth/discord/callback',
      response_type: 'code', scope: 'identify', state, prompt: 'none',
    });
    return redirect(res, 'https://discord.com/oauth2/authorize?' + q);
  }
  if (p === '/auth/discord/callback' && m === 'GET') {
    if (!config.discord) return redirect(res, config.clientUrl);
    limit('login:' + clientIp(req), 30, 10 * MINUTE);
    const [state, rawNext] = (cookies(req).dw_oauth ?? '').split('|');
    const next = safeNext(rawNext);
    const failed = config.clientUrl + '/login?error=1&next=' + encodeURIComponent(next);
    const code = url.searchParams.get('code');
    if (!code || !state || state !== url.searchParams.get('state')) return redirect(res, failed);
    const tok = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId, client_secret: config.discord.clientSecret, grant_type: 'authorization_code',
        code, redirect_uri: config.publicUrl + '/auth/discord/callback',
      }),
    });
    if (!tok.ok) return redirect(res, failed);
    const { access_token } = await tok.json() as { access_token: string };
    const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
    if (!me.ok) return redirect(res, failed);
    const d = await me.json() as { id: string; username: string; global_name?: string | null };
    const name = sanitizeDisplayName(d.global_name || d.username).slice(0, 32) || 'Artist';
    const user = findOrCreateUser('discord', d.id, name, d.username);
    login(res, user);
    setCookie(res, 'dw_oauth', '', 0);
    return redirect(res, config.clientUrl + next);
  }
  if (p === '/auth/dev' && m === 'POST') {
    if (!config.devLogin) return json(res, 404, { error: 'Not available.' });
    limit('login:' + clientIp(req), 60, 10 * MINUTE);
    const b = await jsonBody(req);
    const name = sanitizeDisplayName(String(b.name ?? ''));
    const err = validateDisplayName(name);
    if (err) throw new HttpError(400, err, 'name');
    const user = findOrCreateUser('dev', name.toLowerCase(), name, name);
    login(res, user);
    return json(res, 200, myProfile(user));
  }
  if (p === '/auth/guest' && m === 'POST') {
    limit('guest:' + clientIp(req), 20, HOUR);
    const b = await jsonBody(req);
    const name = sanitizeDisplayName(String(b.name ?? ''));
    const err = validateDisplayName(name);
    if (err) throw new HttpError(400, err, 'name');
    const user = createGuest(name);
    login(res, user);
    return json(res, 200, myProfile(user));
  }
  if (p === '/auth/logout' && m === 'POST') {
    const t = cookies(req)[COOKIE];
    if (t) deleteSession(t);
    setCookie(res, COOKIE, '', 0);
    return json(res, 200, { ok: true });
  }

  // ---- Profile ----
  if (p === '/api/me' && m === 'GET') return json(res, 200, myProfile(requireUser(req)));
  if (p === '/api/me' && m === 'PATCH') {
    const u = requireUser(req);
    limit('me:' + u.id, 120, 10 * MINUTE);
    const b = await jsonBody(req);
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (b.displayName !== undefined) {
      const name = sanitizeDisplayName(String(b.displayName));
      const err = validateDisplayName(name);
      if (err) throw new HttpError(400, err, 'displayName');
      sets.push('display_name = ?'); vals.push(name);
    }
    if (b.handle !== undefined && b.handle !== u.handle) {
      const h = String(b.handle).trim().replace(/^@/, '');
      if (u.provider === 'guest') {
        if (!isRandomHandle(h)) throw new HttpError(403, 'Log in with Discord to pick your own handle.', 'handle');
      } else {
        const herr = handleError(h);
        if (herr) throw new HttpError(400, herr, 'handle');
      }
      if (handleTaken(h, u.id)) throw new HttpError(409, `@${h} is taken. Try another.`, 'handle');
      sets.push('handle = ?'); vals.push(h);
    }
    if (b.favoriteColor !== undefined) {
      const c = normalizeColor(String(b.favoriteColor));
      if (!c) throw new HttpError(400, 'Use a 6-digit hex colour like #f4c25b.', 'favoriteColor');
      sets.push('favorite_color = ?'); vals.push(c);
    }
    if (b.links !== undefined) {
      if (typeof b.links !== 'object' || !b.links) throw new HttpError(400, 'Invalid links.', 'links');
      const links: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.links as Record<string, unknown>)) {
        const n = normalizeLink(k, String(v ?? ''));
        if (n === null) throw new HttpError(400, `That ${LINK_PLATFORMS.find((x) => x.id === k)?.label ?? k} name doesn’t look right.`, 'link:' + k);
        if (n) links[k] = n;
      }
      sets.push('links = ?'); vals.push(JSON.stringify(links));
    }
    if (b.theme !== undefined) {
      const t = String(b.theme);
      if (!THEMES.some((x) => x.id === t)) throw new HttpError(400, 'Unknown theme.', 'theme');
      if (!canUseTheme(t, isPremium(u))) throw new HttpError(403, 'That theme is part of premium.', 'theme');
      sets.push('theme = ?'); vals.push(t);
    }
    if (b.status !== undefined) {
      const st = cleanStatus(String(b.status ?? ''));
      if (st === null) throw new HttpError(400, `Keep your status to ${STATUS_MAX} characters.`, 'status');
      sets.push('status = ?'); vals.push(st);
    }
    if (b.gradient !== undefined) {
      if (b.gradient === null) { sets.push('gradient = NULL'); }
      else {
        if (!isPremium(u)) throw new HttpError(403, 'Name gradients are part of premium.', 'gradient');
        const g = Array.isArray(b.gradient) ? b.gradient.map((c) => normalizeColor(String(c))) : [];
        if (g.length !== 2 || g.some((c) => !c)) throw new HttpError(400, 'Pick two colours for the gradient.', 'gradient');
        sets.push('gradient = ?'); vals.push(g.join(','));
      }
    }
    if (b.presenceMode !== undefined) {
      const pm = String(b.presenceMode);
      if (!PRESENCE_MODES.includes(pm as PresenceMode)) throw new HttpError(400, 'Unknown status.', 'presenceMode');
      sets.push('presence_mode = ?'); vals.push(pm);
    }
    if (b.done === true) sets.push('needs_setup = 0');
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, u.id);
    profileChanged(u.id);
    return json(res, 200, myProfile(getUser(u.id)!));
  }
  if (p === '/api/me/avatar' && (m === 'PUT' || m === 'DELETE')) {
    const u = requireUser(req);
    if (m === 'DELETE') db.prepare('UPDATE users SET avatar = NULL, avatar_type = NULL WHERE id = ?').run(u.id);
    else {
      limit('upload:' + u.id, 30, HOUR);
      const buf = await body(req, AVATAR_MAX_BYTES);
      const type = checkAvatar(buf);
      db.prepare('UPDATE users SET avatar = ?, avatar_type = ?, avatar_version = avatar_version + 1 WHERE id = ?').run(buf, type, u.id);
    }
    profileChanged(u.id);
    return json(res, 200, myProfile(getUser(u.id)!));
  }
  if (p === '/api/me/avatar-animated' && (m === 'PUT' || m === 'DELETE')) {
    const u = requireUser(req);
    if (m === 'DELETE') db.prepare('UPDATE users SET avatar_anim = NULL WHERE id = ?').run(u.id);
    else {
      if (!isPremium(u)) throw new HttpError(403, 'Animated pictures are part of premium.');
      limit('upload:' + u.id, 30, HOUR);
      const buf = await body(req, AVATAR_ANIM_MAX_BYTES);
      const size = gifSize(buf);
      if (!size) throw new HttpError(400, 'Animated pictures need to be GIFs.');
      if (size.w > AVATAR_ANIM_MAX_SIZE || size.h > AVATAR_ANIM_MAX_SIZE) throw new HttpError(400, `Use a GIF up to ${AVATAR_ANIM_MAX_SIZE} × ${AVATAR_ANIM_MAX_SIZE} pixels.`);
      db.prepare('UPDATE users SET avatar_anim = ?, avatar_anim_version = avatar_anim_version + 1 WHERE id = ?').run(buf, u.id);
    }
    profileChanged(u.id);
    return json(res, 200, myProfile(getUser(u.id)!));
  }
  if (p === '/api/handle/random' && m === 'GET') {
    if (requireUser(req).provider !== 'guest') throw new HttpError(403, 'Pick any handle you like.');
    return json(res, 200, { handle: freeHandle() });
  }
  if (p === '/api/handle/check' && m === 'GET') {
    const u = requireUser(req);
    limit('handle:' + u.id, 120, MINUTE);
    const h = (url.searchParams.get('h') ?? '').trim().replace(/^@/, '');
    const error = handleError(h);
    const available = !error && !handleTaken(h, u.id);
    return json(res, 200, { valid: !error, available, error: error ?? (available ? null : `@${h} is taken.`) });
  }
  let mm = /^\/avatars\/([\w-]+)$/.exec(p);
  if (mm && m === 'GET') {
    const row = db.prepare('SELECT avatar, avatar_type FROM users WHERE id = ?').get(mm[1]) as { avatar: Uint8Array | null; avatar_type: string } | undefined;
    return sendImage(res, row?.avatar, row?.avatar_type ?? '', 'public');
  }
  mm = /^\/avatars\/([\w-]+)\/anim$/.exec(p);
  if (mm && m === 'GET') {
    const row = db.prepare('SELECT avatar_anim FROM users WHERE id = ?').get(mm[1]) as { avatar_anim: Uint8Array | null } | undefined;
    return sendImage(res, row?.avatar_anim, 'image/gif', 'public');
  }

  // ---- Friends ----
  if (p === '/api/friends' && m === 'GET') return json(res, 200, listFriends(requireUser(req).id));
  if (p === '/api/friends' && m === 'POST') {
    const u = requireMember(req, 'add friends');
    limit('friend:' + u.id, 60, HOUR);
    const b = await jsonBody(req);
    try { return json(res, 200, { result: requestFriend(u, String(b.handle ?? '')), ...listFriends(u.id) }); }
    catch (e) { if (e instanceof FriendError) throw new HttpError(e.status, e.message, 'handle'); throw e; }
  }
  mm = /^\/api\/friends\/([\w-]+)(\/accept)?$/.exec(p);
  if (mm && (m === 'POST' || m === 'DELETE')) {
    const u = requireMember(req, 'add friends');
    try {
      if (m === 'POST' && mm[2]) acceptFriend(u.id, mm[1]);
      else if (m === 'DELETE' && !mm[2]) removeFriend(u.id, mm[1]);
      else return json(res, 404, { error: 'Not found.' });
    } catch (e) { if (e instanceof FriendError) throw new HttpError(e.status, e.message); throw e; }
    return json(res, 200, listFriends(u.id));
  }
  if (p === '/api/events' && m === 'GET') {
    const u = requireUser(req);
    if (streamCount(u.id) >= 8) throw new HttpError(429, 'Too many open tabs.');
    openStream(u.id, res, (connected) => {
      if (connected) { notifyFriends(u.id); return; }
      setTimeout(() => {
        if (isConnected(u.id) || roomsWithUser(u.id).length) return;
        forget(u.id);
        notifyFriends(u.id);
      }, 15_000);
    });
    return;
  }
  mm = /^\/api\/users\/([\w-]+)$/.exec(p);
  if (mm && m === 'GET') {
    requireUser(req);
    const u = getUser(mm[1]);
    return u ? json(res, 200, publicProfile(u)) : json(res, 404, { error: 'Not found.' });
  }

  // ---- Rooms ----
  if (p === '/api/rooms' && m === 'POST') {
    const u = requireMember(req, 'make your own canvases');
    limit('rooms:' + u.id, 30, HOUR);
    const b = await jsonBody(req);
    const s = (b.settings ?? {}) as Record<string, unknown>;
    const infinite = !!s.infinite;
    const width = Math.round(Number(s.width)), height = Math.round(Number(s.height));
    if (!infinite && !(width >= 16 && height >= 16 && width <= 16384 && height <= 16384 && width * height <= 100e6)) throw new HttpError(400, 'Invalid canvas size.');
    const bg = s.background === null ? null : normalizeColor(String(s.background ?? '#ffffff'));
    const name = sanitizeDisplayName(String(b.name ?? '')).slice(0, ROOM_NAME_MAX) || `${u.display_name}’s room`;
    const share = cleanShare(b.share ?? (b.private ? { visibility: 'private' } : undefined));
    const info = createRoom(u, name, { id: '', width: infinite ? 2048 : width, height: infinite ? 2048 : height, infinite, background: bg }, share);
    return json(res, 200, info);
  }
  if (p === '/api/projects' && m === 'GET') return json(res, 200, projectsOf(requireUser(req).id));
  mm = /^\/api\/rooms\/([a-z0-9]+)\/thumb$/.exec(p);
  if (mm && m === 'PUT') {
    const u = ownRoom(req, mm[1]);
    limit('thumb:' + u.id, 120, HOUR);
    const buf = await body(req, 96 * 1024);
    checkThumb(buf);
    db.prepare('UPDATE rooms SET thumb = ?, thumb_version = thumb_version + 1 WHERE id = ?').run(buf, mm[1]);
    return json(res, 200, { ok: true });
  }
  mm = /^\/thumbs\/([a-z0-9]+)$/.exec(p);
  if (mm && m === 'GET') {
    ownRoom(req, mm[1]);
    const row = db.prepare('SELECT thumb FROM rooms WHERE id = ?').get(mm[1]) as { thumb: Uint8Array | null };
    return sendImage(res, row.thumb, row.thumb ? checkThumb(Buffer.from(row.thumb)) : '', 'private');
  }
  mm = /^\/api\/rooms\/([a-z0-9]+)\/invite$/.exec(p);
  if (mm && m === 'POST') {
    const u = requireMember(req, 'invite friends');
    const r = getRoom(mm[1]);
    if (!r || !r.isHost(u.id)) throw new HttpError(403, 'Only hosts can invite people.');
    if (r.info.private) throw new HttpError(409, 'Share this canvas first.');
    limit('invite:' + u.id, 60, 10 * MINUTE);
    const b = await jsonBody(req);
    const to = String(b.user ?? '');
    if (!areFriends(u.id, to)) throw new HttpError(403, 'You can only invite friends.');
    r.invite(to);
    sendTo(to, { type: 'invite', room: { id: r.info.id, name: r.info.name }, from: { id: u.id, displayName: u.display_name } });
    return json(res, 200, { ok: true });
  }
  mm = /^\/api\/rooms\/([a-z0-9]+)$/.exec(p);
  if (mm && m === 'PATCH') {
    ownRoom(req, mm[1]);
    const b = await jsonBody(req);
    const patch: { name?: string; share?: ShareSettings } = {};
    if (b.name !== undefined) {
      const name = sanitizeDisplayName(String(b.name)).slice(0, ROOM_NAME_MAX);
      if (!name) throw new HttpError(400, 'Give it a name.', 'name');
      patch.name = name;
      db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name, mm[1]);
    }
    if (b.share !== undefined || typeof b.private === 'boolean') {
      const cur = getRoom(mm[1])!.info.share;
      patch.share = cleanShare(b.share ?? { ...cur, visibility: b.private ? 'private' : cur.visibility === 'private' ? 'open' : cur.visibility });
      saveShare(mm[1], patch.share);
    }
    getRoom(mm[1])!.updateInfo(patch);
    return json(res, 200, getRoom(mm[1])!.info);
  }
  if (mm && m === 'DELETE') {
    ownRoom(req, mm[1]);
    deleteRoom(mm[1]);
    return json(res, 200, { ok: true });
  }
  if (mm && m === 'GET') {
    const u = requireUser(req);
    const r = getRoom(mm[1]);
    if (!r || (r.info.private && r.info.ownerId !== u.id)) return json(res, 404, { error: 'That room doesn’t exist.' });
    const owner = getUser(r.info.ownerId);
    return json(res, 200, { ...r.info, owner: owner ? publicProfile(owner) : null, online: r.members().length });
  }

  if ((m === 'GET' || m === 'HEAD') && !api && fs.existsSync(config.staticDir)) return serveStatic(req, res, p, m);
  json(res, 404, { error: 'Not found.' });
}

// ---- Static files (production) ----

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const COMPRESSIBLE = /\.(html|js|css|svg|json)$/;
interface Cached { mtime: number; etag: string; raw: Buffer; gz: Buffer | null }
const fileCache = new Map<string, Cached>();

function loadFile(file: string): Cached | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = fileCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const c: Cached = { mtime: st.mtimeMs, etag: `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(36)}"`, raw, gz: COMPRESSIBLE.test(file) ? zlib.gzipSync(raw, { level: 9 }) : null };
  if (fileCache.size > 200) fileCache.clear();
  fileCache.set(file, c);
  return c;
}

function serveStatic(req: Req, res: Res, p: string, m: string) {
  const dir = config.staticDir;
  const file = path.join(dir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  // Pages sit at the top of dist/: / is the landing page, /login the login page, /app (and sub-paths) the app.
  const page = p === '/app' || p.startsWith('/app/') ? 'app.html' : p === '/login' || p === '/login/' ? 'login.html' : 'index.html';
  const target = file.startsWith(dir + path.sep) && !p.endsWith('/') ? file : '';
  const c = (target && loadFile(target)) || loadFile(path.join(dir, page));
  if (!c) {
    console.error(`Missing page ${page} in ${dir}. Was "npm run build" run?`);
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('Doodlehive is updating. Please try again in a minute.');
  }
  const served = target && c === fileCache.get(target) ? target : page;
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[path.extname(served)] ?? 'application/octet-stream',
    'Cache-Control': served.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: c.etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
  const gz = c.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ? c.gz : null;
  if (gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = (gz ?? c.raw).length;
  res.writeHead(200, headers);
  res.end(m === 'HEAD' ? undefined : gz ?? c.raw);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, field: e.field });
    console.error(e);
    json(res, 500, { error: 'Something went wrong on the server.' });
  });
});

const ORIGINS = new Set([config.publicUrl, config.clientUrl]);
const wss = new WebSocketServer({
  noServer: true, maxPayload: 8 * 1024 * 1024,
  perMessageDeflate: { threshold: 2048, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: { level: 4 }, concurrencyLimit: 4 },
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = /^\/ws\/([a-z0-9]+)$/.exec(url.pathname);
  const user = sessionUser(cookies(req)[COOKIE]);
  const room = m && getRoom(m[1]);
  const origin = req.headers.origin;
  const watch = url.searchParams.get('watch') ?? undefined;
  const ok = m && user && room && (!origin || ORIGINS.has(origin)) && (watch === undefined || WATCH_KEY_RE.test(watch))
    && allow('ws:' + clientIp(req), 60, MINUTE) && room.connections(user.id) < 6;
  if (!ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); room.join(ws, user, watch); });
});

setInterval(() => {
  for (const ws of wss.clients) {
    const w = ws as typeof ws & { alive?: boolean };
    if (w.alive === false) { ws.terminate(); continue; }
    w.alive = false;
    ws.ping();
  }
}, 30_000);
wss.on('connection', (ws) => { const w = ws as typeof ws & { alive?: boolean }; w.alive = true; ws.on('pong', () => { w.alive = true; }); });

function sweep() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare(`DELETE FROM users WHERE provider = 'guest' AND created_at < ? AND id NOT IN (SELECT user_id FROM sessions)`).run(now - 30 * 864e5);
}
sweep();
setInterval(sweep, HOUR).unref();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    for (const ws of wss.clients) ws.close(1012, 'Server restarting');
    closeAllStreams();
    server.close();
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}

server.listen(config.port, () => {
  console.log(`Doodlehive server on ${config.publicUrl}`);
  if (!config.persistent) console.warn('  WARNING: no volume attached; accounts and rooms will be lost on the next deploy.');
  if (config.production && config.devLogin) console.warn('  WARNING: dev login is on in production. Anyone can log in as anyone. Unset DEV_LOGIN.');
  console.log(`  Discord login: ${config.discord ? 'on' : 'off (set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET)'}`);
  console.log(`  Dev login: ${config.devLogin ? 'on' : 'off'}`);
  console.log(`  Database: ${config.dbPath}`);
  const pages = ['index.html', 'login.html', 'app.html'].map((f) => `${f} ${fs.existsSync(path.join(config.staticDir, f)) ? 'ok' : 'MISSING'}`);
  console.log(`  Pages in ${config.staticDir}: ${pages.join(', ')}`);
  if (path.resolve(config.dbPath).startsWith(path.resolve(config.staticDir) + path.sep)) {
    console.warn('  WARNING: the database is inside the web build folder. Mount the volume at /data instead.');
  }
});
