import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from './config.ts';
import { db, getUser, hasBlocked, keepGuest, newId, publicProfile, UserRow } from './db.ts';
import { areFriends, notifyFriends, touch } from './social.ts';
import { validCoord, validLive, validOp } from './validate.ts';
import { bump } from './stats.ts';
import type { DocSettings, Op } from '../src/core/model.ts';
import type { PublicProfile } from '../src/shared/profile.ts';
import {
  CHAT_MAX, ChatMsg, ClientMsg, DEFAULT_SHARE, LogEntry, Member, PRIVATE_ROOM_MSG, ProjectInfo, Role, RoomInfo, ServerMsg, ShareSettings, Visibility, userFolderId,
} from '../src/shared/protocol.ts';

interface NodeInfo { owner?: string; parent: string | null; user?: boolean; kind: 'layer' | 'folder' }

interface Client {
  ws: WebSocket; userId: string; spectator: boolean; lastChat: number[];
  msgs: number; msgsAt: number; bytes: number; bytesAt: number; livePts: number; livePtsAt: number; cursorAt: number;
}

const KICK_BLOCK_MS = 10 * 60_000;
/** How long a client asked for a snapshot gets before someone else is asked. */
const SNAPSHOT_WAIT_MS = 120_000;
const MSGS_PER_SEC = 80, MSG_BURST = 240;
const BYTES_PER_MIN = 24 * 1024 * 1024;
/** Live points everyone else must paint: a pen gives at most a few hundred a second. */
const LIVE_PTS_PER_SEC = 600, LIVE_PTS_BURST = 4000;
const CURSOR_MS = 40;
const KICKED_MSG = 'You were removed from this room. Try again later.';
const BLOCKED_MSG = 'You can’t join this room.';
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const randomId = (n: number) => Array.from(crypto.randomBytes(n), (b) => ID_CHARS[b % 31]).join('');

const raw = (ws: WebSocket, m: ServerMsg) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

// Room ops are written in batches: one transaction (one disk sync) per OP_FLUSH_MS instead of one per op.
const OP_FLUSH_MS = 100;
const insertOp = db.prepare('INSERT INTO room_ops (room_id, seq, op) VALUES (?, ?, ?)');
const updatedAt = db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?');
let opQueue: [string, number, string][] = [];
let opTimer: ReturnType<typeof setTimeout> | null = null;

function queueOp(room: string, seq: number, json: string) {
  opQueue.push([room, seq, json]);
  opTimer ??= setTimeout(flushOps, OP_FLUSH_MS);
}

/** Writes queued room ops now; also called on shutdown and before a room is deleted. */
export function flushOps() {
  if (opTimer) clearTimeout(opTimer);
  opTimer = null;
  if (!opQueue.length) return;
  const batch = opQueue;
  opQueue = [];
  db.exec('BEGIN');
  try {
    for (const [room, seq, json] of batch) insertOp.run(room, seq, json);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('saving room ops failed:', e);
  }
}

export class Room {
  readonly clients = new Set<Client>();
  /** A snapshot of the canvas (as ops) at `snapSeq`, then every op after it. Joining replays just these. */
  private snap: string[] = [];
  private snapSeq = 0;
  private ops: string[] = [];
  private snapAsked: { userId: string; at: number } | null = null;
  private nodes = new Map<string, NodeInfo>();
  private rootCount = 0;
  private chat: ChatMsg[] = [];
  private kicked = new Map<string, number>();
  private leaving = new Map<string, ReturnType<typeof setTimeout>>();
  private waiting = new Map<string, { ws: WebSocket; user: UserRow }>();
  /** People a host let in: invitees (kept) and approved joins (this run only). */
  private allowed: Set<string>;
  private seq = 0;
  private savedAt = 0;
  private hostTimer: ReturnType<typeof setTimeout> | null = null;
  hosts: Set<string>;

  constructor(public info: RoomInfo, hosts: string[], private watchKey: string, private invited: string[] = []) {
    this.hosts = new Set(hosts);
    this.allowed = new Set(invited);
    const snap = db.prepare('SELECT seq, ops FROM room_snapshots WHERE room_id = ?').get(info.id) as { seq: number; ops: string } | undefined;
    if (snap) { this.snapSeq = snap.seq; this.snap = JSON.parse(snap.ops); }
    const rows = db.prepare('SELECT seq, op FROM room_ops WHERE room_id = ? AND seq > ? ORDER BY seq').all(info.id, this.snapSeq) as { seq: number; op: string }[];
    this.seq = rows.length ? rows[rows.length - 1].seq : this.snapSeq;
    for (const r of rows) this.ops.push(r.op);
    this.retrack();
  }

