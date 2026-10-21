import { DrawDoc, toWire } from '../core/document';
import type { Op } from '../core/model';
import type { PublicProfile } from '../shared/profile';
import type { ChatMsg, ClientMsg, LiveStroke, Member, RoomInfo, ServerMsg } from '../shared/protocol';

export type RoomEvent =
  | { kind: 'ready'; doc: DrawDoc; first: boolean }
  | { kind: 'op'; op: Op; from: string }
  | { kind: 'members' }
  | { kind: 'chat'; msg: ChatMsg }
  | { kind: 'typing' }
  | { kind: 'live'; from: string; live: LiveStroke }
  | { kind: 'live-end'; from: string; stroke: string }
  | { kind: 'cursor'; from: string; x: number; y: number; drawing: boolean }
  | { kind: 'status' }
  | { kind: 'room' }
  | { kind: 'requests' }
  | { kind: 'error'; message: string };

/**
 * Connection to a shared room. Incoming ops are applied in order (tile images are decoded first);
 * on reconnect the whole canvas is rebuilt from the server's op log.
 */
export class RoomClient {
  info: RoomInfo | null = null;
  you = '';
  members: Member[] = [];
  chat: ChatMsg[] = [];
  /** user id -> time their typing indicator expires */
  typing = new Map<string, number>();
  status: 'connecting' | 'waiting' | 'open' | 'reconnecting' | 'closed' | 'kicked' = 'connecting';
  /** Hosts: people waiting to be let in. */
  requests: PublicProfile[] = [];
  doc: DrawDoc | null = null;

  private ws: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<(e: RoomEvent) => void>();
  private retry = 0;
  private everReady = false;
  private closedByUs = false;
  private pinger = 0;

  constructor(public readonly id: string) { this.connect(); }

  on(fn: (e: RoomEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: RoomEvent) { for (const fn of this.listeners) fn(e); }

  member(id: string) { return this.members.find((m) => m.id === id); }
  get me() { return this.member(this.you); }
  get isHost() { const r = this.me?.role; return r === 'owner' || r === 'host'; }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.id}`);
    this.ws = ws;
    ws.onmessage = (ev) => this.receive(JSON.parse(String(ev.data)) as ServerMsg);
    ws.onclose = (ev) => {
      clearInterval(this.pinger);
      if (this.ws !== ws) return;
      if (this.closedByUs || this.status === 'kicked' || ev.code === 4003) {
        if (this.status !== 'kicked') this.status = 'closed';
        this.emit({ kind: 'status' });
        return;
      }
      if (!this.everReady && this.retry >= 2) {
        this.status = 'closed';
        this.emit({ kind: 'error', message: 'Couldn’t join this room. Check the link, or log in again.' });
        this.emit({ kind: 'status' });
        return;
      }
      this.status = 'reconnecting';
      this.emit({ kind: 'status' });
      setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++));
    };
    ws.onopen = () => { this.pinger = window.setInterval(() => this.send({ type: 'ping' }), 25_000); };
  }

  private receive(m: ServerMsg) {
    switch (m.type) {
      case 'welcome': {
        this.info = m.room;
        this.you = m.you;
        this.members = m.members;
        this.chat = m.chat;
        this.requests = [];
        this.retry = 0;
        const doc = new DrawDoc({ ...m.room.settings });
        this.queue = this.queue.then(async () => {
          for (const op of m.ops) { await doc.prepare(op); doc.apply(op); }
          this.doc = doc;
          this.status = 'open';
          const first = !this.everReady;
          this.everReady = true;
          this.emit({ kind: 'ready', doc, first });
          this.emit({ kind: 'status' });
        });
        return;
      }
      case 'op':
        this.queue = this.queue.then(async () => {
          if (!this.doc) return;
          await this.doc.prepare(m.op);
          this.doc.apply(m.op);
          this.emit({ kind: 'op', op: m.op, from: m.from });
        });
        return;
      case 'reject':
        this.emit({ kind: 'error', message: m.reason });
        this.resync();
        return;
      case 'room':
        this.info = m.room;
        this.emit({ kind: 'room' });
        return;
      case 'members':
        this.members = m.members;
        this.emit({ kind: 'members' });
        return;
      case 'chat':
        this.chat.push(m.msg);
        if (this.chat.length > 200) this.chat.shift();
        this.typing.delete(m.msg.from);
        this.emit({ kind: 'chat', msg: m.msg });
        return;
      case 'typing':
        if (m.on) this.typing.set(m.from, Date.now() + 6000); else this.typing.delete(m.from);
        this.emit({ kind: 'typing' });
        return;
      case 'live': this.emit({ kind: 'live', from: m.from, live: m.live }); return;
      case 'live-end': this.emit({ kind: 'live-end', from: m.from, stroke: m.stroke }); return;
      case 'cursor': this.emit({ kind: 'cursor', from: m.from, x: m.x, y: m.y, drawing: m.drawing }); return;
      case 'waiting':
        this.status = 'waiting';
        this.emit({ kind: 'status' });
        return;
      case 'join-request':
        if (!this.requests.some((r) => r.id === m.user.id)) this.requests.push(m.user);
        this.emit({ kind: 'requests' });
        return;
      case 'join-request-gone':
        this.requests = this.requests.filter((r) => r.id !== m.user);
        this.emit({ kind: 'requests' });
        return;
      case 'kicked':
        this.status = 'kicked';
        this.emit({ kind: 'status' });
        return;
      case 'error':
        this.emit({ kind: 'error', message: m.message });
        return;
    }
  }

  send(m: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  /** Hosts: let someone in, or not. */
  admit(user: string, allow: boolean) { this.send({ type: 'admit', user, allow }); }

  sendOp(op: Op) { this.send({ type: 'op', op: toWire(op) }); }

  /** Rebuild from the server after our state diverged (e.g. an edit was refused). */
  resync() { this.ws?.close(); }

  close() { this.closedByUs = true; this.ws?.close(); }
}
