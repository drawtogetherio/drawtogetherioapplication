import { DrawDoc, toWire } from '../core/document';
import { ServerConfig, api } from '../net/api';
import { RoomClient } from '../net/roomClient';
import type { MyProfile } from '../shared/profile';
import type { App } from './app';
import { modal, newCanvasDialog } from './dialogs';
import { h } from './dom';
import { icon } from './icons';
import { avatarEl } from './people';
import { profileDialog } from './profileDialog';
import { saveThumbnail } from '../io/thumbnail';
import { deleteCanvas, listCanvases } from '../io/localStore';
import { LocalCopy } from './localCopy';
import type { LiveEvent } from '../net/api';
import { PRIVATE_ROOM_MSG, RoomInfo, ShareSettings, WATCH_KEY_RE } from '../shared/protocol';
import { cleanPrefs } from '../shared/prefs';

export const PREFS_KEY = 'doodlehive.prefs';

const blankDoc = () => DrawDoc.create({ width: 2048, height: 2048, infinite: true, background: '#ffffff' });
const THUMB_DELAY_MS = 15_000;
const settingsOf = (info: RoomInfo) => ({ width: info.settings.width, height: info.settings.height, infinite: info.settings.infinite, background: info.settings.background });

export class Session {
  server: ServerConfig | null = null;
  /** No server, or "draw without an account". */
  offline = false;
  private thumbTimer = 0;
  private thumbDirty = false;
  /** The watch link's secret, when we came in through one. */
  private watch: string | null = null;
  /** The copy of the open canvas kept in this browser (free accounts; everyone in a live-only room). */
  local: LocalCopy | null = null;

  constructor(private app: App) {}

  get ed() { return this.app.ed; }
  get me() { return this.ed.me; }

  roomFromUrl(): { id: string; watch: string | null } | null {
    const q = new URLSearchParams(location.search);
    const id = q.get('room'), watch = q.get('watch');
    return id && /^[a-z0-9]{4,16}$/.test(id) ? { id, watch: watch && WATCH_KEY_RE.test(watch) ? watch : null } : null;
  }

