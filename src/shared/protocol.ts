// Messages exchanged over the room WebSocket. Shared by client and server.
import type { BrushParams, DocSettings, Op, Selection } from '../core/model';
import type { PublicProfile } from './profile';

export type Role = 'owner' | 'host' | 'member';

export interface RoomInfo {
  id: string;
  name: string;
  ownerId: string;
  settings: DocSettings;
  /** Private canvases ("Draw alone") only let their owner in. */
  private: boolean;
}

/** A canvas on the home screen. */
export interface ProjectInfo {
  id: string;
  name: string;
  private: boolean;
  createdAt: number;
  updatedAt: number;
  thumb: string | null;
  /** People drawing in it right now. */
  online: number;
}

export interface Member extends PublicProfile { role: Role }

export interface ChatMsg { id: string; from: string; text: string; at: number; system?: boolean }

/** An in-progress stroke streamed while someone draws, so others see it live. */
export interface LiveStroke {
  stroke: string; // id shared by every chunk of one stroke
  layer: string;
  erase: boolean;
  brush: BrushParams;
  color: string;
  clip?: Selection;
  pts: number[]; // new samples since the previous chunk, flat x,y,pressure
}

export type ClientMsg =
  | { type: 'op'; op: Op }
  | { type: 'live'; live: LiveStroke }
  | { type: 'live-end'; stroke: string }
  | { type: 'cursor'; x: number; y: number; drawing: boolean }
  | { type: 'chat'; text: string }
  | { type: 'typing'; on: boolean }
  | { type: 'kick'; user: string }
  | { type: 'set-host'; user: string; on: boolean }
  | { type: 'ping' };

export type ServerMsg =
  | { type: 'welcome'; room: RoomInfo; you: string; members: Member[]; ops: Op[]; chat: ChatMsg[] }
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
  | { type: 'error'; message: string }
  | { type: 'pong' };

export const CHAT_MAX = 500;
export const ROOM_NAME_MAX = 48;

/** Id of a member's top-level folder in a room. */
export const userFolderId = (userId: string) => 'uf_' + userId;
