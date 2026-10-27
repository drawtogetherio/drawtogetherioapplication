import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { config } from './config.ts';
import {
  SESSION_MS, createGuest, createSession, db, deleteSession, findOrCreateUser, freeHandle, getAsset, getSite, getUser, getWhatsNew, handleTaken, hasAsset, isAdmin, isPremium, keepGuest, myProfile, publicProfile, putAsset, sessionUser, userByHandle, UserRow,
} from './db.ts';
import { Room, cleanShare, createRoom, deleteRoom, flushOps, getRoom, projectsOf, resumeEphemeral, roomsWithUser, saveShare, visited, visitsOf } from './rooms.ts';
import { validOp } from './validate.ts';
import type { Op } from '../src/core/model.ts';
import { HiveFileError, canvasOps, unzip } from '../src/shared/hivecanvas.ts';
import { FriendError, acceptFriend, areFriends, blockUser, forget, listBlocked, listFriends, notifyFriends, removeFriend, requestFriend, touch, unblockUser } from './social.ts';
import { closeAllStreams, isConnected, openStream, sendTo, streamCount } from './live.ts';
import { clearNotices, listNotices, notify, premiumWarning, readNotices } from './notify.ts';
import { sweep } from './sweep.ts';
import { checkMedia, deleteMedia, mediaOn, mediaUrl, newMediaKey, putMedia } from './media.ts';
import { movePicturesToMedia } from './media-move.ts';
import { restart, snapshot, syncDue } from './sync.ts';
import { allow, clientIp, sameSite, securityHeaders } from './guard.ts';
import { HttpError, Req, Res, body, json, jsonBody } from './http.ts';
import { adminRoute, bannedIp, lastIp } from './admin-api.ts';
import { flushStats } from './stats.ts';
import { authorizeUrl, linkPatreon, patreonEnabled, refreshPatreon, unlinkPatreon } from './patreon.ts';
import {
  AVATAR_ANIM_MAX_BYTES, AVATAR_ANIM_MAX_SIZE, AVATAR_MAX_BYTES, BANNER_MAX_BYTES, LINK_PLATFORMS, PINNED_MAX, cleanCrop, STATUS_MAX, cleanPinned, cleanStatus, handleError, PRESENCE_MODES, type PresenceMode, isRandomHandle, normalizeColor, normalizeLink, sanitizeDisplayName, validateDisplayName,
} from '../src/shared/profile.ts';
import { ROOM_NAME_MAX, WATCH_KEY_RE, type ShareSettings } from '../src/shared/protocol.ts';
import { cleanPrefs } from '../src/shared/prefs.ts';
import { MAX_ASSET_BYTES, MAX_ASSET_SIZE, pngSize } from '../src/shared/brushAssets.ts';
import { canUseTheme, isTheme } from '../src/shared/themes.ts';


const COOKIE = 'dw_session';
const MINUTE = 60_000, HOUR = 3600_000;
const HIVECANVAS_MAX_BYTES = 64 * 1024 * 1024;
/** Only ever reads parts of an uploaded .hivecanvas, never more than they say they hold. */
const inflateRaw = async (d: Uint8Array, max: number) => {
  try { return max ? new Uint8Array(zlib.inflateRawSync(d, { maxOutputLength: max })) : new Uint8Array(); } catch { throw new HiveFileError('That file is damaged.'); }
};

function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** No max age makes a browser-session cookie, gone when the browser closes. */
function setCookie(res: Res, name: string, value: string, maxAgeSec?: number) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...(maxAgeSec === undefined ? [] : [`Max-Age=${maxAgeSec}`])];
  if (config.secureCookies) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join('; ')]);
}

function redirect(res: Res, to: string) { res.writeHead(302, { Location: to }); res.end(); }


function limit(key: string, n: number, windowMs: number) {
  if (!allow(key, n, windowMs)) throw new HttpError(429, 'Too many requests. Try again in a bit.');
}