  private setUrl(p: { room?: string; watch?: string | null; canvas?: string; by?: undefined; patreon?: undefined } = {}) {
    const u = new URL(location.href);
    for (const k of ['room', 'watch', 'canvas', 'by', 'patreon'] as const) { const v = p[k]; if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
    history.replaceState(null, '', u);
  }

  /** `by` names who shared it, for the link's embed. */
  inviteLinkFor(id: string, extra = '') { return `${location.origin}/app?room=${id}${extra}${this.me ? `&by=${encodeURIComponent(this.me.handle)}` : ''}`; }
  inviteLink() { return this.ed.room ? this.inviteLinkFor(this.ed.room.id) : ''; }
  watchLink() {
    const room = this.ed.room, key = room?.info?.watchKey ?? this.watch;
    return room && key ? this.inviteLinkFor(room.id, `&watch=${key}`) : '';
  }

  async start() {
    this.server = await api.config();
    if (!this.server || new URLSearchParams(location.search).has('offline')) {
      this.offline = true;
      try { this.ed.prefs = cleanPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')); } catch { /* fresh device */ }
      this.app.refreshAccount();
      this.booted();
      newCanvasDialog((doc) => this.ed.setDoc(doc), false);
      return;
    }
    this.ed.me = await api.me().catch(() => null);
    if (!this.ed.me) {
      location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
      return;
    }
    this.ed.prefs = this.ed.me.prefs;
    this.app.refreshAccount();
    this.listen();
    addEventListener('pagehide', () => this.local?.close());
    if (this.me?.needsSetup) {
      const saved = await profileDialog(this.me, true);
      if (saved) this.ed.me = saved;
      this.app.refreshAccount();
    }
    const q = new URLSearchParams(location.search), room = this.roomFromUrl(), canvas = q.get('canvas'), patreon = q.get('patreon');
    if (room) this.joinRoom(room.id, room.watch);
    else if (canvas && !this.me?.guest) this.openLocal(canvas);
    else this.showHome();
    if (patreon) {
      this.ed.toast(patreon === 'linked' ? (this.me?.patreon?.active ? 'Patreon linked. Premium is on.' : 'Patreon linked. No active membership yet.')
        : patreon === 'taken' ? 'That Patreon account is linked to another Doodlehive account.' : 'Patreon link failed. Try again.');
      this.setUrl({ room: room?.id, watch: room?.watch, canvas: canvas ?? undefined });
    }
  }

  /** Friends' presence and invites, pushed by the server. */
  private listen() {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      let e: LiveEvent;
      try { e = JSON.parse(ev.data); } catch { return; }
      if (e.type === 'friends') { if (this.app.home.visible) this.app.home.loadFriends(); }
      else if (e.type === 'notices') this.app.home.loadNotices();
      else if (e.type === 'invite') this.showInvite(e);
    };
  }

  private showInvite(e: Extract<LiveEvent, { type: 'invite' }>) {
    if (this.ed.room?.id === e.room.id) return;
    const card = h('div.invite-toast', { role: 'alert' },
      h('span', {}, h('strong', {}, e.from.displayName), ' invited you to ', h('strong', {}, e.room.name)),
      h('button.btn.small.primary', { type: 'button', onclick: () => { card.remove(); this.joinRoom(e.room.id); } }, 'Join'),
      h('button.icon-btn', { type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss', html: icon('x', 16), onclick: () => card.remove() }),
    );
    document.body.append(card);
    setTimeout(() => card.remove(), 60_000);
  }

  showHome() {
    if (this.offline) return;
    this.app.home.show();
    this.booted();
  }

  /** The grey start screen stays up until there is something to look at. */
  private booted(text?: string) {
    const el = document.getElementById('boot');
    if (!el) return;
    if (text) { el.lastElementChild!.textContent = text; return; }
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }

  createNew() {
    const guest = !!this.me?.guest;
    let close = () => {};
    const card = (title: string, text: string, ic: string, solo: boolean) =>
      h('button.preset-card.home-card', {
        html: `${icon(ic, 26)}<strong>${title}</strong><small>${text}</small>`,
        onclick: () => { close(); this.createFlow(solo); },
      });
    const body = h('div.modal-body', {},
      guest ? null : h('div.preset-grid.home-grid', {},
        card('Draw alone', this.me?.premium ? 'Private, saved to your account' : 'Private, saved on this device', 'brush', true),
        card('Shared room', 'Draw together on one canvas', 'users', false),
      ),
      this.joinSection(() => close()),
    );
    close = modal(guest ? 'Join a canvas' : 'Create a canvas or join one', body, []);
  }

  /** Looks the room up first; a room you can't join, or can't see, reads as not found. */
  private joinSection(close: () => void): HTMLElement {
    const input = h('input', { type: 'text', id: 'join-code', placeholder: 'Room link or code', 'aria-label': 'Room link or code', autocomplete: 'off', spellcheck: 'false' });
    const err = h('p.field-error', { role: 'alert' });
    const preview = h('div.join-preview', { hidden: true });
    const form = h('form.join-form', {}, input, h('button.btn', { type: 'submit' }, 'Find'));
    let seq = 0, timer = 0;
    const lookup = async () => {
      const n = ++seq;
      preview.hidden = true;
      err.textContent = '';
      const m = /(?:room=)?([a-z0-9]{4,16})\s*$/i.exec(input.value.trim());
      if (!m) { if (input.value.trim()) err.textContent = 'Unable to find room'; return; }
      try {
        const info = await api.room(m[1].toLowerCase());
        if (n !== seq) return;
        if (!info.joinable) throw new Error();
        preview.replaceChildren(
          ...(info.owner ? [avatarEl(info.owner, 36)] : []),
          h('div.join-text', {}, h('strong', {}, info.name), h('small.muted', {}, info.owner ? `Hosted by ${info.owner.displayName}` : '')),
          h('button.btn.join-go', { type: 'button', onclick: () => { close(); this.joinRoom(info.id); } }, 'Join'),
        );
        preview.hidden = false;
      } catch { if (n === seq) err.textContent = 'Unable to find room'; }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); lookup(); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(lookup, 350); });
    return h('div.join-section', {}, h('h3', {}, 'Join a canvas'), form, err, preview);
  }

  createFlow(solo: boolean) {
    newCanvasDialog(() => {}, true, {
      solo,
      onCreate: async (c) => {
        const settings = { width: c.width, height: c.height, infinite: c.infinite, background: c.background };
        if (this.me?.premium) { this.joinRoom((await api.createRoom(c.roomName, settings, c.share)).id); return; }
        const copy = await LocalCopy.create(this.me!.id, c.roomName, settings, c.share), doc = DrawDoc.create(settings);
        copy.replaceWith(doc.log);
        this.startLocal(copy, doc);
        if (c.share.visibility !== 'private') await this.shareLocal(c.share);
      },
    });
  }

  // ---- Canvases on this device ----

  private attachCopy(copy: LocalCopy) {
    this.local = copy;
    this.ed.onOp = (op) => { copy.push(op); copy.thumb(this.ed.doc); };
  }

  private startLocal(copy: LocalCopy, doc: DrawDoc) {
    this.closeAll(copy);
    this.app.home.hide();
    this.setUrl({ canvas: copy.meta.id });
    this.ed.setDoc(doc);
    this.attachCopy(copy);
    if (!copy.meta.thumb && doc.log.length > 1) copy.thumb(doc);
    this.app.refreshRoom();
    this.booted();
  }

  async openLocal(id: string) {
    const opened = await LocalCopy.open(id).catch(() => null);
    if (!opened) { this.showHome(); return; }
    const { copy, ops } = opened;
    if (copy.meta.room) {
      const live = await api.room(copy.meta.room).catch(() => null);
      if (live?.joinable) { this.joinRoom(live.id, null, { copy }); return; }
      await copy.patch({ room: null });
    }
    this.startLocal(copy, await copy.toDoc(ops));
  }

  /** Premium accounts keep canvases on the server; one made while free moves there when opened. */
  async moveLocalToServer(id: string) {
    const opened = await LocalCopy.open(id).catch(() => null);
    if (!opened) return;
    const m = opened.copy.meta;
    if (m.room && (await api.room(m.room).catch(() => null))?.joinable) { this.joinRoom(m.room, null, { copy: opened.copy }); return; }
    try {
      const info = await api.createRoom(m.name, m.settings, { ...m.share, visibility: 'private' }, opened.ops);
      await deleteCanvas(id);
      this.joinRoom(info.id);
    } catch (e) { this.app.toast((e as Error).message); }
  }

  /** Opens a live-only room seeded with this canvas; it closes a little after we leave. */
  async shareLocal(share: ShareSettings) {
    const copy = this.local;
    if (!copy) return;
    if (share.visibility === 'private') { await copy.patch({ share }); return; }
    await copy.flush();
    const info = await api.createRoom(copy.meta.name, copy.meta.settings, share, this.ed.doc.log.map(toWire));
    await copy.patch({ room: info.id, share });
    this.joinRoom(info.id, null, { copy });
    await this.app.copyInvite();
  }

  /** Close our live-only room and keep drawing on the device copy. */
  async unshare() {
    const room = this.ed.room, copy = this.local;
    if (!room || !copy) return;
    this.closeAll(copy);
    this.attachCopy(copy);
    this.setUrl({ canvas: copy.meta.id });
    this.app.refreshRoom();
    copy.patch({ room: null, share: { ...copy.meta.share, visibility: 'private' } });
    await api.deleteRoom(room.id).catch(() => {});
  }

  /** Live-only rooms and canvases brought from this device leave a copy here; it follows the room's history. */
  private async syncCopy(room: RoomClient, copy: LocalCopy | null, take: boolean) {
    const me = this.me!;
    if (!copy && !room.spectator && !me.guest && (room.info!.ephemeral || take)) {
      const have = (await listCanvases(me.id).catch(() => [])).find((c) => c.room === room.id);
      copy = have ? new LocalCopy(have, 0) : await LocalCopy.create(me.id, room.info!.name, settingsOf(room.info!), room.info!.share, room.id);
    }
    if (!copy || this.ed.room !== room) return;
    this.attachCopy(copy);
    copy.replaceWith(this.ed.doc.log);
    copy.thumb(this.ed.doc);
    this.app.refreshRoom();
  }

  /** The room ended under us: carry on with the device copy if we have one. */
  private roomEnded() {
    const copy = this.local;
    if (!copy || this.ed.room?.spectator) { this.leaveRoom(); return; }
    this.closeAll(copy);
    this.attachCopy(copy);
    copy.patch({ room: null });
    this.setUrl({ canvas: copy.meta.id });
    this.app.refreshRoom();
  }

  // ---- Rooms ----

  /** `takeLocal` moves an old server canvas of a free account to this device. */
  joinRoom(id: string, watch: string | null = null, opts: { copy?: LocalCopy; takeLocal?: boolean } = {}) {
    this.closeAll(opts.copy ?? null);
    if (opts.copy) this.attachCopy(opts.copy); else this.ed.setDoc(blankDoc());
    this.app.home.hide();
    this.setUrl({ room: id, watch });
    this.watch = watch;
    const room = new RoomClient(id, watch);
    this.ed.room = room;
    this.app.roomUI.attach(room);
    this.app.refreshRoom();
    let waitClose: (() => void) | null = null;
    const stopWaiting = () => { waitClose?.(); waitClose = null; };
    room.on((e) => {
      if (e.kind === 'status' && room.status === 'waiting' && !waitClose) {
        this.booted();
        const cancel = h('button.btn', { type: 'button', onclick: () => { stopWaiting(); this.leaveRoom(); } }, 'Cancel');
        waitClose = modal('Waiting to join', h('div.modal-body', {}, h('p.muted', {}, 'The host will let you in shortly.')), [cancel], undefined, false);
      } else if (e.kind !== 'status' || room.status !== 'waiting') {
        if (room.status !== 'waiting') stopWaiting();
      }
      if (e.kind === 'ready') {
        this.ed.setDoc(e.doc, !e.first);
        this.ed.ensureOwnLayer();
        this.app.refreshRoom();
        this.booted();
        if (e.first && (room.spectator || !room.info?.private)) this.app.toast(`${room.spectator ? 'Watching' : 'Joined'} ${room.info?.name ?? 'room'}`);
        if (e.first && opts.takeLocal) api.updateRoom(id, { ephemeral: true }).catch(() => {});
        this.syncCopy(room, this.local, !!opts.takeLocal);
      } else if (e.kind === 'progress') {
        this.booted(`Loading… ${Math.round((100 * e.done) / e.total)}%`);
      } else if (e.kind === 'op') {
        this.scheduleThumb();
        this.local?.push(e.op);
        this.local?.thumb(this.ed.doc);
      } else if (e.kind === 'error') {
        if (e.message === PRIVATE_ROOM_MSG) { location.replace('/404'); return; }
        const ended = room.status === 'closed';
        this.app.toast(ended && this.local && !room.spectator ? `${e.message} Your copy stays on this device.` : e.message);
        if (ended) this.roomEnded();
      } else if (e.kind === 'status' || e.kind === 'members' || e.kind === 'room') {
        if (room.status === 'closed' && this.ed.room === room) { this.roomEnded(); return; }
        if (e.kind === 'room' && room.info) this.local?.patch({ name: room.info.name, share: room.info.share });
        this.app.refreshRoom();
      }
    });
  }

  /** Server thumbnails, for canvases kept there. */
  scheduleThumb() {
    const room = this.ed.room;
    if (!room || room.info?.ownerId !== room.you) return;
    this.thumbDirty = true;
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.flushThumb(), THUMB_DELAY_MS);
  }

