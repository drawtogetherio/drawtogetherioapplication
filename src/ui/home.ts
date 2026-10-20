import { ApiError, Friend, FriendsList, api } from '../net/api';
import type { ProjectInfo } from '../shared/protocol';
import { brandHtml } from '../site/brand';
import type { App } from './app';
import { confirmDialog, modal, textDialog } from './dialogs';
import { clear, dismissOnOutside, h } from './dom';
import { icon } from './icons';
import { avatarEl, gradientStyle, nameLine, profileCardBody } from './people';

const FRIENDS_POLL_MS = 20_000;

export function timeAgo(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60, hh = m / 60, d = hh / 24;
  if (m < 60) return `${Math.floor(m)} min ago`;
  if (hh < 24) return `${Math.floor(hh)} h ago`;
  if (d < 7) return `${Math.floor(d)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}

/**
 * The /app home screen: friends on the left (online first), recent canvases in the middle with a
 * "Create new" tile, and a + button in the top-left corner.
 */
export class Home {
  readonly el = h('div.home', { hidden: true });
  private friendsEl = h('div.friends-list');
  private requestsEl = h('div.friend-requests');
  private grid = h('div.project-grid');
  private friendCount = h('span.count');
  private accountBtn = h('button.account-btn', { type: 'button', 'aria-label': 'Your account' });
  private accountPop = h('div.popover.account-pop', { hidden: true });
  private timer = 0;
  private plus: HTMLButtonElement;
  private friendsPanel: HTMLElement;
  private projectsHead = h('h1', {}, 'Recent');
  private friends: FriendsList = { friends: [], incoming: [], outgoing: [] };

  constructor(private app: App) {
    const plus = this.plus = h('button.icon-btn.plus-btn', { title: 'Create new', 'aria-label': 'Create new', html: icon('plus', 22), onclick: () => this.app.session.createNew() });
    const joinIn = h('input', { type: 'text', placeholder: 'Paste a room link or code', 'aria-label': 'Room link or code', autocomplete: 'off' });
    const joinForm = h('form.home-join', {}, joinIn, h('button.btn', { type: 'submit' }, 'Join'));
    joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const m = /(?:room=)?([a-z0-9]{4,16})\s*$/i.exec(joinIn.value.trim());
      if (!m) { this.app.toast('Paste a room link or its code'); return; }
      joinIn.value = '';
      this.app.session.joinRoom(m[1].toLowerCase());
    });
    this.accountBtn.addEventListener('click', () => { this.renderAccountMenu(); this.accountPop.hidden = !this.accountPop.hidden; });
    dismissOnOutside(this.accountPop, [this.accountBtn], () => { this.accountPop.hidden = true; });

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

    this.el.append(
      h('header.home-top', {},
        plus,
        h('div.home-brand', { html: brandHtml('/') }),
        h('div.home-top-right', {}, joinForm, this.accountBtn),
      ),
      h('div.home-body', {},
        this.friendsPanel = h('aside.friends-panel', { 'aria-label': 'Friends' },
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
    );
  }

  get visible() { return !this.el.hidden; }

  show() {
    this.el.hidden = false;
    this.renderAccount();
    // Guests only draw in rooms they're invited to: no friends, no canvases of their own.
    const guest = !!this.app.ed.me?.guest;
    this.el.classList.toggle('guest', guest);
    this.plus.hidden = this.friendsPanel.hidden = guest;
    if (guest) { this.renderGuest(); return; }
    this.projectsHead.textContent = 'Recent';
    this.loadProjects();
    this.loadFriends();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => { if (!document.hidden) this.loadFriends(); }, FRIENDS_POLL_MS);
  }

  hide() {
    this.el.hidden = true;
    this.accountPop.hidden = true;
    clearInterval(this.timer);
  }

  // ---- Account ----

  renderAccount() {
    const me = this.app.ed.me;
    clear(this.accountBtn);
    if (me) this.accountBtn.append(avatarEl(me, 34, true));
  }

  private renderAccountMenu() {
    const me = this.app.ed.me, s = this.app.session;
    if (!me) return;
    const close = () => { this.accountPop.hidden = true; };
    clear(this.accountPop);
    this.accountPop.append(h('div.panel', {},
      h('div.account', {}, avatarEl(me, 40, true), h('div.account-text', {}, nameLine(me), h('small.muted', {}, '@' + me.handle), me.status ? h('small.status-line', {}, me.status) : null)),
      h('button.menu-item', { html: icon('user', 18) + '<span>Edit profile & status</span>', onclick: () => { close(); s.editProfile(); } }),
      h('button.menu-item', { html: icon('logout', 18) + '<span>Log out</span>', onclick: () => { close(); s.logout(); } }),
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
    const pic = h('span.friend-pic', {}, avatarEl(p, 38, true), h(`span.presence${p.online ? '.on' : ''}` as 'span', { title: p.online ? 'Online' : 'Offline' }));
    const row = h(`button.friend-row${p.online ? '.online' : ''}${p.premium ? '.premium' : ''}${p.gradient ? '.has-gradient' : ''}` as 'button', {
      type: 'button', style: gradientStyle(p.gradient), onclick: () => this.friendCard(p),
    },
      pic,
      h('span.friend-text', {}, nameLine(p), p.status ? h('small.status-line', { title: p.status }, p.status) : h('small', {}, p.online ? 'Online' : '@' + p.handle)),
    );
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
    close = modal('Friend', profileCardBody(p, undefined, h('p.muted.small', {}, p.online ? 'Online now' : 'Offline')), [remove]);
  }

  private renderGuest() {
    const me = this.app.ed.me!;
    clearInterval(this.timer);
    this.projectsHead.textContent = 'You’re a guest';
    clear(this.grid);
    this.grid.append(h('div.guest-card', {},
      h('p', {}, 'You’re drawing as ', h('strong', {}, me.displayName), ' (@' + me.handle + '). Paste a room link above to join a friend’s canvas.'),
      h('p.muted', {}, 'Log in with Discord to make your own canvases, add friends and choose your own handle.'),
      h('button.btn.primary', { type: 'button', onclick: () => this.app.session.logout('/login?next=/app') }, 'Log in with Discord'),
    ));
  }

  // ---- Projects ----

  async loadProjects() {
    let list: ProjectInfo[] = [];
    try { list = await api.projects(); } catch (e) { this.app.toast((e as Error).message); }
    clear(this.grid);
    const create = h('button.project-tile.create-tile', { type: 'button', onclick: () => this.app.session.createNew() },
      h('span.create-square', { html: icon('plus', 34) }), h('span.tile-name', {}, 'Create new'));
    this.grid.append(create);
    for (const p of list) this.grid.append(this.projectTile(p));
    if (!list.length) this.grid.append(h('p.projects-empty', {}, 'Your canvases show up here. Start one alone, or make a room and invite friends.'));
  }

  private projectTile(p: ProjectInfo): HTMLElement {
    const thumb = h('span.tile-thumb', {});
    if (p.thumb) thumb.append(h('img', { src: p.thumb, alt: '', loading: 'lazy' }));
    else thumb.append(h('span.tile-blank', { html: icon('brush', 28) }));
    if (p.online) thumb.append(h('span.live-pill', {}, `${p.online} drawing`));
    const more = h('button.icon-btn.tile-more', { type: 'button', title: 'More', 'aria-label': `More options for ${p.name}`, html: icon('more', 18) });
    const tile = h('div.project-tile', {},
      h('button.tile-open', { type: 'button', 'aria-label': `Open ${p.name}`, onclick: () => this.app.session.joinRoom(p.id) },
        thumb,
        h('span.tile-name', {}, p.name),
        h('span.tile-meta', {}, h('span', { html: icon(p.private ? 'lock' : 'users', 13) }), `${p.private ? 'Just you' : 'Shared'} · ${timeAgo(p.updatedAt)}`),
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
    pop.append(h('div.panel', {},
      item('rename', 'Rename', async () => {
        const name = await textDialog('Rename canvas', p.name);
        if (name == null) return;
        try { await api.updateRoom(p.id, { name }); this.loadProjects(); } catch (e) { this.app.toast((e as Error).message); }
      }),
      p.private
        ? item('users', 'Make shared', async () => { await api.updateRoom(p.id, { private: false }); this.loadProjects(); this.app.toast('Anyone with the link can join now'); })
        : item('link', 'Copy invite link', () => this.app.copyText(this.app.session.inviteLinkFor(p.id), 'Invite link copied')),
      !p.private ? item('lock', 'Make private', async () => { await api.updateRoom(p.id, { private: true }); this.loadProjects(); }) : null,
      item('trash', 'Delete', async () => {
        if (!(await confirmDialog('Delete this canvas?', `“${p.name}” will be deleted for everyone. This can’t be undone.`, 'Delete'))) return;
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