function requireUser(req: Req): UserRow {
  const u = sessionUser(cookies(req)[COOKIE]);
  if (!u) throw new HttpError(401, 'Please log in.');
  if (u.banned) throw new HttpError(403, 'This account is banned.');
  touch(u.id);
  keepGuest(u);
  lastIp(u.id, clientIp(req));
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

/** A still PNG, JPEG or WebP within `max` bytes; returns its type. */
function checkAvatar(buf: Buffer, max = AVATAR_MAX_BYTES): string {
  if (buf.length > max) throw new HttpError(413, 'That image is too large.');
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
  setCookie(res, COOKIE, createSession(user), user.provider === 'guest' ? undefined : SESSION_MS / 1000);
}

function profileChanged(userId: string) {
  for (const r of roomsWithUser(userId)) r.profileChanged();
  notifyFriends(userId);
}

/** Puts an upload on R2 when that's set up and returns its key; null means it goes in the database. */
async function storePicture(userId: string, kind: string, buf: Buffer, type: string): Promise<string | null> {
  if (!mediaOn) return null;
  const key = newMediaKey(kind, userId);
  try { await putMedia(key, buf, type); } catch (e) { console.error(e); throw new HttpError(503, 'Couldn’t save the picture. Try again in a moment.'); }
  return key;
}

/** Old links to a picture that has moved to R2 follow it there. */
function sendMoved(res: Res, key: string) { res.writeHead(301, { Location: mediaUrl(key), 'Cache-Control': 'public, max-age=86400' }); res.end(); }

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
  if (p === '/api/sync/snapshot' && m === 'GET') {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(config.sync.secret ?? '');
    if (config.beta || !config.sync.secret || !allow('sync:' + clientIp(req), 10, HOUR) || given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(404, 'Not found.');
    flushOps();
    const gz = snapshot(db);
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': gz.length, 'Cache-Control': 'no-store' });
    return res.end(gz);
  }
  if (bannedIp(clientIp(req))) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Blocked.'); }
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
    const site = getSite();
    return json(res, 200, { beta: config.beta, discord: !!config.discord, devLogin: config.devLogin, linkPlatforms: LINK_PLATFORMS.map((x) => x.id), downloads: config.downloads, patreon: config.patreon, patreonLink: patreonEnabled(), discordInvite: config.discordInvite || undefined, notice: site.notice.on ? site.notice : null });
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
    if (user.banned) return redirect(res, config.clientUrl + '/login?error=banned');
    login(res, user);
    setCookie(res, 'dw_oauth', '', 0);
    return redirect(res, config.clientUrl + next);
  }
  // ---- Patreon linking (for a logged-in account) ----
  if (p === '/auth/patreon' && m === 'GET') {
    const u = requireUser(req);
    if (!patreonEnabled()) return json(res, 503, { error: 'Patreon linking isn’t set up on this server yet.' });
    if (u.provider === 'guest') throw new HttpError(403, 'Log in with Discord to link Patreon.');
    const state = crypto.randomBytes(16).toString('base64url');
    setCookie(res, 'dw_oauth', state + '|' + safeNext(url.searchParams.get('next')), 600);
    return redirect(res, authorizeUrl(state));
  }
  if (p === '/auth/patreon/callback' && m === 'GET') {
    const u = requireUser(req);
    const [state, rawNext] = (cookies(req).dw_oauth ?? '').split('|');
    const next = safeNext(rawNext);
    const code = url.searchParams.get('code');
    const result = patreonEnabled() && code && state && state === url.searchParams.get('state') ? await linkPatreon(u, code) : 'failed';
    setCookie(res, 'dw_oauth', '', 0);
    return redirect(res, config.clientUrl + next + (next.includes('?') ? '&' : '?') + 'patreon=' + result);
  }
  if (p === '/api/me/patreon' && (m === 'POST' || m === 'DELETE')) {
    const u = requireUser(req);
    limit('patreon:' + u.id, 20, HOUR);
    if (m === 'DELETE') unlinkPatreon(u.id);
    const fresh = m === 'POST' ? await refreshPatreon(u, true) : getUser(u.id)!;
    profileChanged(u.id);
    return json(res, 200, myProfile(fresh));
  }
  if (p === '/auth/dev' && m === 'POST') {
    if (!config.devLogin) return json(res, 404, { error: 'Not available.' });
    limit('login:' + clientIp(req), 60, 10 * MINUTE);
    const b = await jsonBody(req);
    const name = sanitizeDisplayName(String(b.name ?? ''));
    const err = validateDisplayName(name);
    if (err) throw new HttpError(400, err, 'name');
    const user = findOrCreateUser('dev', name.toLowerCase(), name, name);
    if (user.banned) throw new HttpError(403, 'This account is banned.');
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
  // Brush images: anyone may fetch one by id (they're content-addressed, so cache forever); a session may store one.
  const asset = /^\/api\/brush-assets\/([0-9a-f]{32})$/.exec(p);
  if (asset && m === 'GET') {
    const data = getAsset(asset[1]);
    if (!data) throw new HttpError(404, 'No such brush image.');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(Buffer.from(data));
    return;
  }
  if (asset && m === 'PUT') {
    const u = requireUser(req);
    if (hasAsset(asset[1])) return json(res, 200, { ok: true });
    limit('asset:' + u.id, 200, HOUR);
    const buf = await body(req, MAX_ASSET_BYTES);
    const size = pngSize(buf);
    if (!size || size.w > MAX_ASSET_SIZE || size.h > MAX_ASSET_SIZE || buf.includes(Buffer.from('acTL'))) throw new HttpError(400, 'A brush image is a still PNG up to 256 px.');
    if (crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) !== asset[1]) throw new HttpError(400, 'The id doesn’t match the image.');
    putAsset(asset[1], buf, u.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'GET') {
    const u = requireUser(req);
    // A stale patron status is refreshed in the background; the next load shows it.
    void refreshPatreon(u).then((f) => { if (f !== u) profileChanged(u.id); });
    return json(res, 200, myProfile(u));
  }
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
      if (!c) throw new HttpError(400, 'Use a 6-digit hex colour like #fdb302.', 'favoriteColor');
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
      if (!isTheme(t)) throw new HttpError(400, 'Unknown theme.', 'theme');
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
    if (b.prefs !== undefined) {
      if (!b.prefs || typeof b.prefs !== 'object') throw new HttpError(400, 'Invalid preferences.', 'prefs');
      sets.push('prefs = ?'); vals.push(JSON.stringify(cleanPrefs(b.prefs)));
    }
    if (b.pinned !== undefined) {
      if (!Array.isArray(b.pinned) || b.pinned.length > PINNED_MAX) throw new HttpError(400, `Pin up to ${PINNED_MAX} canvases.`, 'pinned');
      const ids = cleanPinned(b.pinned);
      const owned = (db.prepare(`SELECT id FROM rooms WHERE owner_id = ? AND ephemeral = 0`).all(u.id) as { id: string }[]).map((r) => r.id);
      if (ids.length !== b.pinned.length || ids.some((id) => !owned.includes(id))) throw new HttpError(400, 'You can only pin your own canvases.', 'pinned');
      sets.push('pinned = ?'); vals.push(JSON.stringify(ids));
    }
    if (b.done === true) sets.push('needs_setup = 0');
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, u.id);
    profileChanged(u.id);
    return json(res, 200, myProfile(getUser(u.id)!));
  }
  if (p === '/api/me/avatar' && (m === 'PUT' || m === 'DELETE')) {
    const u = requireUser(req);
    if (m === 'DELETE') db.prepare('UPDATE users SET avatar = NULL, avatar_key = NULL, avatar_type = NULL, avatar_anim = NULL, avatar_anim_key = NULL, avatar_anim_crop = NULL WHERE id = ?').run(u.id);
    else {
      limit('upload:' + u.id, 30, HOUR);
      const buf = await body(req, AVATAR_MAX_BYTES);
      const type = checkAvatar(buf);
      const key = await storePicture(u.id, 'avatar', buf, type);
      // A new still replaces a GIF too; a GIF upload follows its still.
      db.prepare('UPDATE users SET avatar = ?, avatar_key = ?, avatar_type = ?, avatar_version = avatar_version + 1, avatar_anim = NULL, avatar_anim_key = NULL, avatar_anim_crop = NULL WHERE id = ?').run(key ? null : buf, key, type, u.id);
    }
    deleteMedia(u.avatar_key, u.avatar_anim_key);
    profileChanged(u.id);
    return json(res, 200, myProfile(getUser(u.id)!));
  }
  if (p === '/api/me/avatar-animated' && (m === 'PUT' || m === 'DELETE')) {
    const u = requireUser(req);
    if (m === 'DELETE') db.prepare('UPDATE users SET avatar_anim = NULL, avatar_anim_key = NULL WHERE id = ?').run(u.id);
    else {
      if (!isPremium(u)) throw new HttpError(403, 'Animated pictures are part of premium.');
      limit('upload:' + u.id, 30, HOUR);
      const buf = await body(req, AVATAR_ANIM_MAX_BYTES);
      const size = gifSize(buf);
      if (!size) throw new HttpError(400, 'Animated pictures need to be GIFs.');
      if (size.w > AVATAR_ANIM_MAX_SIZE || size.h > AVATAR_ANIM_MAX_SIZE) throw new HttpError(400, `Use a GIF up to ${AVATAR_ANIM_MAX_SIZE} × ${AVATAR_ANIM_MAX_SIZE} pixels.`);
      const crop = cleanCrop(Object.fromEntries(['x', 'y', 'w', 'h'].map((k) => [k, Number(url.searchParams.get(k))])));
      const key = await storePicture(u.id, 'anim', buf, 'image/gif');
      db.prepare('UPDATE users SET avatar_anim = ?, avatar_anim_key = ?, avatar_anim_crop = ?, avatar_anim_version = avatar_anim_version + 1 WHERE id = ?').run(key ? null : buf, key, crop ? JSON.stringify(crop) : null, u.id);
    }
    deleteMedia(u.avatar_anim_key);
    profileChanged(u.id);
    return json(res, 200, myProfile(getUser(u.id)!));
  }
  if (p === '/api/me/banner' && (m === 'PUT' || m === 'DELETE')) {
    const u = requireUser(req);
    if (m === 'DELETE') db.prepare('UPDATE users SET banner = NULL, banner_key = NULL, banner_type = NULL WHERE id = ?').run(u.id);
    else {
      limit('upload:' + u.id, 30, HOUR);
      const buf = await body(req, BANNER_MAX_BYTES);
      const type = checkAvatar(buf, BANNER_MAX_BYTES);
      const key = await storePicture(u.id, 'banner', buf, type);
      db.prepare('UPDATE users SET banner = ?, banner_key = ?, banner_type = ?, banner_version = banner_version + 1 WHERE id = ?').run(key ? null : buf, key, type, u.id);
    }
    deleteMedia(u.banner_key);
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
    const row = db.prepare('SELECT avatar, avatar_key, avatar_type FROM users WHERE id = ?').get(mm[1]) as { avatar: Uint8Array | null; avatar_key: string | null; avatar_type: string } | undefined;
    if (row?.avatar_key) return sendMoved(res, row.avatar_key);
    return sendImage(res, row?.avatar, row?.avatar_type ?? '', 'public');
  }
  mm = /^\/avatars\/([\w-]+)\/banner$/.exec(p);
  if (mm && m === 'GET') {
    const row = db.prepare('SELECT banner, banner_key, banner_type FROM users WHERE id = ?').get(mm[1]) as { banner: Uint8Array | null; banner_key: string | null; banner_type: string } | undefined;
    if (row?.banner_key) return sendMoved(res, row.banner_key);
    return sendImage(res, row?.banner, row?.banner_type ?? '', 'public');
  }
  mm = /^\/avatars\/([\w-]+)\/anim$/.exec(p);
  if (mm && m === 'GET') {
    const row = db.prepare('SELECT avatar_anim, avatar_anim_key FROM users WHERE id = ?').get(mm[1]) as { avatar_anim: Uint8Array | null; avatar_anim_key: string | null } | undefined;
    if (row?.avatar_anim_key) return sendMoved(res, row.avatar_anim_key);
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
  if (p === '/api/blocks' && m === 'GET') return json(res, 200, listBlocked(requireUser(req).id));
  if (p === '/api/blocks' && m === 'POST') {
    const u = requireMember(req, 'block people');
    const b = await jsonBody(req);
    try { blockUser(u, String(b.user ?? '')); } catch (e) { if (e instanceof FriendError) throw new HttpError(e.status, e.message); throw e; }
    return json(res, 200, listBlocked(u.id));
  }
  mm = /^\/api\/blocks\/([\w-]+)$/.exec(p);
  if (mm && m === 'DELETE') { const u = requireUser(req); unblockUser(u.id, mm[1]); return json(res, 200, listBlocked(u.id)); }
  if (p === '/api/whatsnew' && m === 'GET') return json(res, 200, getWhatsNew());
  if (p === '/api/notices' && m === 'GET') {
    const u = requireUser(req);
    premiumWarning(u);
    return json(res, 200, listNotices(u.id));
  }
  if (p === '/api/notices/read' && m === 'POST') { readNotices(requireUser(req).id); return json(res, 200, { ok: true }); }
  if (p === '/api/notices' && m === 'DELETE') { clearNotices(requireUser(req).id); return json(res, 200, { ok: true }); }
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

  if (p.startsWith('/api/admin/')) return adminRoute(req, res, url, requireUser(req), profileChanged);

  // ---- Rooms ----
  if (p === '/api/rooms' && m === 'POST') {
    const u = requireMember(req, 'make your own canvases');
    limit('rooms:' + u.id, 30, HOUR);
    const b = await jsonBody(req, 48 * 1024 * 1024);
    const ops = Array.isArray(b.ops) ? b.ops : [];
    if (ops.length > 200_000 || !ops.every(validOp)) throw new HttpError(400, 'That canvas can’t be uploaded.');
    const s = (b.settings ?? {}) as Record<string, unknown>;
    const infinite = !!s.infinite;
    const width = Math.round(Number(s.width)), height = Math.round(Number(s.height));
    if (!infinite && !(width >= 16 && height >= 16 && width <= 16384 && height <= 16384 && width * height <= 100e6)) throw new HttpError(400, 'Invalid canvas size.');
    const bg = s.background === null ? null : normalizeColor(String(s.background ?? '#ffffff'));
    const name = sanitizeDisplayName(String(b.name ?? '')).slice(0, ROOM_NAME_MAX) || `${u.display_name}’s room`;
    const share = cleanShare(b.share ?? (b.private ? { visibility: 'private' } : undefined));
    // Free accounts keep canvases on their devices; the server only holds a room while it's live.
    const info = createRoom(u, name, { id: '', width: infinite ? 2048 : width, height: infinite ? 2048 : height, infinite, background: bg }, share, !isPremium(u), ops);
    return json(res, 200, info);
  }
  // A .hivecanvas file: the canvas as it looks now, so even long-lived canvases stay a few MB.
  if (p === '/api/rooms/import' && m === 'POST') {
    const u = requireMember(req, 'make your own canvases');
    limit('rooms:' + u.id, 30, HOUR);
    const buf = await body(req, HIVECANVAS_MAX_BYTES);
    let parsed: ReturnType<typeof canvasOps>;
    try {
      parsed = canvasOps(await unzip(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), inflateRaw), () => 'op_' + crypto.randomBytes(9).toString('base64url'));
    } catch (e) {
      if (e instanceof HiveFileError) throw new HttpError(400, e.message);
      throw e;
    }
    const { manifest, ops } = parsed;
    if (ops.length > 200_000 || !ops.every(validOp)) throw new HttpError(400, 'That canvas can’t be uploaded.');
    const s = manifest.settings;
    let shareIn: unknown;
    try { shareIn = JSON.parse(url.searchParams.get('share') ?? 'null'); } catch { throw new HttpError(400, 'Invalid request.'); }
    const share = cleanShare(shareIn ?? { visibility: 'private' });
    const name = sanitizeDisplayName(url.searchParams.get('name') ?? manifest.name).slice(0, ROOM_NAME_MAX) || `${u.display_name}’s room`;
    const info = createRoom(u, name, { id: '', width: s.infinite ? 2048 : s.width, height: s.infinite ? 2048 : s.height, infinite: s.infinite, background: s.background }, share, !isPremium(u), ops);
    return json(res, 200, info);
  }
  if (p === '/api/projects' && m === 'GET') return json(res, 200, projectsOf(requireUser(req).id));
  if (p === '/api/visits' && m === 'GET') return json(res, 200, visitsOf(requireUser(req).id));
  mm = /^\/api\/rooms\/([a-z0-9]+)\/thumb$/.exec(p);
  if (mm && m === 'PUT') {
    const u = ownRoom(req, mm[1]);
    limit('thumb:' + u.id, 120, HOUR);
    const buf = await body(req, 96 * 1024);
    checkThumb(buf);
    db.prepare('UPDATE rooms SET thumb = ?, thumb_version = thumb_version + 1 WHERE id = ?').run(buf, mm[1]);
    return json(res, 200, { ok: true });
  }
  // The owner sees their thumbnail; so does anyone who joined, as long as the room isn't private now.
  mm = /^\/thumbs\/([a-z0-9]+)$/.exec(p);
  if (mm && m === 'GET') {
    const u = requireUser(req);
    const row = db.prepare('SELECT owner_id, visibility, thumb FROM rooms WHERE id = ?').get(mm[1]) as { owner_id: string; visibility: string; thumb: Uint8Array | null } | undefined;
    if (!row) throw new HttpError(404, 'That canvas doesn’t exist.');
    if (row.owner_id !== u.id && (row.visibility === 'private' || !visited(u.id, mm[1]))) throw new HttpError(403, 'Only the owner can do that.');
    return sendImage(res, row.thumb, row.thumb ? checkThumb(Buffer.from(row.thumb)) : '', 'private');
  }
  // A canvas pinned to its owner's profile shows its thumbnail to everyone.
  mm = /^\/pins\/([a-z0-9]+)$/.exec(p);
  if (mm && m === 'GET') {
    const row = db.prepare(`SELECT r.thumb FROM rooms r JOIN users u ON u.id = r.owner_id
      WHERE r.id = ? AND r.visibility <> 'private' AND EXISTS (SELECT 1 FROM json_each(u.pinned) WHERE value = r.id)`).get(mm[1]) as { thumb: Uint8Array | null } | undefined;
    return sendImage(res, row?.thumb, row?.thumb ? checkThumb(Buffer.from(row.thumb)) : '', 'public');
  }
  // The picture on an invite link's embed: the canvas, unless the room is private.
  mm = /^\/og\/([a-z0-9]+)$/.exec(p);
  if (mm && (m === 'GET' || m === 'HEAD')) {
    const room = getRoom(mm[1]);
    const row = room && !room.info.private ? db.prepare('SELECT thumb FROM rooms WHERE id = ?').get(mm[1]) as { thumb: Uint8Array | null } | undefined : undefined;
    if (row?.thumb) { res.writeHead(200, { 'Content-Type': checkThumb(Buffer.from(row.thumb)), 'Cache-Control': 'public, max-age=600' }); return res.end(m === 'HEAD' ? undefined : Buffer.from(row.thumb)); }
    return serveStatic(req, res, '/og.png', m);
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
    notify(to, 'invite', `${u.display_name} invited you to ${r.info.name}`, { room: { id: r.info.id, name: r.info.name }, from: u.id }, `invite-${r.info.id}-${u.id}`);
    return json(res, 200, { ok: true });
  }
  // ---- Hosts: the edit log, a layer's history, and snapshots for fast joins ----
  mm = /^\/api\/rooms\/([a-z0-9]+)\/(log|history|snapshot)$/.exec(p);
  if (mm) {
    const u = requireUser(req);
    const r = getRoom(mm[1]);
    if (!r) throw new HttpError(404, 'That canvas doesn’t exist.');
    if (mm[2] === 'snapshot' && m === 'POST') {
      const b = await jsonBody(req, 96 * 1024 * 1024);
      const ops = Array.isArray(b.ops) ? b.ops as Op[] : [];
      if (ops.length > 20_000) throw new HttpError(400, 'Invalid snapshot.');
      const why = r.takeSnapshot(u.id, Number(b.seq), ops);
      if (why) throw new HttpError(400, why);
      return json(res, 200, { ok: true });
    }
    if (!r.isHost(u.id)) throw new HttpError(403, 'Only hosts can see the edit log.');
    if (mm[2] === 'log' && m === 'GET') return json(res, 200, r.log());
    if (mm[2] === 'history' && m === 'GET') return json(res, 200, r.history(Number(url.searchParams.get('upto') ?? 0), url.searchParams.get('layer')));
  }
  mm = /^\/api\/rooms\/([a-z0-9]+)$/.exec(p);
  if (mm && m === 'PATCH') {
    ownRoom(req, mm[1]);
    const b = await jsonBody(req);
    const patch: { name?: string; share?: ShareSettings; ephemeral?: true } = {};
    // One way: a free owner moves an old server canvas to their device.
    if (b.ephemeral === true) { patch.ephemeral = true; db.prepare('UPDATE rooms SET ephemeral = 1 WHERE id = ?').run(mm[1]); }
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
    if (!r || !r.visibleTo(u)) return json(res, 404, { error: 'Unable to find room' });
    const owner = getUser(r.info.ownerId);
    return json(res, 200, { ...r.info, owner: owner ? publicProfile(owner) : null, online: r.members().length, joinable: r.canJoin(u), invited: r.isHost(u.id) ? r.invitedProfiles() : undefined, visitors: r.isHost(u.id) ? r.visitorProfiles() : undefined });
  }

  if (p === '/admin' || p.startsWith('/admin/')) {
    const u = sessionUser(cookies(req)[COOKIE]);
    if (!u) return redirect(res, '/login?next=/admin');
    if (!isAdmin(u)) return serveStatic(req, res, '/404', m);
  }
  if (p === '/app' && url.searchParams.has('room')) {
    const room = getRoom(url.searchParams.get('room') ?? '');
    const u = sessionUser(cookies(req)[COOKIE]);
    // Logged-out visitors go on to the login page; a private room reads as missing to anyone not let in.
    if (!room || (u && !room.visibleTo(u))) return serveStatic(req, res, '/404', m);
    if (m === 'GET' || m === 'HEAD') return serveInvite(req, res, room, url.searchParams.get('by'), url.searchParams.has('watch'), m);
  }
  if ((m === 'GET' || m === 'HEAD') && !api && fs.existsSync(config.staticDir)) return serveStatic(req, res, p, m);
  json(res, 404, { error: 'Not found.' });
}