  private retrack() {
    this.nodes.clear();
    this.rootCount = 0;
    for (const j of this.snap) this.track(JSON.parse(j));
    for (const j of this.ops) this.track(JSON.parse(j));
  }

  /**
   * Replaces the snapshot with one a client built at `seq`: ops that rebuild the canvas as it looked
   * then. The tree it describes must match what the room knows, so nobody can hand themselves a layer.
   */
  takeSnapshot(userId: string, seq: number, ops: Op[]): string | null {
    if (this.snapAsked?.userId !== userId) return 'Not asked.';
    this.snapAsked = null;
    if (!Number.isInteger(seq) || seq < this.snapSeq || seq > this.seq) return 'Out of date.';
    if (!ops.every(validOp)) return 'Invalid snapshot.';
    const seen = new Map<string, NodeInfo>();
    for (const op of ops) {
      if (op.t === 'layer.add') seen.set(op.layer.id, { kind: 'layer', owner: op.layer.owner, parent: op.parent });
      else if (op.t === 'folder.add') seen.set(op.folder.id, { kind: 'folder', owner: op.folder.owner, parent: op.parent, user: op.folder.user });
      else if (op.t !== 'tiles') return 'Invalid snapshot.';
    }
    // The tree at `seq`: what the room has now, minus structure that came after.
    const want = new Map(this.nodes);
    for (let i = this.ops.length - 1; i >= 0 && this.snapSeq + 1 + i > seq; i--) {
      const op = JSON.parse(this.ops[i]) as Op;
      if (op.t === 'layer.add') want.delete(op.layer.id);
      else if (op.t === 'folder.add') want.delete(op.folder.id);
      else if (op.t === 'layer.remove' || op.t === 'layer.merge' || op.t === 'folder.remove' || op.t === 'node.move') return 'Try again.';
    }
    if (seen.size !== want.size) return 'Invalid snapshot.';
    for (const [id, n] of want) {
      const s = seen.get(id);
      if (!s || s.kind !== n.kind || s.owner !== n.owner || !!s.user !== !!n.user) return 'Invalid snapshot.';
    }
    const json = ops.map((op) => JSON.stringify(op));
    db.prepare('INSERT OR REPLACE INTO room_snapshots (room_id, seq, ops) VALUES (?, ?, ?)').run(this.info.id, seq, JSON.stringify(json));
    this.ops = this.ops.slice(seq - this.snapSeq);
    this.snap = json;
    this.snapSeq = seq;
    this.retrack();
    return null;
  }

  /** Asks the owner (else a host, else anyone drawing) for a snapshot once enough has happened since the last. */
  private maybeAskSnapshot() {
    const now = Date.now();
    if (this.ops.length < config.snapshotEvery || (this.snapAsked && now - this.snapAsked.at < SNAPSHOT_WAIT_MS)) return;
    const drawing = [...this.clients].filter((c) => !c.spectator && c.ws.readyState === 1);
    const pick = drawing.find((c) => c.userId === this.info.ownerId) ?? drawing.find((c) => this.isHost(c.userId)) ?? drawing[0];
    if (!pick) return;
    this.snapAsked = { userId: pick.userId, at: now };
    this.send(pick, { type: 'snapshot-request' });
  }

  /** The whole edit log, oldest first, for the hosts' log view; the pixels stay out. */
  log(): { entries: LogEntry[]; people: PublicProfile[] } {
    flushOps();
    // `layer` / `folder` hold an id, except in the ops that add one, where they hold the node itself.
    const node = (k: string) => `CASE WHEN json_type(op, '$.${k}') = 'object' THEN json_extract(op, '$.${k}.id') ELSE json_extract(op, '$.${k}') END`;
    const entries = db.prepare(`SELECT seq, json_extract(op, '$.id') AS id, json_extract(op, '$.t') AS t, json_extract(op, '$.author') AS author,
      json_extract(op, '$.at') AS at, ${node('layer')} AS layer, ${node('folder')} AS folder FROM room_ops WHERE room_id = ? ORDER BY seq`).all(this.info.id) as unknown as LogEntry[];
    const people = [...new Set(entries.map((e) => e.author))].map(getUser).filter((u): u is UserRow => !!u).map(publicProfile);
    return { entries, people };
  }

