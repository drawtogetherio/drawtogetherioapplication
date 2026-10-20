import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { db, getUser, newId, publicProfile, UserRow } from './db.ts';
import { touch } from './social.ts';
import type { DocSettings, Op } from '../src/core/model.ts';
import { CHAT_MAX, ChatMsg, ClientMsg, Member, ProjectInfo, Role, RoomInfo, ServerMsg, userFolderId } from '../src/shared/protocol.ts';

interface NodeInfo { owner?: string; parent: string | null; user?: boolean; kind: 'layer' | 'folder' }

interface Client { ws: WebSocket; userId: string; lastChat: number[] }

const KICK_BLOCK_MS = 10 * 60_000;
const OP_TYPES = new Set(['stroke', 'shape', 'fill', 'transform', 'tiles', 'layer.add', 'layer.remove', 'layer.props',
  'layer.merge', 'layer.clear', 'folder.add', 'folder.remove', 'folder.props', 'node.move']);

/**
 * One shared canvas. The server keeps the op log (so newcomers can rebuild the canvas), tracks who
 * owns each layer/folder to enforce permissions, and relays presence and chat.
 */
export class Room {
  readonly clients = new Set<Client>();
  private ops: string[] = []; // serialized ops, in order
  private nodes = new Map<string, NodeInfo>();
  private rootCount = 0;
  private chat: ChatMsg[] = [];
  private kicked = new Map<string, number>();
  private leaving = new Map<string, ReturnType<typeof setTimeout>>();
  hosts: Set<string>;

  constructor(public info: RoomInfo, hosts: string[]) {
    this.hosts = new Set(hosts);
    const rows = db.prepare('SELECT op FROM room_ops WHERE room_id = ? ORDER BY seq').all(info.id) as { op: string }[];
    for (const r of rows) { this.ops.push(r.op); this.track(JSON.parse(r.op)); }
  }

  role(userId: string): Role {
    return userId === this.info.ownerId ? 'owner' : this.hosts.has(userId) ? 'host' : 'member';
  }
  isHost(userId: string) { return this.role(userId) !== 'member'; }

  members(): Member[] {
    const seen = new Map<string, Member>();
    for (const c of this.clients) {
      if (seen.has(c.userId)) continue;
      const u = getUser(c.userId);
      if (u) seen.set(c.userId, { ...publicProfile(u), role: this.role(c.userId) });
    }
    return [...seen.values()];
  }

