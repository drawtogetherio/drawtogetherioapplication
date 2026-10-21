import { DrawDoc } from '../core/document';
import { ServerConfig, api } from '../net/api';
import { RoomClient } from '../net/roomClient';
import type { MyProfile } from '../shared/profile';
import type { App } from './app';
import { modal, newCanvasDialog } from './dialogs';
import { h } from './dom';
import { icon } from './icons';
import { profileDialog } from './profileDialog';
import { saveThumbnail } from '../io/thumbnail';
import type { LiveEvent } from '../net/api';
import { PRIVATE_ROOM_MSG, WATCH_KEY_RE } from '../shared/protocol';
import { cleanPrefs } from '../shared/prefs';

export const PREFS_KEY = 'doodlehive.prefs';

const blankDoc = () => DrawDoc.create({ width: 2048, height: 2048, infinite: true, background: '#ffffff' });
const THUMB_DELAY_MS = 15_000;

export class Session {
  server: ServerConfig | null = null;
  /** No server, or "draw without an account". */
  offline = false;
  private thumbTimer = 0;
  private thumbDirty = false;
  /** The watch link's secret, when we came in through one. */
  private watch: string | null = null;

  constructor(private app: App) {}

  get ed() { return this.app.ed; }
  get me() { return this.ed.me; }

  roomFromUrl(): { id: string; watch: string | null } | null {
    const q = new URLSearchParams(location.search);
    const id = q.get('room'), watch = q.get('watch');
    return id && /^[a-z0-9]{4,16}$/.test(id) ? { id, watch: watch && WATCH_KEY_RE.test(watch) ? watch : null } : null;
  }

  private setUrlRoom(id: string | null, watch: string | null = null) {
    const u = new URL(location.href);
    if (id) u.searchParams.set('room', id); else u.searchParams.delete('room');
    if (watch) u.searchParams.set('watch', watch); else u.searchParams.delete('watch');
    history.replaceState(null, '', u);
  }

  inviteLinkFor(id: string) { return `${location.origin}/app?room=${id}`; }
  inviteLink() { return this.ed.room ? this.inviteLinkFor(this.ed.room.id) : ''; }
  watchLink() {
    const room = this.ed.room, key = room?.info?.watchKey ?? this.watch;
    return room && key ? `${this.inviteLinkFor(room.id)}&watch=${key}` : '';
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
    if (this.me?.needsSetup) {
      const saved = await profileDialog(this.me, true);
      if (saved) this.ed.me = saved;
      this.app.refreshAccount();
    }
    const room = this.roomFromUrl();
    if (room) this.joinRoom(room.id, room.watch);
    else this.showHome();
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
    if (this.me?.guest) { this.app.toast('Log in with Discord to make your own canvases'); return; }
    let close = () => {};
    const card = (title: string, text: string, ic: string, solo: boolean) =>
      h('button.preset-card.home-card', {
        html: `${icon(ic, 26)}<strong>${title}</strong><small>${text}</small>`,
        onclick: () => { close(); this.createFlow(solo); },
      });
    const body = h('div.modal-body', {},
      h('div.preset-grid.home-grid', {},
        card('Draw alone', 'Private, saved to your account', 'brush', true),
        card('Shared room', 'Draw together on one canvas', 'users', false),
      ),
    );
    close = modal('Create new', body, []);
  }

  createFlow(solo: boolean) {
    newCanvasDialog(() => {}, true, {
      solo,
      onCreate: async (c) => {
        const info = await api.createRoom(c.roomName, { width: c.width, height: c.height, infinite: c.infinite, background: c.background }, c.share);
        this.joinRoom(info.id);
      },
    });
  }

  joinRoom(id: string, watch: string | null = null) {
    this.leaveRoom(false);
    this.app.home.hide();
    this.setUrlRoom(id, watch);
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
      } else if (e.kind === 'progress') {
        this.booted(`Loading… ${Math.round((100 * e.done) / e.total)}%`);
      } else if (e.kind === 'op') {
        this.scheduleThumb();
      } else if (e.kind === 'error') {
        if (e.message === PRIVATE_ROOM_MSG) { location.replace('/404'); return; }
        this.app.toast(e.message);
        if (room.status === 'closed') this.leaveRoom();
      } else if (e.kind === 'status' || e.kind === 'members' || e.kind === 'room') {
        if (room.status === 'closed' && this.ed.room === room) { this.leaveRoom(); return; }
        this.app.refreshRoom();
      }
    });
  }

  scheduleThumb() {
    const room = this.ed.room;
    if (!room || room.info?.ownerId !== room.you) return;
    this.thumbDirty = true;
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.flushThumb(), THUMB_DELAY_MS);
  }

  private flushThumb() {
    clearTimeout(this.thumbTimer);
    const room = this.ed.room;
    if (!this.thumbDirty || !room) return Promise.resolve();
    this.thumbDirty = false;
    return saveThumbnail(this.ed.doc, room.id).catch(() => {});
  }

  async leaveRoom(toHome = true) {
    const room = this.ed.room;
    if (!room) { if (toHome) this.showHome(); return; }
    const saving = this.flushThumb();
    room.close();
    this.ed.room = null;
    this.watch = null;
    this.app.roomUI.detach();
    this.setUrlRoom(null);
    this.ed.setDoc(blankDoc());
    this.app.refreshRoom();
    if (toHome) { await saving; this.showHome(); }
  }

  async editProfile() {
    if (!this.me) return;
    const saved = await profileDialog(this.me, false);
    if (saved) { this.ed.me = saved as MyProfile; this.app.refreshAccount(); }
  }

  async logout(then = '/') {
    await api.logout().catch(() => {});
    location.href = then;
  }
}