  flushThumb() {
    clearTimeout(this.thumbTimer);
    const room = this.ed.room;
    if (!this.thumbDirty || !room) return Promise.resolve();
    this.thumbDirty = false;
    return saveThumbnail(this.ed.doc, room.id).catch(() => {});
  }

  /** Leaves the room and ends the device copy, except `keep`. */
  private closeAll(keep: LocalCopy | null) {
    const room = this.ed.room, saving = this.flushThumb();
    if (room) {
      room.close();
      this.ed.room = null;
      this.watch = null;
      this.app.roomUI.detach();
    }
    this.ed.onOp = null;
    const ending = this.local && this.local !== keep ? this.local.close() : null;
    this.local = keep;
    return Promise.all([saving, ending]);
  }

  async leaveRoom(toHome = true) {
    if (!this.ed.room && !this.local) { if (toHome) this.showHome(); return; }
    const saving = this.closeAll(null);
    this.setUrl();
    this.ed.setDoc(blankDoc());
    this.app.refreshRoom();
    if (toHome) { await saving; this.showHome(); }
  }

  async editProfile() {
    if (!this.me) return;
    const saved = await profileDialog(this.me, false, !!this.server?.patreonLink, this.server?.patreon);
    if (saved) { this.ed.me = saved as MyProfile; this.app.refreshAccount(); }
  }

  async logout(then = '/') {
    await api.logout().catch(() => {});
    location.href = then;
  }
}