  send(c: Client, m: ServerMsg) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); }
  broadcast(m: ServerMsg, except?: Client) {
    const s = JSON.stringify(m);
    for (const c of this.clients) if (c !== except && c.ws.readyState === 1) c.ws.send(s);
  }

  join(ws: WebSocket, user: UserRow) {
    if (this.info.private && user.id !== this.info.ownerId) {
      ws.send(JSON.stringify({ type: 'error', message: 'This canvas is private.' } satisfies ServerMsg));
      ws.close(4003, 'private');
      return;
    }
    touch(user.id);
    const until = this.kicked.get(user.id);
    if (until && until > Date.now()) {
      ws.send(JSON.stringify({ type: 'error', message: 'You were removed from this room. Try again later.' } satisfies ServerMsg));
      ws.close(4003, 'kicked');
      return;
    }
    const c: Client = { ws, userId: user.id, lastChat: [] };
    const firstConnection = ![...this.clients].some((x) => x.userId === user.id);
    this.clients.add(c);

    // Every member gets a top-level folder named after them, created once per room.
    const fid = userFolderId(user.id);
    if (!this.nodes.has(fid)) {
      this.commit({
        t: 'folder.add', id: newId('op_'), author: 'server', parent: null, index: this.rootCount,
        folder: { id: fid, name: user.display_name, visible: true, owner: user.id, user: true, color: user.favorite_color },
      });
    }
    // Ops are already JSON; splice them in instead of re-serializing.
    const welcome = JSON.stringify({ type: 'welcome', room: this.info, you: user.id, members: this.members(), ops: [], chat: this.chat.slice(-50) } satisfies ServerMsg);
    ws.send(welcome.replace('"ops":[]', `"ops":[${this.ops.join(',')}]`));
    const pendingLeave = this.leaving.get(user.id);
    if (pendingLeave) { clearTimeout(pendingLeave); this.leaving.delete(user.id); } // quick reconnect: say nothing
    else if (firstConnection) this.systemChat(`${user.display_name} joined`);
    this.broadcast({ type: 'members', members: this.members() }, c);

    ws.on('message', (data) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      this.handle(c, msg);
    });
    ws.on('close', () => {
      this.clients.delete(c);
      if (![...this.clients].some((x) => x.userId === c.userId)) {
        const u = getUser(c.userId);
        if (u && !this.kicked.has(c.userId)) {
          // Wait a moment so a page reload or network blip doesn't post "left" + "joined".
          this.leaving.set(c.userId, setTimeout(() => { this.leaving.delete(c.userId); this.systemChat(`${u.display_name} left`); }, 5000));
        }
        this.broadcast({ type: 'typing', from: c.userId, on: false });
      }
      this.broadcast({ type: 'members', members: this.members() });
    });
  }

  private handle(c: Client, msg: ClientMsg) {
    touch(c.userId);
    switch (msg.type) {
      case 'op': {
        const op = msg.op;
        const why = this.check(c.userId, op);
        if (why) { this.send(c, { type: 'reject', opId: op?.id, reason: why }); return; }
        op.author = c.userId;
        if (op.t === 'layer.add') op.layer.owner = c.userId;
        if (op.t === 'folder.add') { op.folder.owner = c.userId; delete op.folder.user; }
        this.commit(op, c);
        return;
      }
      case 'live':
        if (msg.live && this.can(c.userId, msg.live.layer)) this.broadcast({ type: 'live', from: c.userId, live: msg.live }, c);
        return;
      case 'live-end':
        this.broadcast({ type: 'live-end', from: c.userId, stroke: String(msg.stroke) }, c);
        return;
      case 'cursor':
        if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) this.broadcast({ type: 'cursor', from: c.userId, x: msg.x, y: msg.y, drawing: !!msg.drawing }, c);
        return;
      case 'typing':
        this.broadcast({ type: 'typing', from: c.userId, on: !!msg.on }, c);
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
        this.kicked.set(target, Date.now() + KICK_BLOCK_MS);
        const name = getUser(target)?.display_name ?? 'Someone';
        for (const x of [...this.clients]) {
          if (x.userId !== target) continue;
          this.send(x, { type: 'kicked', by: c.userId });
          x.ws.close(4003, 'kicked');
          this.clients.delete(x);
        }
        this.systemChat(`${name} was removed by a host`);
        this.broadcast({ type: 'members', members: this.members() });
        return;
      }
      case 'set-host': {
        if (this.role(c.userId) !== 'owner' || msg.user === this.info.ownerId) return;
        if (msg.on) this.hosts.add(msg.user); else this.hosts.delete(msg.user);
        db.prepare('UPDATE rooms SET hosts = ? WHERE id = ?').run(JSON.stringify([...this.hosts]), this.info.id);
        this.broadcast({ type: 'members', members: this.members() });
        return;
      }
      case 'ping':
        this.send(c, { type: 'pong' });
        return;
    }
  }

  private can(userId: string, nodeId: string) {
    const n = this.nodes.get(nodeId);
    return !!n && (n.owner === userId || this.isHost(userId));
  }

  /** Why an op is not allowed, or null if it is. */
  private check(userId: string, op: Op): string | null {
    if (!op || typeof op !== 'object' || !OP_TYPES.has(op.t) || typeof op.id !== 'string') return 'Unknown edit';
    const host = this.isHost(userId);
    switch (op.t) {
      case 'stroke': case 'shape': case 'fill': case 'transform': case 'tiles': case 'layer.clear': case 'layer.props': case 'layer.remove':
        return this.can(userId, op.layer) ? null : 'That layer belongs to someone else';
      case 'layer.merge': {
        const n = this.nodes.get(op.layer);
        if (!n || !this.can(userId, op.layer)) return 'That layer belongs to someone else';
        return null;
      }
      case 'layer.add':
      case 'folder.add': {
        const id = op.t === 'layer.add' ? op.layer?.id : op.folder?.id;
        if (typeof id !== 'string' || this.nodes.has(id) || id.startsWith('uf_')) return 'Invalid id';
        if (op.parent === null) return host ? null : 'Add layers inside your own folder';
        if (!this.nodes.get(op.parent) || this.nodes.get(op.parent)!.kind !== 'folder') return 'Folder not found';
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
    return 'Unknown edit';
  }

  /** Keep the ownership tree in step with the op log. */
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
        const n = this.nodes.get(op.layer);
        if (n?.parent === null) this.rootCount--;
        this.nodes.delete(op.layer);
        break;
      }
      case 'folder.remove': {
        const n = this.nodes.get(op.folder);
        if (n?.parent === null) this.rootCount--;
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

  private seq = 0;
  private savedAt = 0;
  private commit(op: Op, from?: Client) {
    this.track(op);
    const json = JSON.stringify(op);
    this.ops.push(json);
    if (!this.seq) this.seq = (db.prepare('SELECT max(seq) AS s FROM room_ops WHERE room_id = ?').get(this.info.id) as { s: number | null }).s ?? 0;
    db.prepare('INSERT INTO room_ops (room_id, seq, op) VALUES (?, ?, ?)').run(this.info.id, ++this.seq, json);
    const now = Date.now();
    if (now - this.savedAt > 5000) { this.savedAt = now; db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(now, this.info.id); }
    this.broadcast({ type: 'op', op, from: from?.userId ?? 'server' }, from);
  }

  private pushChat(m: ChatMsg) {
    this.chat.push(m);
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    this.broadcast({ type: 'chat', msg: m });
  }

  systemChat(text: string) { this.pushChat({ id: newId('m_'), from: 'system', text, at: Date.now(), system: true }); }

  /** The owner renamed the canvas or changed who can join. */
  updateInfo(patch: { name?: string; private?: boolean }) {
    Object.assign(this.info, patch);
    if (this.info.private) {
      for (const c of this.clients) {
        if (c.userId === this.info.ownerId) continue;
        this.send(c, { type: 'error', message: 'The owner made this canvas private.' });
        c.ws.close(4003, 'private');
      }
    }
    this.broadcast({ type: 'room', room: this.info });
  }

  /** The canvas was deleted: disconnect everyone. */
  close() {
    for (const c of this.clients) { this.send(c, { type: 'error', message: 'This canvas was deleted.' }); c.ws.close(4003, 'deleted'); }
    for (const t of this.leaving.values()) clearTimeout(t);
  }

  /** A member changed their profile: refresh the member list for everyone. */
  profileChanged() { this.broadcast({ type: 'members', members: this.members() }); }
}

const rooms = new Map<string, Room>();

export function createRoom(owner: UserRow, name: string, settings: DocSettings, isPrivate = false): RoomInfo {
  // Short, readable room codes.
  const id = Array.from(crypto.randomBytes(8), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  const info: RoomInfo = { id, name, ownerId: owner.id, settings: { ...settings, id: 'doc_' + id }, private: isPrivate };
  const now = Date.now();
  db.prepare('INSERT INTO rooms (id, name, owner_id, settings, created_at, updated_at, private) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, owner.id, JSON.stringify(info.settings), now, now, isPrivate ? 1 : 0);
  return info;
}

export function getRoom(id: string): Room | undefined {
  let r = rooms.get(id);
  if (r) return r;
  const row = db.prepare('SELECT id, name, owner_id, settings, hosts, private FROM rooms WHERE id = ?').get(id) as
    { id: string; name: string; owner_id: string; settings: string; hosts: string; private: number } | undefined;
  if (!row) return undefined;
  r = new Room({ id: row.id, name: row.name, ownerId: row.owner_id, settings: JSON.parse(row.settings), private: !!row.private }, JSON.parse(row.hosts));
  rooms.set(id, r);
  return r;
}

export function roomsWithUser(userId: string): Room[] {
  return [...rooms.values()].filter((r) => [...r.clients].some((c) => c.userId === userId));
}

/** Canvases someone started, newest activity first (the home screen's "Recent"). */
export function projectsOf(userId: string, limit = 60): ProjectInfo[] {
  const rows = db.prepare(`SELECT id, name, private, created_at, updated_at, thumb_version, thumb IS NOT NULL AS has_thumb
    FROM rooms WHERE owner_id = ? ORDER BY coalesce(updated_at, created_at) DESC LIMIT ?`).all(userId, limit) as
    { id: string; name: string; private: number; created_at: number; updated_at: number | null; thumb_version: number; has_thumb: number }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, private: !!r.private, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at,
    thumb: r.has_thumb ? `/thumbs/${r.id}?v=${r.thumb_version}` : null,
    online: rooms.get(r.id)?.members().length ?? 0,
  }));
}

export function deleteRoom(id: string) {
  rooms.get(id)?.close();
  rooms.delete(id);
  db.prepare('DELETE FROM room_ops WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}