  /**
   * Every op up to `upto` that shaped `layer`, or all of them when `layer` is empty. `complete` is
   * false when a layer's pixels also came from another layer (a merge or a copy), so only the full log tells.
   */
  history(upto: number, layer: string | null): { ops: Op[]; complete: boolean } {
    flushOps();
    const rows = layer
      ? db.prepare(`SELECT op FROM room_ops WHERE room_id = ? AND seq <= ? AND (json_extract(op, '$.layer') = ? OR json_extract(op, '$.layer.id') = ?) ORDER BY seq`).all(this.info.id, upto, layer, layer) as { op: string }[]
      : db.prepare('SELECT op FROM room_ops WHERE room_id = ? AND seq <= ? ORDER BY seq').all(this.info.id, upto) as { op: string }[];
    const ops = rows.map((r) => JSON.parse(r.op) as Op);
    const mixed = !!layer && (ops.some((op) => op.t === 'layer.add' && !!op.copyOf)
      || !!db.prepare(`SELECT 1 FROM room_ops WHERE room_id = ? AND seq <= ? AND json_extract(op, '$.t') = 'layer.merge' LIMIT 1`).get(this.info.id, upto));
    return { ops, complete: !mixed };
  }

  role(userId: string): Role {
    return userId === this.info.ownerId ? 'owner' : this.hosts.has(userId) ? 'host' : 'member';
  }
  isHost(userId: string) { return this.role(userId) !== 'member'; }
  connections(userId: string) { let n = 0; for (const c of this.clients) if (c.userId === userId) n++; return n; }

  /** Someone with both a drawing and a watching tab open counts as drawing. */
  members(): Member[] {
    const watching = new Map<string, boolean>();
    for (const c of this.clients) watching.set(c.userId, c.spectator && (watching.get(c.userId) ?? true));
    const out: Member[] = [];
    for (const [id, spectator] of watching) {
      const u = getUser(id);
      if (u) out.push({ ...publicProfile(u), role: spectator ? 'spectator' : this.role(id) });
    }
    return out;
  }

  /** The watch link's secret goes to hosts only. */
  private infoFor(c: Client): RoomInfo { return this.isHost(c.userId) ? { ...this.info, watchKey: this.watchKey } : this.info; }

  send(c: Client, m: ServerMsg) { raw(c.ws, m); }
  broadcast(m: ServerMsg, except?: Client) { this.broadcastRaw(JSON.stringify(m), except); }
  private broadcastRaw(s: string, except?: Client) {
    for (const c of this.clients) if (c !== except && c.ws.readyState === 1) c.ws.send(s);
  }
  private broadcastMembers() { this.broadcast({ type: 'members', members: this.members() }); }
  private toHosts(m: ServerMsg) { for (const c of this.clients) if (this.isHost(c.userId)) this.send(c, m); }

  invite(userId: string) {
    this.allowed.add(userId);
    if (this.invited.includes(userId)) return;
    this.invited = [...this.invited, userId].slice(-200);
    db.prepare('UPDATE rooms SET invited = ? WHERE id = ?').run(JSON.stringify(this.invited), this.info.id);
  }
  invitedProfiles(): PublicProfile[] { return this.invited.map(getUser).filter((u): u is UserRow => !!u).map(publicProfile); }

  /** Closes someone's connections; `block` also keeps them out for a while. */
  expel(userId: string, block = false) {
    if (block) this.kicked.set(userId, Date.now() + KICK_BLOCK_MS);
    for (const x of [...this.clients]) {
      if (x.userId !== userId) continue;
      if (block) this.send(x, { type: 'kicked', by: '' });
      x.ws.close(4003, 'kicked');
      this.clients.delete(x);
    }
    this.broadcastMembers();
  }
  /** A private room is invisible to everyone but its hosts and invitees. */
  visibleTo(u: UserRow | undefined) { return !this.info.private || (!!u && (this.isHost(u.id) || this.allowed.has(u.id))); }
  canJoin(u: UserRow) { const a = this.access(u); return a === 'yes' || a === 'ask'; }

