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

const blankDoc = () => DrawDoc.create({ width: 2048, height: 2048, infinite: true, background: '#ffffff' });
const PRESENCE_MS = 30_000;
const THUMB_DELAY_MS = 15_000;

/** Login state, the home screen, and opening / leaving canvases (every saved canvas is a room). */
export class Session {
  server: ServerConfig | null = null;
  /** True when drawing without an account (no server, or chosen on the login page). */
  offline = false;
  private thumbTimer = 0;
  private thumbDirty = false;

  constructor(private app: App) {}

  get ed() { return this.app.ed; }
  get me() { return this.ed.me; }

  roomFromUrl(): string | null {
    const id = new URLSearchParams(location.search).get('room');
    return id && /^[a-z0-9]{4,16}$/.test(id) ? id : null;
  }

  private setUrlRoom(id: string | null) {
    const u = new URL(location.href);
    if (id) u.searchParams.set('room', id); else u.searchParams.delete('room');
    history.replaceState(null, '', u);
  }

  inviteLinkFor(id: string) { return `${location.origin}/app?room=${id}`; }
  inviteLink() { return this.ed.room ? this.inviteLinkFor(this.ed.room.id) : ''; }

  async start() {
    this.server = await api.config();
    if (!this.server || new URLSearchParams(location.search).has('offline')) {
      // No server (static build / preview) or "Draw without an account": a local canvas only.
      this.offline = true;
      this.app.refreshAccount();
      newCanvasDialog((doc) => this.ed.setDoc(doc), false);
      return;
    }
    this.ed.me = await api.me().catch(() => null);
    if (!this.ed.me) {
      location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
      return;
    }
    this.app.refreshAccount();
    setInterval(() => { if (!document.hidden) api.ping().catch(() => {}); }, PRESENCE_MS);
    if (this.me?.needsSetup) {
      const saved = await profileDialog(this.me, true);
      if (saved) this.ed.me = saved;
      this.app.refreshAccount();
    }
    const room = this.roomFromUrl();
    if (room) this.joinRoom(room);
    else this.showHome();
  }

  showHome() {
    if (this.offline) return;
    this.app.home.show();
  }

  /** "Create new": draw alone (a private canvas) or a shared room. */
  createNew() {
    let close = () => {};
    const card = (title: string, text: string, ic: string, solo: boolean) =>
      h('button.preset-card.home-card', {
        html: `${icon(ic, 26)}<strong>${title}</strong><small>${text}</small>`,
        onclick: () => { close(); this.createFlow(solo); },
      });
    const body = h('div.modal-body', {},
      h('div.preset-grid.home-grid', {},
        card('Draw alone', 'A private canvas, saved to your account. You can share it later.', 'brush', true),
        card('Shared room', 'Invite friends with a link and draw on the same canvas.', 'users', false),
      ),
    );
    close = modal('Create new', body, []);
  }

  createFlow(solo: boolean) {
    newCanvasDialog(() => {}, true, {
      solo,
      onCreate: async (c) => {
        const info = await api.createRoom(c.roomName, { width: c.width, height: c.height, infinite: c.infinite, background: c.background }, solo);
        this.joinRoom(info.id);
      },
    });
  }

  joinRoom(id: string) {
    this.leaveRoom(false);
    this.app.home.hide();
    this.setUrlRoom(id);
    const room = new RoomClient(id);
    this.ed.room = room;
    this.app.roomUI.attach(room);
    this.app.refreshRoom();
    room.on((e) => {
      if (e.kind === 'ready') {
        this.ed.setDoc(e.doc, !e.first);
        this.ed.ensureOwnLayer();
        this.app.refreshRoom();
        if (e.first && !room.info?.private) this.app.toast(`Joined ${room.info?.name ?? 'room'}`);
      } else if (e.kind === 'op') {
        this.scheduleThumb();
      } else if (e.kind === 'error') {
        this.app.toast(e.message);
        if (room.status === 'closed') this.leaveRoom();
      } else if (e.kind === 'status' || e.kind === 'members' || e.kind === 'room') {
        // Closed for good (private, deleted, gone): back to the home screen.
        if (room.status === 'closed' && this.ed.room === room) { this.leaveRoom(); return; }
        this.app.refreshRoom();
      }
    });
  }

  /** Canvas owners keep a small preview of their canvas for the home screen. */
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

  async logout() {
    await api.logout().catch(() => {});
    location.href = '/';
  }
}
