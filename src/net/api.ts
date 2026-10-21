import type { DocSettings } from '../core/model';
import type { MyProfile, Presence, PresenceMode, PublicProfile } from '../shared/profile';
import type { ProjectInfo, RoomInfo, ShareSettings } from '../shared/protocol';

export class ApiError extends Error {
  constructor(public status: number, message: string, public field?: string) { super(message); }
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

export interface ServerConfig { discord: boolean; devLogin: boolean; downloads?: { mac: string | null; windows: string | null } }

export interface Friend extends PublicProfile { online: boolean; presence: Presence; room: { id: string; name: string } | null }

export type LiveEvent =
  | { type: 'friends' }
  | { type: 'invite'; room: { id: string; name: string }; from: { id: string; displayName: string } };
export interface FriendsList { friends: Friend[]; incoming: PublicProfile[]; outgoing: PublicProfile[] }

export const api = {
  async config(): Promise<ServerConfig | null> {
    try {
      const res = await fetch('/api/config', { credentials: 'same-origin' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      return await res.json();
    } catch { return null; }
  },
  async me(): Promise<MyProfile | null> {
    try { return await call<MyProfile>('GET', '/api/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
  },
  devLogin: (name: string) => call<MyProfile>('POST', '/auth/dev', { name }),
  guestLogin: (name: string) => call<MyProfile>('POST', '/auth/guest', { name }),
  logout: () => call('POST', '/auth/logout'),
  discordUrl: (next: string) => '/auth/discord?next=' + encodeURIComponent(next),
  updateMe: (patch: Partial<{ displayName: string; handle: string; favoriteColor: string; links: Record<string, string>; done: boolean; theme: string; status: string; gradient: [string, string] | null; presenceMode: PresenceMode }>) =>
    call<MyProfile>('PATCH', '/api/me', patch),
  uploadAvatar: (img: Blob) => call<MyProfile>('PUT', '/api/me/avatar', undefined, img),
  deleteAvatar: () => call<MyProfile>('DELETE', '/api/me/avatar'),
  randomHandle: () => call<{ handle: string }>('GET', '/api/handle/random'),
  checkHandle: (h: string) => call<{ valid: boolean; available: boolean; error: string | null }>('GET', '/api/handle/check?h=' + encodeURIComponent(h)),
  uploadAnimatedAvatar: (gif: Blob) => call<MyProfile>('PUT', '/api/me/avatar-animated', undefined, gif),
  deleteAnimatedAvatar: () => call<MyProfile>('DELETE', '/api/me/avatar-animated'),
  createRoom: (name: string, settings: Omit<DocSettings, 'id'>, share: ShareSettings) =>
    call<RoomInfo>('POST', '/api/rooms', { name, settings, share }),
  updateRoom: (id: string, patch: { name?: string; share?: ShareSettings }) => call<RoomInfo>('PATCH', '/api/rooms/' + id, patch),
  invite: (roomId: string, userId: string) => call<{ ok: true }>('POST', `/api/rooms/${roomId}/invite`, { user: userId }),
  deleteRoom: (id: string) => call<{ ok: true }>('DELETE', '/api/rooms/' + id),
  uploadThumb: (id: string, img: Blob) => call<{ ok: true }>('PUT', `/api/rooms/${id}/thumb`, undefined, img),
  projects: () => call<ProjectInfo[]>('GET', '/api/projects'),
  friends: () => call<FriendsList>('GET', '/api/friends'),
  addFriend: (handle: string) => call<FriendsList & { result: 'requested' | 'accepted' }>('POST', '/api/friends', { handle }),
  acceptFriend: (id: string) => call<FriendsList>('POST', `/api/friends/${id}/accept`),
  removeFriend: (id: string) => call<FriendsList>('DELETE', '/api/friends/' + id),
  room: (id: string) => call<RoomInfo & { owner: PublicProfile | null; online: number }>('GET', '/api/rooms/' + id),
};
