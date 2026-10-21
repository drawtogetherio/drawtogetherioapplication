import { STATUS_MAX, cleanStatus } from '../shared/profile';
import { ApiError, Friend, FriendsList, api } from '../net/api';
import type { ProjectInfo, Visibility } from '../shared/protocol';
import type { Notice } from '../shared/notices';
import { MODE_CHOICES, presenceLabel } from './presence';
import { shareDialog } from './share';
import { preferencesDialog } from './prefsDialog';
import { brandHtml } from '../site/brand';
import type { App } from './app';
import { confirmDialog, modal, textDialog } from './dialogs';
import { clear, dismissOnOutside, h } from './dom';
import { icon } from './icons';
import { avatarEl, gradientStyle, nameLine, profileCardBody } from './people';
import { LocalCanvas, deleteCanvas, listCanvases, patchCanvas } from '../io/localStore';
import { isNativeApp } from '../io/native';
import { frameBar } from './frame';
import { SAVE_BADGE } from './app';

// Fallback to the live event stream.
const BANNER_KEY = 'doodlehive.support';
const FRIENDS_POLL_MS = 60_000;

const VIS_LABEL: Record<Visibility, string> = { private: 'Just you', open: 'Open link', friends: 'Friends', unlisted: 'Unlisted' };
const VIS_ICON: Record<Visibility, string> = { private: 'lock', open: 'link', friends: 'users', unlisted: 'eye' };

