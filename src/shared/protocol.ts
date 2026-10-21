// Messages exchanged over the room WebSocket. Shared by client and server.
import type { BrushParams, DocSettings, Op, Selection } from '../core/model';
import type { PublicProfile } from './profile';

export type Role = 'owner' | 'host' | 'member' | 'spectator';

/** private: only the owner. open: anyone with the link. friends: the owner's friends. unlisted: link only, hidden from friends lists. */
export type Visibility = 'private' | 'open' | 'friends' | 'unlisted';

export interface ShareSettings {
  visibility: Visibility;
  /** Open links: no guests. */
  requireLogin: boolean;
  /** Open links: friends of people in the room can join from their friends list. */
  friendsCanJoin: boolean;
  /** Open links: the host lets each newcomer in. */
  approveJoins: boolean;
}

export const DEFAULT_SHARE: ShareSettings = { visibility: 'open', requireLogin: false, friendsCanJoin: true, approveJoins: false };

export interface RoomInfo {
  id: string;
  name: string;
  ownerId: string;
  settings: DocSettings;
  /** Same as share.visibility === 'private'. */
  private: boolean;
  share: ShareSettings;
  /** Held on the server only while live (free hosts); everyone keeps a copy on their device. */
  ephemeral: boolean;
  /** Secret in the watch-only link; hosts only. */
  watchKey?: string;
}

/** A canvas on the home screen. */
export interface ProjectInfo {
  id: string;
  name: string;
  private: boolean;
  visibility: Visibility;
  createdAt: number;
  updatedAt: number;
  thumb: string | null;
  online: number;
  /** Stored in this browser rather than on the server. */
  local?: boolean;
}

export interface Member extends PublicProfile { role: Role }

export interface ChatMsg { id: string; from: string; text: string; at: number; system?: boolean }

/** A chunk of a stroke in progress. */
export interface LiveStroke {
  stroke: string;
  layer: string;
  erase: boolean;
  brush: BrushParams;
  color: string;
  clip?: Selection;
  pts: number[]; // new samples, flat x,y,pressure
}

/** The deny message for private rooms; the client turns it into the 404 page. */
export const PRIVATE_ROOM_MSG = 'This canvas is private.';

export type ClientMsg =
  | { type: 'op'; op: Op }
  | { type: 'live'; live: LiveStroke }
  | { type: 'live-end'; stroke: string }
  | { type: 'cursor'; x: number; y: number; drawing: boolean }
  | { type: 'chat'; text: string }
  | { type: 'typing'; on: boolean }
  | { type: 'kick'; user: string }
  | { type: 'set-host'; user: string; on: boolean }
  | { type: 'admit'; user: string; allow: boolean }
  | { type: 'count'; what: 'undo' | 'redo' };

export type ServerMsg =
  | { type: 'welcome'; room: RoomInfo; you: string; spectator: boolean; members: Member[]; ops: Op[]; chat: ChatMsg[] }
  | { type: 'op'; op: Op; from: string }
  | { type: 'reject'; opId: string; reason: string }
  | { type: 'members'; members: Member[] }
  | { type: 'room'; room: RoomInfo }
  | { type: 'live'; from: string; live: LiveStroke }
  | { type: 'live-end'; from: string; stroke: string }
  | { type: 'cursor'; from: string; x: number; y: number; drawing: boolean }
  | { type: 'chat'; msg: ChatMsg }
  | { type: 'typing'; from: string; on: boolean }
  | { type: 'kicked'; by: string }
  | { type: 'waiting' }
  | { type: 'join-request'; user: PublicProfile }
  | { type: 'join-request-gone'; user: string }
  | { type: 'error'; message: string }
  | { type: 'closed'; message: string };

export const CHAT_MAX = 500;
export const ROOM_NAME_MAX = 48;

export const WATCH_KEY_RE = /^[a-z0-9]{16}$/;
export const userFolderId = (userId: string) => 'uf_' + userId;
