import { STATUS_MAX, cleanStatus } from '../shared/profile';
import { ApiError, Friend, FriendsList, api } from '../net/api';
import type { ProjectInfo, Visibility, VisitInfo } from '../shared/protocol';
import type { PublicProfile } from '../shared/profile';
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
import { socialLogo } from './socials';
import { LocalCanvas, deleteCanvas, getCanvas, listCanvases, patchCanvas } from '../io/localStore';
import { isNativeApp, native } from '../io/native';
import { PeopleTab, peopleDialog } from './blocks';
import { deleteLapse, roomLapseKey } from '../io/lapse';
import { frameBar } from './frame';
import { SAVE_BADGE } from './app';
import { LAST_KEY, LastOpen } from './session';

const BANNER_KEY = 'doodlehive.support';
const RESUME_MS = 7 * 24 * 3600_000;
const FRIENDS_POLL_MS = 60_000;

const VIS_LABEL: Record<Visibility, string> = { private: 'Just you', open: 'Open link', friends: 'Friends', unlisted: 'Unlisted' };
const VIS_ICON: Record<Visibility, string> = { private: 'lock', open: 'link', friends: 'users', unlisted: 'eye' };

function timeAgo(t: number) {
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

const RECENT_MAX = 10;

export class Home {
  readonly el = h('div.home', { hidden: true });
  private friendsEl = h('div.friends-list');
  private requestsEl = h('div.friend-requests');
  private recent = h('div.project-row');
  private mine = h('div.project-row');
  private mineSec = h('section.home-sec', { hidden: true }, this.secHead('h2', 'My canvases'), this.mine);
  private shared = h('div.project-row');
  private projects: ProjectInfo[] = [];
  private visits: VisitInfo[] = [];
  private sharedSec = h('section.home-sec', { hidden: true }, this.secHead('h2', 'Shared with you'), this.shared);
  private start = h('div.start-card');
  private ad = h('aside.ad-slot', { hidden: true, 'aria-label': 'Ad' });
  private promo = h('div.home-cards');
  private friendCount = h('span.count');
  private outgoingCount = h('span.count-pill', { hidden: true });
  private accountPop = h('div.popover.account-pop', { hidden: true });
  private timer = 0;
  private friendsPanel: HTMLElement;
  private projectsHead = h('h1', {}, h('button.sec-title', { type: 'button' }, 'Recent'));
  private recentSec = h('section.home-sec', {}, this.secHead(this.projectsHead), this.recent);
  private resume = h('div.resume', { hidden: true });
  private meCard = h('div.me-card');
  private friends: FriendsList = { friends: [], incoming: [], outgoing: [] };
  private friendsJson = '';
  private bellBtn = h('button.bell-btn', { type: 'button', title: 'Notifications', 'aria-label': 'Notifications', html: icon('bell', 18) });
  private bellBadge = h('span.bell-badge', { hidden: true });
  private noticesPop = h('div.popover.notices-pop', { hidden: true });
  private notices: Notice[] = [];
  private banner = h('div.support-banner', { hidden: true });
  private notice = h('div.site-notice', { hidden: true, role: 'status' });
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
        this.app.toast(r.result === 'accepted' ? 'You’re friends now' : 'Friend request sent');
        addIn.value = '';
        this.setFriends(r);
      } catch (ex) { addErr.textContent = (ex as ApiError).message; }
    });

    // Popovers anchor to the header, so the banner above can come and go. In the frameless app the
    // header is the window's top strip, so the banner goes under it, clear of the resize border. A
    // home-screen app on iPad draws under the status bar, so it goes under there too or iOS blurs it.
    const under = !!native?.frameless || matchMedia('(display-mode: standalone)').matches;
    if (!under) this.el.append(this.notice, this.banner);
    const s = () => this.app.session;
    const startBtn = (ic: string, text: string, fn: () => void) => h('button.start-btn', { type: 'button', html: icon(ic, 22) + `<span>${text}</span>`, onclick: fn });
    this.start.append(
      startBtn('brush', 'Draw alone', () => s().createFlow(true)),
      startBtn('users', 'Open shared room', () => s().createFlow(false)),
      startBtn('link', 'Join room', () => s().joinDialog()),
      startBtn('file', 'Open file', () => s().pickFile()),
    );
    const plus = h('button.icon-btn.create-tile', { type: 'button', title: 'New canvas', 'aria-label': 'New canvas', html: icon('plus', 22), onclick: () => s().createNew() });
    this.el.append(h('div.home-main', {},
      frameBar(h('header.home-top', {}, h('div.home-brand', { html: brandHtml('/') }), h('span.grow'), plus)),
      under ? this.notice : null, under ? this.banner : null,
      h('div.home-body', {},
        this.friendsPanel = h('aside.friends-panel', { 'aria-label': 'Friends' },
          this.meCard,
          h('div.panel-head', {}, h('span.panel-title', {}, 'Friends ', this.friendCount)),
          h('div.friends-scroll', {}, addForm, addErr, this.requestsEl, this.friendsEl),
          h('button.friends-foot', { type: 'button', html: icon('userPlus', 18) + '<span>Requests you sent</span>', onclick: () => this.peopleDialog('outgoing') }, this.outgoingCount),
        ),
        h('main.projects', {},
          this.start,
          this.resume,
          this.recentSec,
          this.mineSec,
          this.sharedSec,
          this.ad,
          this.promo,
        ),
      ),
      this.accountPop,
      this.noticesPop,
    ));
  }

  get visible() { return !this.el.hidden; }

  /** A section's heading: tapping the title opens the section as a full list; See all does the same. */
  private secHead(tag: 'h2' | HTMLElement, title?: string): HTMLElement {
    const heading = typeof tag === 'string' ? h(tag, {}, h('button.sec-title', { type: 'button' }, title!)) : tag;
    const head = h('div.sec-head', {}, heading, h('button.sec-all.small', { type: 'button' }, 'See all'));
    head.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button')) return;
      const sec = head.parentElement!;
      this.expand(sec.classList.contains('open') ? null : sec);
    });
    return head;
  }

  /** Shows one section alone as a wrapping list, or everything again. */
  expand(sec: HTMLElement | null) {
    this.el.classList.toggle('expanded', !!sec);
    for (const s of this.el.querySelectorAll('.home-sec')) {
      s.classList.toggle('open', s === sec);
      s.querySelector('.sec-all')!.textContent = s === sec ? 'Back' : 'See all';
    }
    this.el.querySelector('.projects')!.scrollTop = 0;
  }

  show() {
    this.el.hidden = false;
    this.renderAccount();
    const guest = !!this.app.ed.me?.guest;
    this.el.classList.toggle('guest', guest);
    this.friendsPanel.hidden = guest;
    this.renderBanner();
    this.start.hidden = guest;
    this.renderPromo();
    this.renderAd();
    if (guest) { this.renderGuest(); return; }
    this.renderResume();
    this.projectsHead.firstElementChild!.textContent = 'Recent';
    this.expand(null);
    this.loadProjects();
    this.loadVisits();
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

  /** Offers the canvas that was open last time, until it is opened or dismissed. */
  private renderResume() {
    let last: LastOpen | null = null;
    try { last = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null'); } catch { /* storage blocked */ }
    const r = this.resume, s = this.app.session;
    r.hidden = !last || Date.now() - last.at > RESUME_MS;
    if (r.hidden) return;
    const { canvas, room, name, at } = last!;
    const forget = () => { try { localStorage.removeItem(LAST_KEY); } catch { /* storage blocked */ } r.hidden = true; };
    r.replaceChildren(
      h('span.muted', { html: icon('undo', 18) }),
      h('span.grow', {}, h('b', {}, name || 'Untitled'), h('small', {}, ` · open ${timeAgo(at)}`)),
      h('button.btn.small.primary', { type: 'button', onclick: () => { r.hidden = true; if (canvas) s.openLocal(canvas); else if (room) s.joinRoom(room); } }, 'Keep drawing'),
      h('button.icon-btn', { type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss', html: icon('x', 16), onclick: forget }),
    );
  }

  /** The admin's announcement, then the Patreon banner once per browser session until it is closed for good. */
  private renderBanner() {
    const n = this.app.session.server?.notice;
    this.notice.hidden = !n;
    if (n) { this.notice.textContent = n.text; this.notice.style.background = n.bg; this.notice.style.color = n.fg; }
    const url = this.app.session.server?.patreon;
    const b = this.banner;
    let seen = false;
    try { seen = sessionStorage.getItem(BANNER_KEY) === '1'; } catch { /* storage blocked */ }
    b.hidden = !url || !this.app.ed.prefs.supportBanner || seen;
    if (b.hidden || b.childElementCount) return;
    try { sessionStorage.setItem(BANNER_KEY, '1'); } catch { /* storage blocked */ }
    b.append(
      h('a.support-link', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Doodlehive is made by a few students. Patreon is what keeps the servers on.'),
      h('button.icon-btn', { type: 'button', title: 'Close', 'aria-label': 'Close', html: icon('x', 16), onclick: () => {
        b.hidden = true;
        this.app.ed.prefs.supportBanner = false;
        this.app.savePrefs();
      } }),
    );
  }

  /** Patreon, and the Discord server when `DISCORD_INVITE_URL` is set. */
  private renderPromo() {
    const srv = this.app.session.server;
    clear(this.promo);
    const card = (href: string, platform: string, title: string, text: string) =>
      h('a.promo-card', { href, target: '_blank', rel: 'noopener noreferrer' }, socialLogo(platform, 40), h('span.promo-text', {}, h('strong', {}, title), h('small', {}, text)));
    if (srv?.patreon) this.promo.append(card(srv.patreon, 'patreon', 'Support on Patreon', 'Extra themes, GIF pictures and more'));
    if (srv?.discordInvite) this.promo.append(card(srv.discordInvite, 'discord', 'Join the Discord', 'Chat with other artists'));
  }

  /** One banner for free accounts in the browser. Supporters, guests and the desktop and iPad apps never get it. */
  private renderAd() {
    const srv = this.app.session.server, me = this.app.ed.me, ads = srv?.ads;
    this.ad.hidden = !ads || !me || me.premium || me.guest || isNativeApp;
    if (this.ad.hidden || this.ad.childElementCount) return;
    this.ad.append(
      h('div.ad-head', {}, h('span', {}, 'Ad'),
        srv?.patreon ? h('a', { href: srv.patreon, target: '_blank', rel: 'noopener noreferrer' }, 'Supporters don’t see ads') : null),
      ads!.frameUrl
        // Sandboxed so the network's scripts can't reach the app or its cookies; clicks still open a tab.
        ? h('iframe.ad-frame', { src: ads!.frameUrl, title: 'Ad', loading: 'lazy', referrerpolicy: 'origin', sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox' })
        : h('div.ad-frame.ad-placeholder', {}, 'Ad space, 728 × 90'),
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
    this.meCard.className = 'me-card' + (me.gradient ? ' has-gradient' : '') + (me.banner ? ' has-banner' : '');
    this.meCard.setAttribute('style', (me.gradient ? gradientStyle(me.gradient) : `--g1:${me.favoriteColor};--g2:${me.favoriteColor}`) + (me.banner ? `;--banner:url(${me.banner})` : ''));
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
      h('button.menu-item', { html: icon('userWrench', 18) + '<span>Manage users</span>', onclick: () => { close(); this.peopleDialog('blocked'); } }),
      h('button.menu-item', { html: icon('settings', 18) + '<span>Preferences</span>', onclick: () => { close(); preferencesDialog(this.app); } }),
      me.admin ? h('a.menu-item', { href: '/admin', html: icon('shield', 18) + '<span>Admin</span>' }) : null,
      h('button.menu-item.danger', { html: icon('logout', 18) + '<span>Log out</span>', onclick: () => { close(); s.logout(); } }),
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
    this.app.setUnread(r.unread);
    if (!this.noticesPop.hidden) this.renderNotices();
  }

  /** Notifications as a dialog, for the drawing screen. */
  async showNotices() {
    await Promise.all([this.loadFriends(), this.loadNotices()]);
    let close = () => {};
    const body = h('div.modal-body.notices-body');
    const refresh = async () => { await Promise.all([this.loadFriends(), this.loadNotices()]); body.replaceChildren(...this.noticeRows(() => close(), refresh)); };
    body.append(...this.noticeRows(() => close(), refresh));
    const clearBtn = h('button.btn', { type: 'button', onclick: async () => { await api.clearNotices().catch(() => {}); refresh(); } }, 'Clear');
    close = modal('Notifications', body, [clearBtn]);
    this.markRead();
  }

  private markRead() {
    if (!this.notices.some((n) => !n.read)) return;
    this.bellBadge.hidden = true;
    this.app.setUnread(0);
    api.readNotices().catch(() => {});
  }

  private toggleNotices() {
    this.accountPop.hidden = true;
    this.noticesPop.hidden = !this.noticesPop.hidden;
    if (this.noticesPop.hidden) return;
    this.renderNotices();
    this.popUnder(this.noticesPop, this.bellBtn);
    this.markRead();
  }

  private renderNotices() {
    const pop = this.noticesPop;
    clear(pop);
    const refresh = () => { this.loadFriends(); this.loadNotices(); };
    pop.append(h('div.panel', {},
      h('div.panel-head', {}, h('span.panel-title', {}, 'Notifications'),
        this.notices.length ? h('button.btn.small', { type: 'button', onclick: async () => { await api.clearNotices().catch(() => {}); refresh(); } }, 'Clear') : null),
      ...this.noticeRows(() => { pop.hidden = true; }, refresh)));
  }

  /** The notification rows with their actions; `hide` closes whatever shows them before joining a room. */
  private noticeRows(hide: () => void, refresh: () => void): HTMLElement[] {
    const s = this.app.session;
    const rows = this.notices.map((n) => {
      const d = n.data as { user?: string; name?: string; room?: { id: string; name: string } };
      const actions: HTMLElement[] = [];
      if (n.kind === 'friend' && d.user && this.friends.incoming.some((p) => p.id === d.user)) {
        actions.push(
          h('button.icon-btn.accept', { title: 'Accept', 'aria-label': `Accept ${d.name}`, html: icon('check', 18), onclick: async () => { await api.acceptFriend(d.user!).catch(() => {}); refresh(); } }),
          h('button.icon-btn', { title: 'Decline', 'aria-label': `Decline ${d.name}`, html: icon('x', 18), onclick: async () => { await api.removeFriend(d.user!).catch(() => {}); refresh(); } }),
        );
      } else if (n.kind === 'invite' && d.room) {
        actions.push(h('button.btn.small.primary', { type: 'button', onclick: () => { hide(); s.joinRoom(d.room!.id); } }, 'Join'));
      }
      const ic = n.kind === 'friend' ? 'userPlus' : n.kind === 'friend-accepted' ? 'users' : n.kind === 'invite' ? 'link' : 'sparkle';
      return h(`div.notice-row${n.read ? '' : '.unread'}` as 'div', {}, h('span.notice-icon', { html: icon(ic, 18) }),
        h('span.notice-text', {}, n.text, h('small', {}, timeAgo(n.at))), ...actions);
    });
    return rows.length ? rows : [h('p.notices-empty', {}, 'Nothing new')];
  }

  // ---- Friends ----

  async loadFriends() {
    try { this.setFriends(await api.friends()); } catch { /* offline for a moment; try again next poll */ }
  }

  private setFriends(f: FriendsList) {
    // The list is polled every minute; leave the DOM alone when nothing changed.
    const json = JSON.stringify(f);
    if (json === this.friendsJson) return;
    this.friendsJson = json;
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
    this.outgoingCount.hidden = !f.outgoing.length;
    this.outgoingCount.textContent = String(f.outgoing.length);
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

  /** Outgoing requests and blocked people, one window with a tab each. */
  peopleDialog(tab: PeopleTab) {
    peopleDialog(this.app.ed, tab, (f) => this.setFriends(f));
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
    this.projectsHead.firstElementChild!.textContent = 'You’re a guest';
    this.sharedSec.hidden = this.mineSec.hidden = true;
    clear(this.recent);
    this.recent.append(h('div.guest-card', {},
      h('p', {}, 'You’re drawing as ', h('strong', {}, me.displayName), ' (@' + me.handle + ').'),
      h('p.muted', {}, 'Log in with Discord to make canvases, add friends and pick a handle.'),
      h('div.row', {},
        h('button.btn', { type: 'button', onclick: () => this.app.session.createNew() }, 'Join a canvas'),
        h('button.btn.primary', { type: 'button', onclick: () => this.app.session.logout('/login?next=/app') }, 'Log in with Discord')),
    ));
  }

  // ---- Projects ----

  /** Recent: the last few canvases touched, yours and other people's, newest first. */
  private renderRecent() {
    const items = [...this.projects.map((p) => ({ at: p.updatedAt, el: () => this.projectTile(p) })), ...this.visits.map((v) => ({ at: v.at, el: () => this.visitTile(v) }))];
    items.sort((a, b) => b.at - a.at);
    clear(this.recent);
    for (const it of items.slice(0, RECENT_MAX)) this.recent.append(it.el());
    if (!items.length) this.recent.append(h('p.projects-empty', {}, 'No canvases yet. Start one with Draw alone.'));
  }

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
    this.projects = list;
    clear(this.mine);
    this.mineSec.hidden = !list.length;
    for (const p of list) this.mine.append(this.projectTile(p));
    this.renderRecent();
  }

  /** Rooms of other people you joined; open ones can be rejoined. */
  async loadVisits() {
    let visits: VisitInfo[] = [];
    try { visits = await api.visits(); } catch { /* shown empty */ }
    this.visits = visits;
    clear(this.shared);
    this.sharedSec.hidden = !visits.length;
    for (const v of visits) this.shared.append(this.visitTile(v));
    this.renderRecent();
  }

  private visitTile(v: VisitInfo): HTMLElement {
    const who = v.owner?.displayName ?? 'Someone';
    return h('div.project-tile', {},
      h('button.tile-open', { type: 'button', 'aria-label': `Open ${v.name}`, onclick: () => this.app.session.joinRoom(v.id) },
        this.thumb(v.thumb, v.online, v.private ? 'lock' : 'brush'),
        h('span.tile-name', {}, v.name),
        h('span.tile-meta', {}, v.owner ? avatarEl(v.owner, 16) : null, `${who} · ${v.online ? 'Open now' : timeAgo(v.at)}`)),
    );
  }

  private thumb(src: string | null, online: number, blank: string): HTMLElement {
    const thumb = h('span.tile-thumb', {});
    // The tile takes the canvas's own shape, within reason, instead of boxing it into a square.
    if (src) { const img: HTMLImageElement = h('img', { src, alt: '', loading: 'lazy' }); img.onload = () => { thumb.style.aspectRatio = String(Math.max(0.6, Math.min(2, img.naturalWidth / img.naturalHeight))); }; thumb.append(img); }
    else thumb.append(h('span.tile-blank', { html: icon(blank, 28) }));
    if (online) thumb.append(h('span.live-pill', {}, `${online} drawing`));
    return thumb;
  }

  private projectTile(p: ProjectInfo): HTMLElement {
    const thumb = this.thumb(p.thumb, p.online, 'brush');
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
      item('info', 'Properties', () => this.properties(p)),
      item('rename', 'Rename', async () => {
        const name = await textDialog('Rename canvas', p.name);
        if (name == null) return;
        await patchCanvas(p.id, { name }).catch(() => {});
        this.loadProjects();
      }),
      item('trash', 'Delete', async () => {
        if (!(await confirmDialog('Delete this canvas?', `“${p.name}” will be removed from this device.`, 'Delete'))) return;
        await deleteCanvas(p.id).catch(() => {});
        await deleteLapse(p.id).catch(() => {});
        this.loadProjects();
      }, '.danger'),
    ));
    else pop.append(h('div.panel', {},
      item('info', 'Properties', () => this.properties(p)),
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
        try { await api.deleteRoom(p.id); deleteLapse(roomLapseKey(p.id)).catch(() => {}); this.loadProjects(); } catch (e) { this.app.toast((e as Error).message); }
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

  /** Where the canvas lives, with what fits that: who was invited, show the file, save a copy, or bring it off the server. */
  private async properties(p: ProjectInfo) {
    const s = this.app.session;
    const row = (label: string, ...value: (Node | string | null)[]) => h('div.prop-row', {}, h('span.prop-label', {}, label), h('span.prop-value', {}, ...value));
    const size = (st: { infinite: boolean; width: number; height: number } | undefined) => st ? (st.infinite ? 'Unlimited' : `${st.width} × ${st.height}`) : '';
    const body = h('div.modal-body.props'), actions: HTMLElement[] = [];
    let close = () => {};
    try {
      if (p.local) {
        const c = await getCanvas(p.id);
        const reveal = native?.canvases.reveal;
        body.append(row('Size', size(c?.settings)),
          row('Stored', h('span', { html: icon(isNativeApp ? 'device' : 'warning', 16) }), isNativeApp ? 'On this device' : 'In this browser’s cache',
            reveal ? h('button.icon-btn', { type: 'button', title: 'Show in folder', 'aria-label': 'Show in folder', html: icon('folder', 18), onclick: () => reveal(p.id) }) : null),
          row('People', 'Just you'));
        if (!isNativeApp) actions.push(h('button.btn', { type: 'button', html: icon('download', 16) + '<span>Save as file</span>', onclick: () => { close(); s.exportLocal(p.id); } }));
      } else {
        const info = await api.room(p.id), invited = info.invited ?? [], visitors = info.visitors ?? [];
        const sh = info.share, who = sh.visibility === 'private' ? 'Only you and people you invite' : sh.visibility === 'friends' ? 'Your friends' : sh.visibility === 'unlisted' ? 'Anyone with the link (hidden from lists)'
          : `Anyone with the link${sh.requireLogin ? ' who is logged in' : ''}${sh.approveJoins ? ', once you let them in' : ''}`;
        const people = (list: PublicProfile[]) => list.length ? h('span.avatar-row', {}, ...list.map((u) => Object.assign(avatarEl(u, 28), { title: u.displayName }))) : h('span.muted', {}, 'No one yet');
        body.append(row('Size', size(info.settings)),
          row('Stored', h('span', { html: icon('cloud', 16) }), 'Safe on the server'),
          row('Who can join', who),
          row('Invited', people(invited)),
          row('Opened by', people(visitors)));
        actions.push(h('button.btn', { type: 'button', html: icon('device', 16) + '<span>Move to this device</span>', onclick: async () => {
          close();
          if (await confirmDialog('Move to this device?', 'It leaves the server when you close it. A copy stays on this device.', 'Move')) s.joinRoom(p.id, null, { takeLocal: true });
        } }));
      }
    } catch (e) { this.app.toast((e as Error).message); return; }
    close = modal(p.name, body, actions);
  }
}