export function timeAgo(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60, hh = m / 60, d = hh / 24;
  if (m < 60) return `${Math.floor(m)} min ago`;
  if (hh < 24) return `${Math.floor(hh)} h ago`;
  if (d < 7) return `${Math.floor(d)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}

/** Cloud for server canvases; a warning on device ones in a browser. */
function saveMark(p: ProjectInfo): HTMLElement {
  const kind = p.local ? (isNativeApp ? 'device' : 'cache') : 'cloud';
  const t = SAVE_BADGE[kind];
  return h(`span.save-mark.${kind}` as 'span', { title: t.hint, 'aria-label': t.label, html: icon(t.icon, 13) + (t.short ? `<span>${t.short}</span>` : '') });
}

export class Home {
  readonly el = h('div.home', { hidden: true });
  private friendsEl = h('div.friends-list');
  private requestsEl = h('div.friend-requests');
  private grid = h('div.project-grid');
  private friendCount = h('span.count');
  private accountPop = h('div.popover.account-pop', { hidden: true });
  private timer = 0;
  private friendsPanel: HTMLElement;
  private projectsHead = h('h1', {}, 'Recent');
  private meCard = h('div.me-card');
  private friends: FriendsList = { friends: [], incoming: [], outgoing: [] };
  private bellBtn = h('button.bell-btn', { type: 'button', title: 'Notifications', 'aria-label': 'Notifications', html: icon('bell', 20) });
  private bellBadge = h('span.bell-badge', { hidden: true });
  private noticesPop = h('div.popover.notices-pop', { hidden: true });
  private notices: Notice[] = [];
  private banner = h('div.support-banner', { hidden: true });
  private thumbUrls: string[] = [];

  constructor(private app: App) {
    dismissOnOutside(this.accountPop, [this.meCard], () => { this.accountPop.hidden = true; });
    this.bellBtn.append(this.bellBadge);
    this.bellBtn.addEventListener('click', () => this.toggleNotices());
    dismissOnOutside(this.noticesPop, [this.bellBtn], () => { this.noticesPop.hidden = true; });

    const addIn = h('input', { type: 'text', placeholder: '@handle', 'aria-label': 'Friend’s handle', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const addForm = h('form.add-friend', {}, addIn, h('button.icon-btn', { type: 'submit', title: 'Send friend request', 'aria-label': 'Send friend request', html: icon('plus', 18) }));
    const addErr = h('p.field-error', { role: 'alert' });
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      addErr.textContent = '';
      if (!addIn.value.trim()) return;
      try {
        const r = await api.addFriend(addIn.value);
        this.app.toast(r.result === 'accepted' ? 'You’re now friends!' : 'Friend request sent');
        addIn.value = '';
        this.setFriends(r);
      } catch (ex) { addErr.textContent = (ex as ApiError).message; }
    });

    // Popovers anchor to the header, so the banner above can come and go.
    this.el.append(this.banner, h('div.home-main', {},
      frameBar(h('header.home-top', {}, h('div.home-brand', { html: brandHtml('/') }), h('span.grow'))),
      h('div.home-body', {},
        this.friendsPanel = h('aside.friends-panel', { 'aria-label': 'Friends' },
          this.meCard,
          h('div.panel-head', {}, h('span.panel-title', {}, 'Friends ', this.friendCount)),
          addForm, addErr,
          this.requestsEl,
          this.friendsEl,
        ),
        h('main.projects', {},
          h('div.projects-head', {}, this.projectsHead),
          this.grid,
        ),
      ),
      this.accountPop,
      this.noticesPop,
    ));
  }

  get visible() { return !this.el.hidden; }

  show() {
    this.el.hidden = false;
    this.renderAccount();
    const guest = !!this.app.ed.me?.guest;
    this.el.classList.toggle('guest', guest);
    this.friendsPanel.hidden = guest;
    this.renderBanner();
    if (guest) { this.renderGuest(); return; }
    this.projectsHead.textContent = 'Recent';
    this.loadProjects();
    this.loadFriends();
    this.loadNotices();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => { if (!document.hidden) this.loadFriends(); }, FRIENDS_POLL_MS);
  }

  hide() {
    this.el.hidden = true;
    this.accountPop.hidden = this.noticesPop.hidden = true;
    clearInterval(this.timer);
  }

  /** Once per browser session, until it is closed for good. */
  private renderBanner() {
    const url = this.app.session.server?.patreon;
    const b = this.banner;
    let seen = false;
    try { seen = sessionStorage.getItem(BANNER_KEY) === '1'; } catch { /* storage blocked */ }
    b.hidden = !url || !this.app.ed.prefs.supportBanner || seen;
    if (b.hidden || b.childElementCount) return;
    try { sessionStorage.setItem(BANNER_KEY, '1'); } catch { /* storage blocked */ }
    b.append(
      h('a.support-link', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Support Doodlehive on Patreon and unlock special features'),
      h('button.icon-btn', { type: 'button', title: 'Close', 'aria-label': 'Close', html: icon('x', 16), onclick: () => {
        b.hidden = true;
        this.app.ed.prefs.supportBanner = false;
        this.app.savePrefs();
      } }),
    );
  }

  // ---- Account ----

  renderAccount() { this.renderMeCard(); }

  /** Pops `pop` under `anchor`, inside the home screen. */
  private popUnder(pop: HTMLElement, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect(), base = this.el.querySelector('.home-main')!.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6 - base.top)}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) - base.left)}px`;
    pop.style.right = 'auto';
  }

  private renderMeCard(editing = false) {
    const me = this.app.ed.me;
    clear(this.meCard);
    if (!me) return;
    this.meCard.className = 'me-card' + (me.gradient ? ' has-gradient' : '');
    this.meCard.setAttribute('style', me.gradient ? gradientStyle(me.gradient) : `--g1:${me.favoriteColor};--g2:${me.favoriteColor}`);
    let status: HTMLElement;
    if (editing) {
      const inp = h('input', { type: 'text', id: 'status', value: me.status, maxlength: STATUS_MAX * 2, placeholder: 'What are you up to?', 'aria-label': 'Status' });
      let done = false;
      const save = async () => {
        if (done) return;
        done = true;
        const text = cleanStatus(inp.value);
        if (text === null) { done = false; this.app.toast(`Keep it to ${STATUS_MAX} characters`); return; }
        try { this.app.ed.me = await api.updateMe({ status: text }); } catch (e) { this.app.toast((e as Error).message); }
        this.renderMeCard();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { done = true; this.renderMeCard(); }
      });
      inp.addEventListener('blur', () => save());
      status = inp;
      queueMicrotask(() => inp.focus());
    } else if (me.status) {
      status = h('button.me-status', { type: 'button', title: 'Change status', onclick: () => this.renderMeCard(true) }, me.status);
    } else {
      status = h('button.me-status-add', { type: 'button', 'aria-label': 'Set a status', html: icon('plus', 14) + '<span>Status</span>', onclick: () => this.renderMeCard(true) });
    }
    const mode = MODE_CHOICES.find((c) => c.mode === me.presenceMode) ?? MODE_CHOICES[0];
    const presenceBtn = h(`button.me-presence.${mode.shows}` as 'button', { type: 'button', 'aria-label': `Status: ${mode.label}`, html: `<i></i><span>${mode.label}</span>` });
    presenceBtn.addEventListener('click', () => this.presenceMenu(presenceBtn));
    const pic = h('button.me-pic', { type: 'button', title: 'Account', 'aria-label': 'Your account', onclick: () => {
      this.noticesPop.hidden = true;
      this.accountPop.hidden = !this.accountPop.hidden;
      if (!this.accountPop.hidden) { this.renderAccountMenu(); this.popUnder(this.accountPop, pic); }
    } }, avatarEl(me, 44, true), h(`span.presence.${mode.shows}` as 'span'));
    this.meCard.append(
      pic,
      h('div.me-text', {}, h('strong.me-name', {}, me.displayName), h('span.me-sub', {}, h('small.me-handle', {}, '@' + me.handle), presenceBtn), status),
      this.bellBtn,
    );
  }

  private presenceMenu(anchor: HTMLElement) {
    const pop = h('div.popover.tile-pop.presence-pop');
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', off, true); };
    const off = (e: PointerEvent) => { if (!pop.contains(e.target as Node)) close(); };
    pop.append(h('div.panel', {}, ...MODE_CHOICES.map((c) => h(`button.menu-item.${c.shows}` as 'button', {
      type: 'button', html: `<i class="presence-dot"></i><span>${c.label}</span>`,
      onclick: async () => {
        close();
        try { this.app.ed.me = await api.updateMe({ presenceMode: c.mode }); this.renderMeCard(); } catch (e) { this.app.toast((e as Error).message); }
      },
    }))));
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.style.left = `${Math.round(r.left)}px`;
    this.el.append(pop);
    setTimeout(() => document.addEventListener('pointerdown', off, true));
  }

  private renderAccountMenu() {
    const me = this.app.ed.me, s = this.app.session;
    if (!me) return;
    const close = () => { this.accountPop.hidden = true; };
    clear(this.accountPop);
    this.accountPop.append(h('div.panel', {},
      h('div.account', {}, avatarEl(me, 40, true), h('div.account-text', {}, nameLine(me), h('small.muted', {}, '@' + me.handle), me.status ? h('small.status-line', {}, me.status) : null)),
      h('button.menu-item', { html: icon('user', 18) + '<span>Edit profile</span>', onclick: () => { close(); s.editProfile(); } }),
      h('button.menu-item', { html: icon('settings', 18) + '<span>Preferences</span>', onclick: () => { close(); preferencesDialog(this.app); } }),
      me.admin ? h('a.menu-item', { href: '/admin', html: icon('shield', 18) + '<span>Admin</span>' }) : null,
      h('button.menu-item', { html: icon('logout', 18) + '<span>Log out</span>', onclick: () => { close(); s.logout(); } }),
    ));
  }

  // ---- Notifications ----

  async loadNotices() {
    if (this.app.ed.me?.guest) return;
    let r: { unread: number; notices: Notice[] };
    try { r = await api.notices(); } catch { return; }
    this.notices = r.notices;
    this.bellBadge.hidden = !r.unread;
    this.bellBadge.textContent = r.unread > 99 ? '99+' : String(r.unread);
    if (!this.noticesPop.hidden) this.renderNotices();
  }

  private toggleNotices() {
    this.accountPop.hidden = true;
    this.noticesPop.hidden = !this.noticesPop.hidden;
    if (this.noticesPop.hidden) return;
    this.renderNotices();
    this.popUnder(this.noticesPop, this.bellBtn);
    if (this.notices.some((n) => !n.read)) {
      this.bellBadge.hidden = true;
      api.readNotices().catch(() => {});
    }
  }

  private renderNotices() {
    const s = this.app.session, pop = this.noticesPop;
    const refresh = () => { this.loadFriends(); this.loadNotices(); };
    const rows = this.notices.map((n) => {
      const d = n.data as { user?: string; name?: string; room?: { id: string; name: string } };
      const actions: HTMLElement[] = [];
      if (n.kind === 'friend' && d.user && this.friends.incoming.some((p) => p.id === d.user)) {
        actions.push(
          h('button.icon-btn.accept', { title: 'Accept', 'aria-label': `Accept ${d.name}`, html: icon('check', 18), onclick: async () => { await api.acceptFriend(d.user!).catch(() => {}); refresh(); } }),
          h('button.icon-btn', { title: 'Decline', 'aria-label': `Decline ${d.name}`, html: icon('x', 18), onclick: async () => { await api.removeFriend(d.user!).catch(() => {}); refresh(); } }),
        );
      } else if (n.kind === 'invite' && d.room) {
        actions.push(h('button.btn.small.primary', { type: 'button', onclick: () => { pop.hidden = true; s.joinRoom(d.room!.id); } }, 'Join'));
      }
      const ic = n.kind === 'friend' ? 'userPlus' : n.kind === 'friend-accepted' ? 'users' : n.kind === 'invite' ? 'link' : 'sparkle';
      return h(`div.notice-row${n.read ? '' : '.unread'}` as 'div', {}, h('span.notice-icon', { html: icon(ic, 18) }),
        h('span.notice-text', {}, n.text, h('small', {}, ago(n.at))), ...actions);
    });
    clear(pop);
    pop.append(h('div.panel', {},
      h('div.panel-head', {}, h('span.panel-title', {}, 'Notifications'),
        this.notices.length ? h('button.btn.small', { type: 'button', onclick: async () => { await api.clearNotices().catch(() => {}); this.loadNotices(); } }, 'Clear') : null),
      ...(rows.length ? rows : [h('p.notices-empty', {}, 'Nothing new')]),
    ));
  }

  // ---- Friends ----

  async loadFriends() {
    try { this.setFriends(await api.friends()); } catch { /* offline for a moment; try again next poll */ }
  }

  private setFriends(f: FriendsList) {
    this.friends = f;
    this.renderFriends();
  }

  private renderFriends() {
    const f = this.friends;
    const online = f.friends.filter((x) => x.online).length;
    this.friendCount.textContent = f.friends.length ? `${online} online` : '';
    clear(this.requestsEl);
    if (f.incoming.length) {
      this.requestsEl.append(h('div.section-label', {}, 'Requests'));
      for (const p of f.incoming) {
        this.requestsEl.append(h('div.friend-row.request', {},
          avatarEl(p, 34, true),
          h('div.friend-text', {}, nameLine(p), h('small', {}, '@' + p.handle)),
          h('button.icon-btn.accept', { title: 'Accept', 'aria-label': `Accept ${p.displayName}`, html: icon('check', 18), onclick: async () => this.setFriends(await api.acceptFriend(p.id)) }),
          h('button.icon-btn', { title: 'Decline', 'aria-label': `Decline ${p.displayName}`, html: icon('x', 18), onclick: async () => this.setFriends(await api.removeFriend(p.id)) }),
        ));
      }
    }
    if (f.outgoing.length) {
      this.requestsEl.append(h('div.section-label', {}, 'Sent'));
      for (const p of f.outgoing) {
        this.requestsEl.append(h('div.friend-row.request.sent', {},
          avatarEl(p, 28),
          h('div.friend-text', {}, h('span.person-name', {}, p.displayName), h('small', {}, 'Waiting for them to accept')),
          h('button.icon-btn', { title: 'Cancel request', 'aria-label': `Cancel request to ${p.displayName}`, html: icon('x', 16), onclick: async () => this.setFriends(await api.removeFriend(p.id)) }),
        ));
      }
    }
    clear(this.friendsEl);
    if (!f.friends.length) {
      const me = this.app.ed.me;
      this.friendsEl.append(h('p.friends-empty', {}, 'No friends here yet. Add someone by their handle', me ? h('span', {}, `, and share yours: @${me.handle}`) : null, '.'));
      return;
    }
    let shownOffline = false;
    for (const p of f.friends) {
      if (!p.online && !shownOffline) {
        shownOffline = true;
        if (online) this.friendsEl.append(h('div.section-label', {}, 'Offline'));
      }
      this.friendsEl.append(this.friendRow(p));
    }
  }

  private friendRow(p: Friend): HTMLElement {
    const pic = h('span.friend-pic', {}, avatarEl(p, 38, true), h(`span.presence.${p.presence}` as 'span', { title: presenceLabel(p.presence) }));
    const row = h(`div.friend-row.${p.presence}${p.online ? '.online' : ''}${p.premium ? '.premium' : ''}${p.gradient ? '.has-gradient' : ''}` as 'div', {
      role: 'button', tabindex: 0, style: gradientStyle(p.gradient), onclick: () => this.friendCard(p),
    },
      pic,
      h('span.friend-text', {}, nameLine(p),
        p.room ? h('small.friend-room', {}, 'In ', h('strong', {}, p.room.name))
          : p.status ? h('small.status-line', { title: p.status }, p.status)
            : h('small', {}, p.online ? presenceLabel(p.presence) : '@' + p.handle)),
    );
    if (p.room) {
      const room = p.room;
      row.append(h('button.btn.small.join-btn', { type: 'button', title: `Join ${room.name}`, onclick: (e: Event) => { e.stopPropagation(); this.app.session.joinRoom(room.id); } }, 'Join'));
    }
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) this.friendCard(p); });
    return row;
  }

  private friendCard(p: Friend) {
    let close = () => {};
    const remove = h('button.btn.danger', {
      html: icon('x', 16) + '<span>Remove friend</span>',
      onclick: async () => {
        close();
        if (await confirmDialog('Remove friend?', `${p.displayName} will be removed from your friends list.`, 'Remove')) this.setFriends(await api.removeFriend(p.id));
      },
    });
    const join = p.room ? h('button.btn.primary', { onclick: () => { close(); this.app.session.joinRoom(p.room!.id); } }, `Join ${p.room.name}`) : null;
    close = modal('Friend', profileCardBody(p, undefined, h('p.muted.small', {}, presenceLabel(p.presence))), join ? [remove, join] : [remove]);
  }

  private renderGuest() {
    const me = this.app.ed.me!;
    clearInterval(this.timer);
    this.projectsHead.textContent = 'You’re a guest';
    clear(this.grid);
    this.grid.append(h('div.guest-card', {},
      h('p', {}, 'You’re drawing as ', h('strong', {}, me.displayName), ' (@' + me.handle + ').'),
      h('p.muted', {}, 'Log in with Discord to make canvases, add friends and pick a handle.'),
      h('div.row', {},
        h('button.btn', { type: 'button', onclick: () => this.app.session.createNew() }, 'Join a canvas'),
        h('button.btn.primary', { type: 'button', onclick: () => this.app.session.logout('/login?next=/app') }, 'Log in with Discord')),
    ));
  }

  // ---- Projects ----

  /** Server canvases and the ones kept in this browser, newest first. */
  async loadProjects() {
    const me = this.app.ed.me!;
    let list: ProjectInfo[] = [];
    try { list = await api.projects(); } catch (e) { this.app.toast((e as Error).message); }
    let local: LocalCanvas[] = [];
    try { local = await listCanvases(me.id); } catch { /* storage blocked */ }
    for (const u of this.thumbUrls) URL.revokeObjectURL(u);
    this.thumbUrls = [];
    for (const c of local) {
      const thumb = c.thumb ? URL.createObjectURL(c.thumb) : null;
      if (thumb) this.thumbUrls.push(thumb);
      list.push({ id: c.id, name: c.name, private: !c.room, visibility: c.room ? c.share.visibility : 'private', createdAt: c.createdAt, updatedAt: c.updatedAt, thumb, online: 0, local: true });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    clear(this.grid);
    const create = h('button.project-tile.create-tile', { type: 'button', onclick: () => this.app.session.createNew() },
      h('span.create-square', { html: icon('plus', 34) }), h('span.tile-name', {}, 'Create new'));
    this.grid.append(create);
    for (const p of list) this.grid.append(this.projectTile(p));
    if (!list.length) this.grid.append(h('p.projects-empty', {}, 'No canvases yet.'));
  }

  private projectTile(p: ProjectInfo): HTMLElement {
    const thumb = h('span.tile-thumb', {});
    if (p.thumb) thumb.append(h('img', { src: p.thumb, alt: '', loading: 'lazy' }));
    else thumb.append(h('span.tile-blank', { html: icon('brush', 28) }));
    if (p.online) thumb.append(h('span.live-pill', {}, `${p.online} drawing`));
    const more = h('button.icon-btn.tile-more', { type: 'button', title: 'More', 'aria-label': `More options for ${p.name}`, html: icon('more', 18) });
    const s = this.app.session, premium = !!this.app.ed.me?.premium;
    // Free accounts keep canvases on this device; premium ones on the server. A tile on the other side moves when opened.
    const open = () => p.local ? (premium ? s.moveLocalToServer(p.id) : s.openLocal(p.id)) : s.joinRoom(p.id, null, { takeLocal: !premium });
    const where = p.local ? (p.private ? 'On this device' : VIS_LABEL[p.visibility]) : premium ? VIS_LABEL[p.visibility] : 'On the server';
    const tile = h('div.project-tile', {},
      h('button.tile-open', { type: 'button', 'aria-label': `Open ${p.name}`, title: !!p.local !== premium ? '' : premium ? 'Moves to your account when opened' : 'Moves to this device when opened', onclick: open },
        thumb,
        h('span.tile-name', {}, p.name),
        h('span.tile-meta', {}, h('span', { html: icon(p.local && p.private ? 'file' : VIS_ICON[p.visibility], 13) }), `${where} · ${timeAgo(p.updatedAt)}`, saveMark(p)),
      ),
      more,
    );
    more.addEventListener('click', (e) => { e.stopPropagation(); this.tileMenu(p, more); });
    return tile;
  }

  private tileMenu(p: ProjectInfo, anchor: HTMLElement) {
    const pop = h('div.popover.tile-pop');
    const close = () => pop.remove();
    const item = (ic: string, text: string, fn: () => void, cls = '') =>
      h(`button.menu-item${cls}` as 'button', { html: icon(ic, 17) + `<span>${text}</span>`, onclick: () => { close(); fn(); } });
    if (p.local) pop.append(h('div.panel', {},
      item('rename', 'Rename', async () => {
        const name = await textDialog('Rename canvas', p.name);
        if (name == null) return;
        await patchCanvas(p.id, { name }).catch(() => {});
        this.loadProjects();
      }),
      item('trash', 'Delete', async () => {
        if (!(await confirmDialog('Delete this canvas?', `“${p.name}” will be removed from this device.`, 'Delete'))) return;
        await deleteCanvas(p.id).catch(() => {});
        this.loadProjects();
      }, '.danger'),
    ));
    else pop.append(h('div.panel', {},
      item('rename', 'Rename', async () => {
        const name = await textDialog('Rename canvas', p.name);
        if (name == null) return;
        try { await api.updateRoom(p.id, { name }); this.loadProjects(); } catch (e) { this.app.toast((e as Error).message); }
      }),
      item('users', p.private ? 'Share…' : 'Sharing…', async () => {
        try {
          const info = await api.room(p.id);
          const share = await shareDialog(info.share, !p.private);
          if (!share) return;
          await api.updateRoom(p.id, { share });
          this.loadProjects();
          if (p.private) await this.app.copyText(this.app.session.inviteLinkFor(p.id), 'Invite link copied');
        } catch (e) { this.app.toast((e as Error).message); }
      }),
      !p.private ? item('link', 'Copy invite link', () => this.app.copyText(this.app.session.inviteLinkFor(p.id), 'Invite link copied')) : null,
      !p.private ? item('lock', 'Make private', async () => {
        try { const info = await api.room(p.id); await api.updateRoom(p.id, { share: { ...info.share, visibility: 'private' } }); this.loadProjects(); }
        catch (e) { this.app.toast((e as Error).message); }
      }) : null,
      item('trash', 'Delete', async () => {
        if (!(await confirmDialog('Delete this canvas?', `“${p.name}” will be deleted for everyone.`, 'Delete'))) return;
        try { await api.deleteRoom(p.id); this.loadProjects(); } catch (e) { this.app.toast((e as Error).message); }
      }, '.danger'),
    ));
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.style.left = `${Math.round(Math.min(window.innerWidth - 220, r.left))}px`;
    this.el.append(pop);
    setTimeout(() => {
      const off = (e: PointerEvent) => { if (!pop.contains(e.target as Node)) { close(); document.removeEventListener('pointerdown', off, true); } };
      document.addEventListener('pointerdown', off, true);
    });
  }
}


function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.round(hrs / 24);
  return d === 1 ? 'Yesterday' : `${d}d ago`;
}