// ---- Static files (production) ----

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const COMPRESSIBLE = /\.(html|js|css|svg|json|webmanifest)$/;
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

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** The app page with Open Graph tags, so a pasted invite link embeds as "<name> has invited you to draw!" with the canvas. */
function serveInvite(req: Req, res: Res, room: Room, by: string | null, watch: boolean, m: string) {
  const c = loadFile(path.join(config.staticDir, 'app.html'));
  if (!c) return serveStatic(req, res, '/app', m);
  const name = (by ? userByHandle(by) : undefined)?.display_name ?? getUser(room.info.ownerId)?.display_name ?? 'A friend';
  const v = (db.prepare('SELECT thumb_version FROM rooms WHERE id = ?').get(room.info.id) as { thumb_version: number } | undefined)?.thumb_version ?? 0;
  const tags = {
    'og:type': 'website', 'og:site_name': 'DoodleHive', 'og:url': `${config.publicUrl}/app?room=${room.info.id}`,
    'og:title': `${name} has invited you to ${watch ? 'watch them draw' : 'draw'}!`,
    'og:description': `${name} has invited you to ${watch ? 'watch them draw' : 'draw'} on DoodleHive! No account needed just click to join!`,
    'og:image': `${config.publicUrl}/og/${room.info.id}?v=${v}`, 'twitter:card': 'summary_large_image',
  };
  const head = Object.entries(tags).map(([k, val]) => `<meta property="${k}" content="${escapeHtml(val)}" />`).join('\n  ');
  const html = c.raw.toString('utf8').replace('</head>', `  ${head}\n</head>`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(m === 'HEAD' ? undefined : html);
}

function serveStatic(req: Req, res: Res, p: string, m: string) {
  const dir = config.staticDir;
  const file = path.join(dir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  // Pages sit at the top of dist/: / is the landing page, /login the login page, /app (and sub-paths) the app.
  const page = p === '/' || p === '/index.html' ? 'index.html' : p === '/app' || p.startsWith('/app/') ? 'app.html' : p === '/login' || p === '/login/' ? 'login.html'
    : p === '/admin' || p.startsWith('/admin/') ? 'admin.html' : '404.html';
  const target = file.startsWith(dir + path.sep) && !p.endsWith('/') ? file : '';
  const c = (target && loadFile(target)) || loadFile(path.join(dir, page));
  if (!c) {
    console.error(`Missing page ${page} in ${dir}. Was "npm run build" run?`);
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('Doodlehive is updating. Please try again in a minute.');
  }
  const served = target && c === fileCache.get(target) ? target : page;
  const status = served === '404.html' ? 404 : 200;
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[path.extname(served)] ?? 'application/octet-stream',
    'Cache-Control': served.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: c.etag,
    Vary: 'Accept-Encoding',
  };
  if (status === 200 && req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
  const gz = c.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) ? c.gz : null;
  if (gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = (gz ?? c.raw).length;
  res.writeHead(status, headers);
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
  const ip = clientIp(req);
  const ok = m && user && !user.banned && !bannedIp(ip) && room && (!origin || ORIGINS.has(origin)) && (watch === undefined || WATCH_KEY_RE.test(watch))
    && allow('ws:' + ip, 60, MINUTE) && room.connections(user.id) < 6;
  if (!ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  lastIp(user.id, ip);
  keepGuest(user);
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

sweep();
setInterval(sweep, 10 * MINUTE).unref();
resumeEphemeral(10 * MINUTE);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    for (const ws of wss.clients) ws.close(1012, 'Server restarting');
    closeAllStreams();
    flushOps();
    flushStats();
    server.close();
    try { db.close(); } catch { /* already closed */ }
    process.exit(restart.wanted ? 75 : 0);
  });
}

// Beta refreshes its copy of live once a day, at a quiet moment: a restart brings it in.
if (config.sync.from && config.sync.secret) setInterval(() => {
  if (syncDue() && wss.clients.size === 0) { restart.wanted = true; process.kill(process.pid, 'SIGTERM'); }
}, HOUR).unref();

server.listen(config.port, () => {
  console.log(`Doodlehive server on ${config.publicUrl}${config.beta ? ' (beta)' : ''}`);
  if (!config.persistent) console.warn('  WARNING: no volume attached; accounts and rooms will be lost on the next deploy.');
  if (config.production && config.devLogin) console.warn('  WARNING: dev login is on in production. Anyone can log in as anyone. Unset DEV_LOGIN.');
  console.log(`  Discord login: ${config.discord ? 'on' : 'off (set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET)'}`);
  console.log(`  Dev login: ${config.devLogin ? 'on' : 'off'}`);
  console.log(`  Database: ${config.dbPath}`);
  console.log(`  Pictures: ${config.media ? `R2 bucket ${config.media.bucket}${config.media.prefix ? ` under ${config.media.prefix}` : ''}, served from ${config.media.publicUrl}` : 'in the database (set the R2_* variables and MEDIA_URL to use R2)'}`);
  if (config.media) checkMedia().then(movePicturesToMedia).catch((e) => console.error('Moving pictures to R2 stopped:', e));
  const pages = ['index.html', 'login.html', 'app.html', 'admin.html', '404.html'].map((f) => `${f} ${fs.existsSync(path.join(config.staticDir, f)) ? 'ok' : 'MISSING'}`);
  console.log(`  Pages in ${config.staticDir}: ${pages.join(', ')}`);
  if (path.resolve(config.dbPath).startsWith(path.resolve(config.staticDir) + path.sep)) {
    console.warn('  WARNING: the database is inside the web build folder. Mount the volume at /data instead.');
  }
});
