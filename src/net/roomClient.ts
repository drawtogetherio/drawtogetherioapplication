import { DrawDoc, toWire } from '../core/document';
import type { Op } from '../core/model';
import type { TiledSurface } from '../core/tiles';
import type { PublicProfile } from '../shared/profile';
import type { ChatMsg, ClientMsg, LiveStroke, Member, RoomInfo, ServerMsg } from '../shared/protocol';

export type RoomEvent =
  | { kind: 'ready'; doc: DrawDoc; first: boolean }
  | { kind: 'progress'; done: number; total: number }
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
  | { kind: 'reject'; opId: string; reason: string }
  | { kind: 'snapshot' }
  | { kind: 'error'; message: string };

const YIELD_MS = 24;

export class RoomClient {
  info: RoomInfo | null = null;
  you = '';
  /** Watching through the spectator link: chat only. */
  spectator = false;
  members: Member[] = [];
  chat: ChatMsg[] = [];
  typing = new Map<string, number>();
  status: 'connecting' | 'waiting' | 'open' | 'reconnecting' | 'closed' | 'kicked' = 'connecting';
  requests: PublicProfile[] = [];
  doc: DrawDoc | null = null;
  /** Pixels already drawn by a live preview of this op, so it isn't rendered twice. */
  liveBuffer: (op: Op) => TiledSurface | undefined = () => undefined;
  /** While true, other people's edits wait (e.g. mid-stroke), so the local pen never stutters. */
  hold: () => boolean = () => false;
  /** Held for good reason: a snapshot or a rebuild is reading the canvas. */
  freeze = false;
  /** Other people's edits land in batches this far apart (0: as they come). */
  batchMs = 0;
  /** The room's order number of the last edit applied here; own edits count once the server places them. */
  lastSeq = 0;
  /** Own edits the server hasn't placed yet. */
  inflight = 0;
  private gateAt = 0;
  private gateP: Promise<void> | null = null;

  private ws: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<(e: RoomEvent) => void>();
  private retry = 0;
  private everReady = false;
  private closedByUs = false;

  constructor(public readonly id: string, private readonly watch: string | null = null) { this.connect(); }

  on(fn: (e: RoomEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: RoomEvent) { for (const fn of this.listeners) fn(e); }

  member(id: string) { return this.members.find((m) => m.id === id); }
  get me() { return this.member(this.you); }
  get isHost() { const r = this.me?.role; return r === 'owner' || r === 'host'; }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.id}${this.watch ? '?watch=' + this.watch : ''}`);
    this.ws = ws;
    ws.onmessage = (ev) => this.receive(JSON.parse(String(ev.data)) as ServerMsg);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (this.closedByUs || this.status === 'kicked' || ev.code === 4003 || ev.code === 4004) {
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
  }

  private receive(m: ServerMsg) {
    switch (m.type) {
      case 'welcome': {
        this.info = m.room;
        this.you = m.you;
        this.spectator = m.spectator;
        this.members = m.members;
        this.chat = m.chat;
        this.requests = [];
        this.retry = 0;
        const doc = new DrawDoc({ ...m.room.settings });
        this.queue = this.queue.then(async () => {
          let t = performance.now();
          for (let i = 0; i < m.ops.length; i++) {
            const op = m.ops[i];
            doc.apply(op, { ...await doc.prepare(op), record: false });
            if (performance.now() - t > YIELD_MS) {
              this.emit({ kind: 'progress', done: i + 1, total: m.ops.length });
              await new Promise((r) => setTimeout(r));
              t = performance.now();
            }
          }
          this.doc = doc;
          this.lastSeq = m.seq;
          this.inflight = 0;
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
          while (this.hold() || this.freeze) await new Promise((r) => setTimeout(r, 50));
          if (this.batchMs) await this.gate();
          const pre = await this.doc.prepare(m.op);
          this.doc.apply(m.op, { ...pre, record: false, buffer: this.liveBuffer(m.op) });
          this.lastSeq = m.seq;
          this.emit({ kind: 'op', op: m.op, from: m.from });
        });
        return;
      case 'ack':
        this.queue = this.queue.then(() => { this.lastSeq = m.seq; this.inflight = Math.max(0, this.inflight - 1); });
        return;
      case 'reject':
        this.inflight = Math.max(0, this.inflight - 1);
        this.emit({ kind: 'reject', opId: m.opId, reason: m.reason });
        return;
      case 'snapshot-request': this.emit({ kind: 'snapshot' }); return;
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
      case 'closed':
        this.status = 'closed';
        this.emit({ kind: 'error', message: m.message });
        return;
    }
  }

  send(m: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  admit(user: string, allow: boolean) { this.send({ type: 'admit', user, allow }); }

  sendOp(op: Op) { this.inflight++; this.send({ type: 'op', op: toWire(op) }); }

  /** Edits wait for the end of the current batch window, then land together. */
  private gate(): Promise<void> {
    const now = Date.now();
    if (this.gateAt <= now) this.gateAt = now + this.batchMs;
    return this.gateP ??= new Promise((r) => setTimeout(() => { this.gateP = null; r(); }, this.gateAt - now));
  }

  /** Resolves once everything the room sent is applied and every own edit is placed: the canvas equals the room at `lastSeq`. */
  async settled() {
    for (;;) {
      const q = this.queue;
      await q;
      if (this.queue === q && !this.inflight && !this.hold() && !this.freeze) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Our state diverged (an edit was refused): rebuild from the server. */
  resync() { this.ws?.close(); }

  close() { this.closedByUs = true; this.ws?.close(); }
}
