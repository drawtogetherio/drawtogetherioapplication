import type { DocSettings, Op } from '../core/model';
import type { ImageCrop, MyProfile, Presence, PresenceMode, PublicProfile } from '../shared/profile';
import type { LogEntry, ProjectInfo, RoomInfo, ShareSettings, VisitInfo } from '../shared/protocol';
import type { Notice } from '../shared/notices';
import type { SiteNotice } from '../shared/site';
import type { Prefs } from '../shared/prefs';

export class ApiError extends Error {
  constructor(public status: number, message: string, public field?: string) { super(message); }
}

/** A corner tag on the beta site, so it can't be mistaken for the live one. */
function betaBadge() {
  if (document.getElementById('beta-badge')) return;
  const tag = document.createElement('div');
  tag.id = 'beta-badge';
  tag.textContent = 'BETA';
  tag.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:2px 8px;border-radius:6px;background:#f5a524;color:#1a1200;font:700 11px/18px system-ui,sans-serif;letter-spacing:.08em;pointer-events:none;opacity:.9';
  document.body.append(tag);
}

async function call<T>(method: string, url: string, body?: unknown, raw?: Blob): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'Request failed.', (data as { field?: string }).field);
  return data as T;
}

export interface ServerConfig { beta?: boolean; discord: boolean; devLogin: boolean; downloads?: { mac: string | null; windows: string | null }; patreon?: string; patreonLink?: boolean; discordInvite?: string; notice?: SiteNotice | null }

export interface Friend extends PublicProfile { online: boolean; presence: Presence; room: { id: string; name: string } | null }

export type LiveEvent =
  | { type: 'friends' }
  | { type: 'notices' }
  | { type: 'invite'; room: { id: string; name: string }; from: { id: string; displayName: string } };
export interface FriendsList { friends: Friend[]; incoming: PublicProfile[]; outgoing: PublicProfile[] }

export const api = {
  visits: () => call<VisitInfo[]>('GET', '/api/visits'),
  roomLog: (room: string) => call<{ entries: LogEntry[]; people: PublicProfile[] }>('GET', `/api/rooms/${room}/log`),
  roomHistory: (room: string, upto: number, layer: string | null) => call<{ ops: Op[]; complete: boolean }>('GET', `/api/rooms/${room}/history?upto=${upto}${layer ? '&layer=' + encodeURIComponent(layer) : ''}`),
  roomSnapshot: (room: string, seq: number, ops: Op[]) => call<{ ok: true }>('POST', `/api/rooms/${room}/snapshot`, { seq, ops }),
  async config(): Promise<ServerConfig | null> {
    try {
      const res = await fetch('/api/config', { credentials: 'same-origin' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      const cfg: ServerConfig = await res.json();
      if (cfg.beta) betaBadge();
      return cfg;
    } catch { return null; }
  },
  async me(): Promise<MyProfile | null> {
    try { return await call<MyProfile>('GET', '/api/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
  },
  devLogin: (name: string) => call<MyProfile>('POST', '/auth/dev', { name }),
  guestLogin: (name: string) => call<MyProfile>('POST', '/auth/guest', { name }),
  logout: () => call('POST', '/auth/logout'),
  discordUrl: (next: string) => '/auth/discord?next=' + encodeURIComponent(next),
  updateMe: (patch: Partial<{ displayName: string; handle: string; favoriteColor: string; links: Record<string, string>; pinned: string[]; done: boolean; theme: string; status: string; gradient: [string, string] | null; presenceMode: PresenceMode; prefs: Prefs }>) =>
    call<MyProfile>('PATCH', '/api/me', patch),
  checkPatreon: () => call<MyProfile>('POST', '/api/me/patreon'),
  unlinkPatreon: () => call<MyProfile>('DELETE', '/api/me/patreon'),
  uploadAvatar: (img: Blob) => call<MyProfile>('PUT', '/api/me/avatar', undefined, img),
  deleteAvatar: () => call<MyProfile>('DELETE', '/api/me/avatar'),
  randomHandle: () => call<{ handle: string }>('GET', '/api/handle/random'),
  checkHandle: (h: string) => call<{ valid: boolean; available: boolean; error: string | null }>('GET', '/api/handle/check?h=' + encodeURIComponent(h)),
  uploadAnimatedAvatar: (gif: Blob, crop: ImageCrop) => call<MyProfile>('PUT', '/api/me/avatar-animated?' + new URLSearchParams(Object.entries(crop).map(([k, v]) => [k, String(v)])), undefined, gif),
  uploadBanner: (img: Blob) => call<MyProfile>('PUT', '/api/me/banner', undefined, img),
  deleteBanner: () => call<MyProfile>('DELETE', '/api/me/banner'),
  deleteAnimatedAvatar: () => call<MyProfile>('DELETE', '/api/me/avatar-animated'),
  createRoom: (name: string, settings: Omit<DocSettings, 'id'>, share: ShareSettings, ops: Op[] = []) =>
    call<RoomInfo>('POST', '/api/rooms', { name, settings, share, ops }),
  /** A .hivecanvas file becomes a room. */
  importRoom: (file: Blob, name: string, share: ShareSettings) =>
    call<RoomInfo>('POST', `/api/rooms/import?name=${encodeURIComponent(name)}&share=${encodeURIComponent(JSON.stringify(share))}`, undefined, file),
  updateRoom: (id: string, patch: { name?: string; share?: ShareSettings; ephemeral?: true }) => call<RoomInfo>('PATCH', '/api/rooms/' + id, patch),
  invite: (roomId: string, userId: string) => call<{ ok: true }>('POST', `/api/rooms/${roomId}/invite`, { user: userId }),
  deleteRoom: (id: string) => call<{ ok: true }>('DELETE', '/api/rooms/' + id),
  uploadThumb: (id: string, img: Blob) => call<{ ok: true }>('PUT', `/api/rooms/${id}/thumb`, undefined, img),
  projects: () => call<ProjectInfo[]>('GET', '/api/projects'),
  friends: () => call<FriendsList>('GET', '/api/friends'),
  addFriend: (handle: string) => call<FriendsList & { result: 'requested' | 'accepted' }>('POST', '/api/friends', { handle }),
  acceptFriend: (id: string) => call<FriendsList>('POST', `/api/friends/${id}/accept`),
  removeFriend: (id: string) => call<FriendsList>('DELETE', '/api/friends/' + id),
  room: (id: string) => call<RoomInfo & { owner: PublicProfile | null; online: number; joinable: boolean; invited?: PublicProfile[] }>('GET', '/api/rooms/' + id),
  blocks: () => call<PublicProfile[]>('GET', '/api/blocks'),
  block: (id: string) => call<PublicProfile[]>('POST', '/api/blocks', { user: id }),
  unblock: (id: string) => call<PublicProfile[]>('DELETE', '/api/blocks/' + id),
  notices: () => call<{ unread: number; notices: Notice[] }>('GET', '/api/notices'),
  readNotices: () => call<{ ok: true }>('POST', '/api/notices/read'),
  clearNotices: () => call<{ ok: true }>('DELETE', '/api/notices'),
};