  private access(user: UserRow): 'yes' | 'ask' | string {
    const until = this.kicked.get(user.id);
    if (until && until > Date.now()) return KICKED_MSG;
    if (hasBlocked(this.info.ownerId, user.id) || [...this.hosts].some((h) => hasBlocked(h, user.id))) return BLOCKED_MSG;
    if (this.isHost(user.id) || this.allowed.has(user.id)) return 'yes';
    const s = this.info.share;
    switch (s.visibility) {
      case 'private': return PRIVATE_ROOM_MSG;
      case 'friends':
        return areFriends(user.id, this.info.ownerId) ? 'yes' : `Only ${getUser(this.info.ownerId)?.display_name ?? 'the owner'}’s friends can join this room.`;
      case 'unlisted': return 'yes';
      case 'open':
        if (s.requireLogin && user.provider === 'guest') return 'Log in with Discord to join this room.';
        return s.approveJoins ? 'ask' : 'yes';
    }
  }

  join(ws: WebSocket, user: UserRow, watch?: string) {
    if (watch !== undefined && !this.isHost(user.id)) {
      const until = this.kicked.get(user.id);
      if (until && until > Date.now()) { this.deny(ws, KICKED_MSG); return; }
      if (watch.length !== this.watchKey.length || !crypto.timingSafeEqual(Buffer.from(watch), Buffer.from(this.watchKey))) { this.deny(ws, 'This watch link doesn’t work.'); return; }
      this.admit(ws, user, true);
      return;
    }
    const ok = this.access(user);
    if (ok === 'ask') { this.ask(ws, user); return; }
    if (ok !== 'yes') { this.deny(ws, ok); return; }
    this.admit(ws, user);
  }

  private deny(ws: WebSocket, message: string) {
    raw(ws, { type: 'error', message });
    ws.close(4003, 'denied');
  }

  private ask(ws: WebSocket, user: UserRow) {
    this.waiting.get(user.id)?.ws.close(4003, 'replaced');
    this.waiting.set(user.id, { ws, user });
    raw(ws, { type: 'waiting' });
    this.toHosts({ type: 'join-request', user: publicProfile(user) });
    ws.on('close', () => {
      if (this.waiting.get(user.id)?.ws !== ws) return;
      this.waiting.delete(user.id);
      this.toHosts({ type: 'join-request-gone', user: user.id });
    });
  }

  private admit(ws: WebSocket, user: UserRow, spectator = false) {
    touch(user.id);
    const now = Date.now();
    const c: Client = { ws, userId: user.id, spectator, lastChat: [], msgs: MSG_BURST, msgsAt: now, bytes: 0, bytesAt: now, livePts: LIVE_PTS_BURST, livePtsAt: now, cursorAt: 0 };
    const firstConnection = !this.connections(user.id);
    this.clients.add(c);
    if (user.id === this.info.ownerId && this.hostTimer) { clearTimeout(this.hostTimer); this.hostTimer = null; }

    const fid = userFolderId(user.id);
    if (!spectator && !this.nodes.has(fid)) {
      this.commit({
        t: 'folder.add', id: newId('op_'), author: 'server', parent: null, index: this.rootCount,
        folder: { id: fid, name: user.display_name, visible: true, owner: user.id, user: true, color: user.favorite_color },
      });
    }
    const members = this.members();
    const head = JSON.stringify({ type: 'welcome', room: this.infoFor(c), you: user.id, spectator, members, chat: this.chat.slice(-50), seq: this.seq });
    ws.send(`${head.slice(0, -1)},"ops":[${[...this.snap, ...this.ops].join(',')}]}`);
    const pendingLeave = this.leaving.get(user.id);
    if (pendingLeave) { clearTimeout(pendingLeave); this.leaving.delete(user.id); }
    else if (firstConnection) { this.systemChat(`${user.display_name} ${spectator ? 'is watching' : 'joined'}`); notifyFriends(user.id); }
    this.broadcast({ type: 'members', members }, c);
    if (this.isHost(user.id)) for (const w of this.waiting.values()) this.send(c, { type: 'join-request', user: publicProfile(w.user) });

    ws.on('message', (data) => {
      const s = String(data);
      if (!this.budget(c, s.length)) return;
      let msg: ClientMsg;
      try { msg = JSON.parse(s); } catch { return; }
      this.handle(c, msg);
    });
    ws.on('close', () => {
      this.clients.delete(c);
      if (!this.connections(c.userId)) {
        if (this.info.ephemeral && c.userId === this.info.ownerId) this.hostGrace(config.ephemeralGraceMs);
        const u = getUser(c.userId);
        if (u) keepGuest(u);
        if (u && !this.kicked.has(c.userId)) {
          // A reload or a network blip shouldn't post "left" + "joined".
          this.leaving.set(c.userId, setTimeout(() => {
            this.leaving.delete(c.userId);
            this.systemChat(`${u.display_name} left`);
            notifyFriends(c.userId);
          }, 5000));
        }
        this.broadcast({ type: 'typing', from: c.userId, on: false });
      }
      this.broadcastMembers();
    });
  }

