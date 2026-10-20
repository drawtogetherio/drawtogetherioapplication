import { DrawDoc } from '../core/document';
import { ApiError, ServerConfig, api } from '../net/api';
import { RoomClient } from '../net/roomClient';
import type { MyProfile } from '../shared/profile';
import type { App } from './app';
import { modal, newCanvasDialog } from './dialogs';
import { h } from './dom';
import { icon } from './icons';
import { profileDialog } from './profileDialog';

const blankDoc = () => DrawDoc.create({ width: 2048, height: 2048, infinite: true, background: '#ffffff' });

/** Login, profile setup, and joining / leaving rooms. */
export class Session {
  server: ServerConfig | null = null;

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
    u.searchParams.delete('login');
    history.replaceState(null, '', u);
  }

  inviteLink() { return this.ed.room ? `${location.origin}${location.pathname}?room=${this.ed.room.id}` : ''; }

  async start() {
    this.server = await api.config();
    if (!this.server) { newCanvasDialog((doc) => this.ed.setDoc(doc)); return; } // offline / static build
    const failed = new URLSearchParams(location.search).get('login') === 'failed';
    this.ed.me = await api.me().catch(() => null);
    this.app.refreshAccount();
    if (!this.ed.me) return this.loginScreen(failed ? 'Discord login didn’t finish. Please try again.' : '');
    await this.afterLogin();
  }

  private async afterLogin() {
    if (this.me?.needsSetup) {
      const saved = await profileDialog(this.me, true);
      if (saved) this.ed.me = saved;
      this.app.refreshAccount();
    }
    const room = this.roomFromUrl();
    if (room) this.joinRoom(room);
    else this.homeScreen();
  }

  loginScreen(error = '') {
    const s = this.server!;
    const room = this.roomFromUrl();
    const err = h('p.error', { role: 'alert' }, error);
    const body = h('div.modal-body.login', {},
      h('p', {}, room ? 'Log in to join this shared room.' : 'Draw together on the same canvas. Log in to create or join rooms.'),
    );
    let close = () => {};
    if (s.discord) {
      body.append(h('a.btn.discord', { href: api.discordUrl(location.pathname + location.search), html: icon('chat', 18) + '<span>Continue with Discord</span>' }));
    } else {
      body.append(h('p.muted.small', {}, 'Discord login isn’t configured on this server yet.'));
    }
    if (s.devLogin) {
      const name = h('input', { type: 'text', id: 'dev-name', placeholder: 'Any name', maxlength: 32, 'aria-label': 'Test name' });
      const go = h('button.btn', { type: 'submit' }, 'Dev login');
      const form = h('form.dev-login', {}, h('span.muted.small', {}, 'Testing: log in as anyone'), h('div.row', {}, name, go));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          this.ed.me = await api.devLogin(name.value);
          this.app.refreshAccount();
          close();
          await this.afterLogin();
        } catch (ex) { err.textContent = (ex as ApiError).message; }
      });
      body.append(form);
    }
    body.append(err);
    const offline = h('button.btn', {}, 'Draw offline');
    close = modal('Welcome to Doodlehive', body, [offline], undefined, false);
    offline.addEventListener('click', () => { close(); this.setUrlRoom(null); newCanvasDialog((doc) => this.ed.setDoc(doc)); });
  }

  homeScreen() {
    const code = h('input', { type: 'text', id: 'join-code', placeholder: 'Room link or code', 'aria-label': 'Room link or code' });
    const err = h('p.error', { role: 'alert' });
    let close = () => {};
    const card = (title: string, text: string, ic: string, fn: () => void) =>
      h('button.preset-card.home-card', { onclick: fn, html: `${icon(ic, 22)}<strong>${title}</strong><small>${text}</small>` });
    const joinForm = h('form.row.join-row', {}, code, h('button.btn', { type: 'submit' }, 'Join'));
    joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const m = /(?:room=)?([a-z0-9]{4,16})\s*$/i.exec(code.value.trim());
      if (!m) { err.textContent = 'Paste a room link or its code.'; return; }
      close();
      this.joinRoom(m[1].toLowerCase());
    });
    const body = h('div.modal-body', {},
      h('div.preset-grid.home-grid', {},
        card('Start a shared room', 'Invite others with a link and draw on one canvas.', 'users', () => { close(); this.createRoomFlow(); }),
        card('Draw alone', 'A private canvas on this device.', 'brush', () => { close(); newCanvasDialog((doc) => this.ed.setDoc(doc), false); }),
      ),
      h('div.field', {}, h('span.field-label', {}, 'Join a room'), joinForm, err),
    );
    close = modal(`Hi, ${this.me?.displayName ?? 'artist'}`, body, [], undefined, false);
  }

  createRoomFlow() {
    newCanvasDialog(() => {}, true, {
      onCreate: async (c) => {
        const info = await api.createRoom(c.roomName, { width: c.width, height: c.height, infinite: c.infinite, background: c.background });
        this.joinRoom(info.id);
      },
    });
  }

  joinRoom(id: string) {
    this.leaveRoom(false);
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
        if (e.first) this.app.toast(`Joined ${room.info?.name ?? 'room'}`);
      } else if (e.kind === 'error') {
        this.app.toast(e.message);
        if (room.status === 'closed') { this.leaveRoom(); this.homeScreen(); }
      } else if (e.kind === 'status' || e.kind === 'members') {
        this.app.refreshRoom();
      }
    });
  }

  leaveRoom(toHome = true) {
    const room = this.ed.room;
    if (!room) return;
    room.close();
    this.ed.room = null;
    this.app.roomUI.detach();
    this.setUrlRoom(null);
    this.ed.setDoc(blankDoc());
    this.app.refreshRoom();
    if (toHome) this.homeScreen();
  }

  async editProfile() {
    if (!this.me) return;
    const saved = await profileDialog(this.me, false);
    if (saved) { this.ed.me = saved as MyProfile; this.app.refreshAccount(); }
  }

  async logout() {
    await api.logout().catch(() => {});
    this.leaveRoom(false);
    this.ed.me = null;
    this.app.refreshAccount();
    this.loginScreen();
  }
}