  /** Message and byte allowance per connection; floods are dropped, heavy ones disconnected. */
  private budget(c: Client, size: number): boolean {
    const now = Date.now();
    c.msgs = Math.min(MSG_BURST, c.msgs + ((now - c.msgsAt) / 1000) * MSGS_PER_SEC);
    c.msgsAt = now;
    if (c.msgs < 1) return false;
    c.msgs--;
    if (now - c.bytesAt > 60_000) { c.bytes = 0; c.bytesAt = now; }
    c.bytes += size;
    if (c.bytes > BYTES_PER_MIN) { this.send(c, { type: 'error', message: 'Too much data. Reconnecting.' }); c.ws.close(4008, 'flood'); return false; }
    return true;
  }

  /** Live previews past the allowance are dropped; the finished stroke still arrives as an op. */
  private liveBudget(c: Client, pts: number) {
    const now = Date.now();
    c.livePts = Math.min(LIVE_PTS_BURST, c.livePts + ((now - c.livePtsAt) / 1000) * LIVE_PTS_PER_SEC);
    c.livePtsAt = now;
    if (c.livePts < pts) return false;
    c.livePts -= pts;
    return true;
  }

  private handle(c: Client, msg: ClientMsg) {
    touch(c.userId);
    if (c.spectator && msg.type !== 'chat' && msg.type !== 'typing') {
      if (msg.type === 'op') this.send(c, { type: 'reject', opId: String((msg.op as { id?: unknown })?.id ?? ''), reason: 'Spectators can’t draw' });
      return;
    }
    switch (msg.type) {
      case 'op': {
        const op = msg.op;
        const why = this.check(c.userId, op);
        if (why) { this.send(c, { type: 'reject', opId: String((op as { id?: unknown })?.id ?? ''), reason: why }); return; }
        op.author = c.userId;
        op.at = Date.now();
        if (op.t === 'layer.add') op.layer.owner = c.userId;
        if (op.t === 'folder.add') { op.folder.owner = c.userId; delete op.folder.user; }
        this.commit(op, c);
        return;
      }
      case 'live':
        if (validLive(msg.live) && this.can(c.userId, msg.live.layer) && this.liveBudget(c, msg.live.pts.length / 3)) this.broadcast({ type: 'live', from: c.userId, live: msg.live }, c);
        return;
      case 'live-end':
        this.broadcast({ type: 'live-end', from: c.userId, stroke: String(msg.stroke).slice(0, 48) }, c);
        return;
      case 'cursor': {
        const now = Date.now();
        if (!validCoord(msg.x) || !validCoord(msg.y) || now - c.cursorAt < CURSOR_MS) return;
        c.cursorAt = now;
        this.broadcast({ type: 'cursor', from: c.userId, x: msg.x, y: msg.y, drawing: !!msg.drawing }, c);
        return;
      }
      case 'typing':
        this.broadcast({ type: 'typing', from: c.userId, on: !!msg.on }, c);
        return;
      case 'count':
        if (msg.what === 'undo' || msg.what === 'redo') bump(msg.what === 'undo' ? 'undos' : 'redos');
        return;
      case 'chat': {
        const text = String(msg.text ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
        if (!text) return;
        const now = Date.now();
        c.lastChat = c.lastChat.filter((t) => now - t < 10_000);
        if (c.lastChat.length >= 8) { this.send(c, { type: 'error', message: 'Slow down a little.' }); return; }
        c.lastChat.push(now);
        this.pushChat({ id: newId('m_'), from: c.userId, text, at: now });
        this.broadcast({ type: 'typing', from: c.userId, on: false }, c);
        return;
      }
      case 'kick': {
        const target = String(msg.user);
        if (!this.isHost(c.userId) || target === this.info.ownerId || target === c.userId) return;
        if (this.role(target) === 'host' && this.role(c.userId) !== 'owner') return;
        this.expel(target, true);
        this.systemChat(`${getUser(target)?.display_name ?? 'Someone'} was removed by a host`);
        return;
      }
      case 'set-host': {
        const target = String(msg.user);
        if (this.role(c.userId) !== 'owner' || target === this.info.ownerId || !getUser(target)) return;
        if (msg.on) this.hosts.add(target); else this.hosts.delete(target);
        db.prepare('UPDATE rooms SET hosts = ? WHERE id = ?').run(JSON.stringify([...this.hosts]), this.info.id);
        this.broadcastMembers();
        return;
      }
      case 'admit': {
        const w = this.waiting.get(String(msg.user));
        if (!this.isHost(c.userId) || !w) return;
        this.waiting.delete(w.user.id);
        this.toHosts({ type: 'join-request-gone', user: w.user.id });
        if (msg.allow) { this.allowed.add(w.user.id); this.admit(w.ws, w.user); }
        else this.deny(w.ws, 'The host didn’t let you in this time.');
        return;
      }
    }
  }

  private can(userId: string, nodeId: string) {
    const n = this.nodes.get(nodeId);
    return !!n && (n.owner === userId || this.isHost(userId));
  }

  private check(userId: string, op: Op): string | null {
    if (!validOp(op)) return 'Unknown edit';
    const host = this.isHost(userId);
    switch (op.t) {
      case 'stroke': case 'smudge': case 'effect': case 'shape': case 'fill': case 'fillPoly': case 'transform': case 'tiles': case 'layer.clear': case 'layer.props': case 'layer.remove': case 'layer.merge': case 'layer.mask.apply':
        return this.can(userId, op.layer) ? null : 'That layer belongs to someone else';
      case 'layer.add':
      case 'folder.add': {
        const id = op.t === 'layer.add' ? op.layer.id : op.folder.id;
        if (this.nodes.has(id) || id.startsWith('uf_')) return 'Invalid id';
        if (op.parent === null) return host ? null : 'Add layers inside your own folder';
        if (this.nodes.get(op.parent)?.kind !== 'folder') return 'Folder not found';
        return this.can(userId, op.parent) ? null : 'That folder belongs to someone else';
      }
      case 'folder.props':
      case 'folder.remove': {
        const n = this.nodes.get(op.folder);
        if (!n || !this.can(userId, op.folder)) return 'That folder belongs to someone else';
        if (n.user && !host && (op.t === 'folder.remove' || Object.keys(op.props).some((k) => k !== 'visible'))) return 'Your main folder can’t be changed';
        return null;
      }
      case 'node.move': {
        const n = this.nodes.get(op.node);
        if (!n || !this.can(userId, op.node)) return 'That belongs to someone else';
        if ((op.parent === null || n.user) && !host) return 'Only hosts can reorder member folders';
        if (op.parent !== null && (!this.nodes.get(op.parent) || !this.can(userId, op.parent))) return 'That folder belongs to someone else';
        return null;
      }
    }
  }

  private track(op: Op) {
    switch (op.t) {
      case 'layer.add':
        this.nodes.set(op.layer.id, { kind: 'layer', owner: op.layer.owner, parent: op.parent });
        if (op.parent === null) this.rootCount++;
        break;
      case 'folder.add':
        this.nodes.set(op.folder.id, { kind: 'folder', owner: op.folder.owner, parent: op.parent, user: op.folder.user });
        if (op.parent === null) this.rootCount++;
        break;
      case 'layer.remove':
      case 'layer.merge': {
        if (this.nodes.get(op.layer)?.parent === null) this.rootCount--;
        this.nodes.delete(op.layer);
        break;
      }
      case 'folder.remove': {
        if (this.nodes.get(op.folder)?.parent === null) this.rootCount--;
        const drop = (id: string) => {
          this.nodes.delete(id);
          for (const [k, v] of this.nodes) if (v.parent === id) drop(k);
        };
        drop(op.folder);
        break;
      }
      case 'node.move': {
        const n = this.nodes.get(op.node);
        if (!n) break;
        if (n.parent === null) this.rootCount--;
        if (op.parent === null) this.rootCount++;
        n.parent = op.parent;
        break;
      }
    }
  }

  private commit(op: Op, from?: Client) {
    this.track(op);
    if (from) {
      bump('ops');
      const k = op.t === 'stroke' ? 'strokes' : op.t === 'smudge' ? 'smudges' : op.t === 'fill' ? 'fills' : op.t === 'shape' ? 'shapes' : null;
      if (k) bump(k);
    }
    const json = JSON.stringify(op);
    this.ops.push(json);
    const seq = ++this.seq;
    // Relay first; the write joins a batch that goes to disk in one transaction a moment later.
    this.broadcastRaw(`{"type":"op","op":${json},"from":${JSON.stringify(from?.userId ?? 'server')},"seq":${seq}}`, from);
    if (from) this.send(from, { type: 'ack', id: op.id, seq });
    queueOp(this.info.id, seq, json);
    const now = Date.now();
    if (now - this.savedAt > 5000) { this.savedAt = now; updatedAt.run(now, this.info.id); }
    this.maybeAskSnapshot();
  }

  private pushChat(m: ChatMsg) {
    if (!m.system) bump('messages');
    this.chat.push(m);
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    this.broadcast({ type: 'chat', msg: m });
  }

  systemChat(text: string) { this.pushChat({ id: newId('m_'), from: 'system', text, at: Date.now(), system: true }); }

  updateInfo(patch: { name?: string; share?: ShareSettings; ephemeral?: true }) {
    if (patch.name !== undefined) this.info.name = patch.name;
    if (patch.ephemeral) this.info.ephemeral = true;
    if (patch.share) { this.info.share = patch.share; this.info.private = patch.share.visibility === 'private'; }
    if (this.info.private) {
      for (const c of this.clients) if (c.userId !== this.info.ownerId && !c.spectator) this.deny(c.ws, 'The owner made this canvas private.');
      for (const w of this.waiting.values()) w.ws.close(4003, 'private');
      this.waiting.clear();
    } else if (patch.share && !patch.share.approveJoins) {
      for (const w of [...this.waiting.values()]) { this.waiting.delete(w.user.id); this.toHosts({ type: 'join-request-gone', user: w.user.id }); this.admit(w.ws, w.user); }
    }
    for (const c of this.clients) this.send(c, { type: 'room', room: this.infoFor(c) });
    for (const id of new Set([...this.clients].map((c) => c.userId))) notifyFriends(id);
  }

  /** A free host's room closes for everyone once the host has been gone this long. */
  hostGrace(ms: number) {
    if (this.hostTimer) clearTimeout(this.hostTimer);
    this.hostTimer = setTimeout(() => {
      this.broadcast({ type: 'closed', message: 'The host left, so this room closed.' });
      for (const c of this.clients) c.ws.close(4004, 'closed');
      deleteRoom(this.info.id);
    }, ms);
  }

  close() {
    if (this.hostTimer) clearTimeout(this.hostTimer);
    for (const c of this.clients) this.deny(c.ws, 'This canvas was deleted.');
    for (const w of this.waiting.values()) w.ws.close(4003, 'deleted');
    for (const t of this.leaving.values()) clearTimeout(t);
  }

  profileChanged() { this.broadcastMembers(); }
}

const rooms = new Map<string, Room>();

const VISIBILITIES: Visibility[] = ['private', 'open', 'friends', 'unlisted'];

export function cleanShare(raw: unknown): ShareSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const visibility = VISIBILITIES.includes(r.visibility as Visibility) ? r.visibility as Visibility : DEFAULT_SHARE.visibility;
  const flag = (k: keyof ShareSettings) => (typeof r[k] === 'boolean' ? r[k] as boolean : DEFAULT_SHARE[k] as boolean);
  return { visibility, requireLogin: flag('requireLogin'), friendsCanJoin: flag('friendsCanJoin'), approveJoins: flag('approveJoins') };
}

export function saveShare(id: string, s: ShareSettings) {
  const { visibility, ...flags } = s;
  db.prepare('UPDATE rooms SET visibility = ?, share = ?, private = ? WHERE id = ?').run(visibility, JSON.stringify(flags), visibility === 'private' ? 1 : 0, id);
}

/** `ops` seed the room with a canvas brought from a device; they become the owner's layers. */
export function createRoom(owner: UserRow, name: string, settings: DocSettings, share: ShareSettings, ephemeral: boolean, ops: Op[] = []): RoomInfo {
  const id = randomId(8);
  const info: RoomInfo = { id, name, ownerId: owner.id, settings: { ...settings, id: 'doc_' + id }, private: share.visibility === 'private', share, ephemeral };
  const now = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO rooms (id, name, owner_id, settings, created_at, updated_at, watch_key, ephemeral) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, owner.id, JSON.stringify(info.settings), now, now, randomId(16), ephemeral ? 1 : 0);
    const ins = db.prepare('INSERT INTO room_ops (room_id, seq, op) VALUES (?, ?, ?)');
    ops.forEach((op, i) => {
      op.author = owner.id;
      if (op.t === 'layer.add') op.layer.owner = owner.id;
      if (op.t === 'folder.add') { op.folder.owner = owner.id; delete op.folder.user; }
      ins.run(id, i + 1, JSON.stringify(op));
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  saveShare(id, share);
  return info;
}

export function getRoom(id: string): Room | undefined {
  let r = rooms.get(id);
  if (r) return r;
  const row = db.prepare('SELECT id, name, owner_id, settings, hosts, visibility, share, watch_key, ephemeral, invited FROM rooms WHERE id = ?').get(id) as
    { id: string; name: string; owner_id: string; settings: string; hosts: string; visibility: string; share: string; watch_key: string | null; ephemeral: number; invited: string } | undefined;
  if (!row) return undefined;
  const share = cleanShare({ ...JSON.parse(row.share), visibility: row.visibility });
  let key = row.watch_key;
  if (!key) { key = randomId(16); db.prepare('UPDATE rooms SET watch_key = ? WHERE id = ?').run(key, id); }
  r = new Room({ id: row.id, name: row.name, ownerId: row.owner_id, settings: JSON.parse(row.settings), private: share.visibility === 'private', share, ephemeral: !!row.ephemeral }, JSON.parse(row.hosts), key, JSON.parse(row.invited));
  rooms.set(id, r);
  return r;
}

export const liveRooms = () => [...rooms.values()].filter((r) => r.clients.size);

/** Drops every connection a person has, e.g. after a ban or a forced sign-out. */
export function disconnectUser(userId: string, reason: string) {
  for (const r of liveRooms()) for (const c of [...r.clients]) if (c.userId === userId) { c.ws.close(4001, reason); r.clients.delete(c); }
}

export function roomsWithUser(userId: string): Room[] {
  return [...rooms.values()].filter((r) => r.connections(userId) > 0);
}

export function projectsOf(userId: string, limit = 60): ProjectInfo[] {
  const rows = db.prepare(`SELECT id, name, visibility, created_at, updated_at, thumb_version, thumb IS NOT NULL AS has_thumb
    FROM rooms WHERE owner_id = ? AND ephemeral = 0 ORDER BY coalesce(updated_at, created_at) DESC LIMIT ?`).all(userId, limit) as
    { id: string; name: string; visibility: Visibility; created_at: number; updated_at: number | null; thumb_version: number; has_thumb: number }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, private: r.visibility === 'private', visibility: r.visibility, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at,
    thumb: r.has_thumb ? `/thumbs/${r.id}?v=${r.thumb_version}` : null,
    online: rooms.get(r.id)?.members().length ?? 0,
  }));
}

/** After a restart, free hosts get a while to come back before their rooms close. */
export function resumeEphemeral(ms: number) {
  for (const r of db.prepare('SELECT id FROM rooms WHERE ephemeral = 1').all() as { id: string }[]) getRoom(r.id)?.hostGrace(ms);
}

export function deleteRoom(id: string) {
  flushOps();
  rooms.get(id)?.close();
  rooms.delete(id);
  db.prepare('DELETE FROM room_ops WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM room_snapshots WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}
