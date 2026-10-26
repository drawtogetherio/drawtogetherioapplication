import { TiledSurface } from '../core/tiles';
import { StrokeRenderer } from '../engine/brush';
import { Rect, selPath } from '../core/geom';
import type { Editor } from '../editor';
import type { RoomClient, RoomEvent } from '../net/roomClient';
import type { PublicProfile } from '../shared/profile';
import { CHAT_MAX, ChatMsg, Member } from '../shared/protocol';
import { clear, h } from './dom';
import { icon } from './icons';
import { avatarEl, avatarImage, badges, initials, inkOn, nameLine, nameText, profileCardBody } from './people';
import { confirmDialog, exportDialog, modal } from './dialogs';
import { blockPerson, unblockPerson } from './blocks';
import { api } from '../net/api';
import { EMOJI, emojiMatches, emojify } from '../shared/emoji';

const MENTION = /<@([\w-]+)>/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface RemoteStroke { renderer: StrokeRenderer; buffer: TiledSurface; count: number; touched: number; pending: number[]; tilt: number[]; pad: number }
interface Bubble { x: number; y: number; drawing: boolean; t: number }

const BUBBLE_LINGER = 1200;

/** Other people's live strokes and name bubbles, the member list, and chat. */
export class RoomUI {
  readonly membersPanel = h('div.panel.members-panel');
  readonly chatEl: HTMLElement;
  private chatLog = h('div.chat-log', { 'aria-live': 'polite' });
  private typingEl = h('div.chat-typing');
  private chatInput: HTMLInputElement;
  private chatForm: HTMLFormElement;
  private strokes = new Map<string, RemoteStroke>();
  private drawn = 0;
  private catchUp = 0;
  private bubbles = new Map<string, Bubble>();
  private unsub: (() => void) | null = null;
  private typingSent = 0;
  private fadeTimer = 0;
  private suggest = h('div.chat-suggest', { hidden: true, role: 'listbox' });
  /** Names picked from the suggestions for this draft, so they can be sent as ids. */
  private picks = new Map<string, string>();
  private audio: AudioContext | null = null;
  chatOpen = false;
  onLeave: () => void = () => {};

  constructor(private ed: Editor) {
    this.chatInput = h('input.chat-input', { type: 'text', id: 'chat-input', maxlength: CHAT_MAX, placeholder: 'Say something…', autocomplete: 'off', 'aria-label': 'Chat message' });
    this.chatForm = h('form.chat-form', {}, this.chatInput, h('button.icon-btn', { type: 'submit', title: 'Send', 'aria-label': 'Send', html: icon('send', 18) }));
    this.chatForm.hidden = true;
    this.chatEl = h('div.chat', { hidden: true }, this.chatLog, this.typingEl, this.suggest, this.chatForm);
    this.chatForm.addEventListener('submit', (e) => { e.preventDefault(); this.sendChat(); });
    this.chatInput.addEventListener('input', () => { this.typing(this.chatInput.value.trim().length > 0); this.renderSuggest(); });
    this.chatInput.addEventListener('keydown', (e) => this.suggestKey(e));
    this.chatInput.addEventListener('blur', () => { this.typing(false); setTimeout(() => { this.suggest.hidden = true; }, 150); });
    setInterval(() => this.tick(), 1000);
    ed.on((w) => { if (w === 'blocked') { this.renderMembers(); this.renderChat(); ed.view.requestRender(); } });
    ed.view.prepare = () => this.drawRemote();
  }

  get room() { return this.ed.room; }
  private blocked(id: string) { return !!this.ed.me?.blocked.includes(id); }

  attach(room: RoomClient) {
    this.unsub?.();
    this.strokes.clear();
    this.bubbles.clear();
    this.unsub = room.on((e) => this.handle(e));
    room.liveBuffer = (op) => {
      if (op.t !== 'stroke') return undefined;
      const s = this.strokes.get(op.author + ':' + op.id);
      if (!s || s.count !== op.pts.length) return undefined;
      this.drawPending(s);
      s.renderer.end();
      return s.buffer;
    };
    this.chatEl.hidden = false;
    this.renderChat();
    this.renderMembers();
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
    this.strokes.clear();
    this.bubbles.clear();
    this.ed.view.remoteLive.clear();
    this.chatEl.hidden = true;
    this.toggleChat(false);
  }

  private drawPending(s: RemoteStroke) {
    const p = s.pending, t = s.tilt;
    for (let i = 0, j = 0; i + 2 < p.length; i += 3, j += 2) {
      const r = s.renderer.add(p[i], p[i + 1], p[i + 2], t[j] ?? 0, t[j + 1] ?? 0);
      if (r) this.ed.view.invalidate(r);
    }
    s.pending = [];
    s.tilt = [];
    s.renderer.sync(); // the frame composites right after this, before any microtask
  }

  /** Whether any waiting point of the stroke lands on screen. */
  private inView(s: RemoteStroke, v: Rect) {
    const p = s.pending, d = s.pad;
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (p[i] + d >= v.x && p[i] - d <= v.x + v.w && p[i + 1] + d >= v.y && p[i + 1] - d <= v.y + v.h) return true;
    }
    return false;
  }

  /**
   * Paints other people's new points before each frame. Strokes off screen wait (they are painted
   * at once when they commit), and while you draw, others' strokes catch up only ten times a second.
   */
  private drawRemote() {
    const ed = this.ed;
    if (!this.strokes.size) return;
    const now = performance.now();
    if (ed.view.live && now - this.drawn < 100) {
      if (!this.catchUp) this.catchUp = window.setTimeout(() => { this.catchUp = 0; ed.view.requestRender(); }, 100);
      return;
    }
    this.drawn = now;
    const v = ed.view.visible();
    for (const s of this.strokes.values()) if (s.pending.length && this.inView(s, v)) this.drawPending(s);
  }

  /** Stops showing a live stroke; repaints just where it was when `repaint`. */
  private dropStroke(id: string, repaint = false) {
    const s = this.strokes.get(id);
    if (!s) return false;
    this.strokes.delete(id);
    this.ed.view.remoteLive.delete(id);
    if (repaint) { const r = s.buffer.tileBounds(); if (r) this.ed.view.invalidate(r); }
    return true;
  }

  private handle(e: RoomEvent) {
    const ed = this.ed;
    switch (e.kind) {
      case 'op':
        this.dropStroke(e.from + ':' + e.op.id);
        return;
      case 'members':
        this.renderMembers();
        ed.emit('members');
        ed.view.requestRender();
        return;
      case 'chat':
        this.renderChat();
        if (e.msg.from !== this.room?.you && !this.blocked(e.msg.from) && e.msg.text.includes(`<@${this.room?.you}>`)) this.ping(e.msg);
        return;
      case 'requests':
        this.renderChat();
        return;
      case 'typing':
        this.renderTyping();
        return;
      case 'live': {
        const l = e.live, key = e.from + ':' + l.stroke;
        if (!ed.prefs.showLive) { // just the bubble; the finished stroke arrives as an edit
          const n = l.pts.length;
          if (n >= 3) { this.bubbles.set(e.from, { x: l.pts[n - 3], y: l.pts[n - 2], drawing: true, t: Date.now() }); ed.view.requestRender(); }
          return;
        }
        let s = this.strokes.get(key);
        if (!s) {
          const buffer = new TiledSurface(), layer = ed.doc.layer(l.layer);
          const under = (l.mask ? layer?.mask : layer?.surface) ?? undefined;
          s = { renderer: new StrokeRenderer(buffer, l.brush, l.color, { seed: l.stroke, under }), buffer, count: 0, touched: 0, pending: [], tilt: [], pad: l.brush.size / 2 + 2 };
          this.strokes.set(key, s);
          ed.view.remoteLive.set(key, {
            layerId: l.layer, buffer, bufferAlpha: l.brush.opacity,
            bufferOp: l.erase ? 'destination-out' : layer?.props.alphaLock && !l.mask ? 'source-atop' : 'source-over',
            clip: l.clip ? selPath(l.clip) : undefined, mask: l.mask,
          });
        }
        s.touched = Date.now();
        s.count += l.pts.length;
        for (const v of l.pts) s.pending.push(v);
        if (l.tilt) for (const v of l.tilt) s.tilt.push(v);
        const n = l.pts.length;
        if (n >= 3) this.bubbles.set(e.from, { x: l.pts[n - 3], y: l.pts[n - 2], drawing: true, t: Date.now() });
        if (this.inView(s, ed.view.visible())) ed.view.requestRender();
        return;
      }
      case 'live-end':
        this.dropStroke(e.from + ':' + e.stroke, true);
        return;
      case 'cursor':
        this.bubbles.set(e.from, { x: e.x, y: e.y, drawing: e.drawing, t: Date.now() });
        ed.view.requestRender();
        return;
      case 'status':
        if (this.room?.status === 'kicked') this.kickedNotice();
        return;
    }
  }

  private tick() {
    const now = Date.now();
    // Not while you draw: others' commits wait until your pen lifts, and their previews stand in.
    if (!this.ed.view.live) for (const [id, s] of this.strokes) if (now - s.touched > 10_000) this.dropStroke(id, true);
    if (this.room) {
      let changed = false;
      for (const [id, t] of this.room.typing) if (t < now) { this.room.typing.delete(id); changed = true; }
      if (changed) this.renderTyping();
    }
    if (!this.chatOpen) this.fadeChat();
  }

  // ---- Bubbles ----

  drawBubbles(ctx: CanvasRenderingContext2D, M: DOMMatrix) {
    const room = this.room;
    if (!room || !this.ed.prefs.showBubbles) return;
    const now = Date.now();
    let animating = false;
    for (const [uid, b] of this.bubbles) {
      const m = room.member(uid);
      if (!m || uid === room.you || this.blocked(uid)) continue;
      const age = b.drawing ? Math.max(0, now - b.t - 600) : now - b.t;
      const alpha = Math.max(0, 1 - age / BUBBLE_LINGER);
      if (alpha <= 0) { this.bubbles.delete(uid); continue; }
      animating = true;
      const p = M.transformPoint({ x: b.x, y: b.y });
      this.drawBubble(ctx, p.x, p.y, m, alpha);
    }
    if (animating) setTimeout(() => this.ed.view.requestRender(), 80);
  }

  private drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, m: Member, alpha: number) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const name = m.displayName.length > 24 ? m.displayName.slice(0, 23) + '…' : m.displayName;
    const tw = ctx.measureText(name).width;
    const H = 28, A = 20, pad = 5, tri = 7, gap = 8;
    const W = pad + A + 7 + tw + 10;
    const bx = Math.round(x - W / 2), by = Math.round(y - gap - tri - H);
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#1d1d22';
    ctx.beginPath();
    ctx.roundRect(bx, by, W, H, 9);
    ctx.moveTo(x - tri, by + H - 0.5);
    ctx.lineTo(x, by + H + tri);
    ctx.lineTo(x + tri, by + H - 0.5);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (m.gradient) {
      const g = ctx.createLinearGradient(bx, by, bx + W, by + H);
      g.addColorStop(0, m.gradient[0]);
      g.addColorStop(1, m.gradient[1]);
      ctx.strokeStyle = g;
    } else ctx.strokeStyle = m.favoriteColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    const ax = bx + pad + A / 2, ay = by + H / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, A / 2, 0, Math.PI * 2);
    ctx.clip();
    const img = m.avatar ? avatarImage(m.avatar, () => this.ed.view.requestRender()) : null;
    if (img) ctx.drawImage(img, ax - A / 2, ay - A / 2, A, A);
    else {
      ctx.fillStyle = m.favoriteColor;
      ctx.fillRect(ax - A / 2, ay - A / 2, A, A);
      ctx.fillStyle = inkOn(m.favoriteColor);
      ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials(m.displayName), ax, ay + 0.5);
    }
    ctx.restore();
    ctx.fillStyle = '#f2f2f6';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(name, bx + pad + A + 7, by + H / 2 + 0.5);
    ctx.restore();
  }

  // ---- Members ----

  renderMembers() {
    const room = this.room;
    const panel = this.membersPanel;
    clear(panel);
    if (!room) return;
    const order = { owner: 0, host: 1, member: 2, spectator: 3 } as const;
    const members = room.members.filter((m) => !this.blocked(m.id)).sort((a, b) => order[a.role] - order[b.role] || a.displayName.localeCompare(b.displayName));
    panel.append(h('div.panel-head', {}, h('span.panel-title', {}, `In this room · ${members.length}`)));
    const list = h('div.member-list');
    for (const m of members) {
      list.append(h('button.member-row', { type: 'button', onclick: () => this.profileCard(m) },
        avatarEl(m, 32),
        h('span.member-text', {}, nameLine(m, m.role, m.id === room.you), h('small', {}, m.role === 'spectator' ? 'watching' : '@' + m.handle)),
      ));
    }
    panel.append(list);
  }

  profileCard(m: Member) {
    const room = this.room!, me = this.ed.me;
    const actions: HTMLElement[] = [];
    const meRole = room.me?.role;
    const canKick = room.isHost && m.id !== room.you && m.role !== 'owner' && !(m.role === 'host' && meRole !== 'owner');
    let close = () => {};
    if (me && m.id !== room.you) {
      if (!me.guest && !m.guest) {
        const add = h('button.btn', { html: icon('userPlus', 16) + '<span>Add friend</span>', onclick: async () => {
          add.disabled = true;
          try { const r = await api.addFriend(m.handle); this.ed.toast(r.result === 'accepted' ? 'You’re now friends!' : 'Friend request sent'); add.lastElementChild!.textContent = r.result === 'accepted' ? 'Friends' : 'Requested'; }
          catch (e) { add.disabled = false; this.ed.toast((e as Error).message); }
        } });
        // Already friends, or asked: the button says so instead.
        api.friends().then((f) => {
          const state = f.friends.some((p) => p.id === m.id) ? 'Friends' : f.outgoing.some((p) => p.id === m.id) ? 'Requested' : f.incoming.some((p) => p.id === m.id) ? 'Accept request' : '';
          if (state && state !== 'Accept request') { add.disabled = true; add.lastElementChild!.textContent = state; }
          else if (state) add.lastElementChild!.textContent = state;
        }).catch(() => {});
        actions.push(add);
      }
      if (!me.guest) {
        actions.push(this.blocked(m.id)
          ? h('button.btn', { onclick: async () => { close(); await unblockPerson(this.ed, m.id); } }, 'Unblock')
          : h('button.btn.danger', { onclick: async () => { close(); if (await blockPerson(this.ed, m)) this.ed.toast(`${m.displayName} is blocked`); } }, 'Block'));
      }
    }
    if (meRole === 'owner' && m.id !== room.you && m.role !== 'spectator') {
      const on = m.role !== 'host';
      actions.push(h('button.btn', { onclick: () => { room.send({ type: 'set-host', user: m.id, on }); close(); } }, on ? 'Make host' : 'Remove host'));
    }
    if (canKick) {
      actions.push(h('button.btn.danger', {
        html: icon('kick', 16) + '<span>Remove</span>',
        onclick: async () => {
          close();
          if (await confirmDialog(`Remove ${m.displayName}?`, 'They can’t rejoin for 10 minutes. Their layers stay.', 'Remove')) {
            room.send({ type: 'kick', user: m.id });
          }
        },
      }));
    }
    close = modal(m.id === room.you ? 'You' : 'Profile', profileCardBody(m, m.role), actions);
  }

  // ---- Chat ----

  toggleChat(open = !this.chatOpen) {
    this.chatOpen = open && !!this.room;
    this.chatForm.hidden = !this.chatOpen;
    this.chatEl.classList.toggle('open', this.chatOpen);
    if (this.chatOpen) { this.renderChat(); this.chatInput.focus(); } else { this.chatInput.blur(); this.typing(false); this.fadeChat(); }
  }

  private sendChat() {
    let text = emojify(this.chatInput.value.trim());
    if (!text || !this.room) return;
    for (const [name, id] of this.picks) text = text.replace(new RegExp('@' + escapeRe(name) + '(?![\\w])', 'g'), `<@${id}>`);
    this.picks.clear();
    this.room.send({ type: 'chat', text });
    this.chatInput.value = '';
    this.suggest.hidden = true;
    this.typingSent = 0;
    // Closing hands the keys back to the canvas.
    this.toggleChat(false);
  }

  private typing(on: boolean) {
    if (!this.room) return;
    const now = Date.now();
    if (on && now - this.typingSent < 2500) return;
    if (!on && !this.typingSent) return;
    this.typingSent = on ? now : 0;
    this.room.send({ type: 'typing', on });
  }

  renderChat() {
    const room = this.room;
    if (!room) return;
    const msgs = room.chat.filter((m) => !this.blocked(m.from)).slice(-(this.chatOpen ? 50 : 6));
    this.chatLog.replaceChildren(...msgs.map((m) => this.chatLine(m)), ...room.requests.map((u) => this.requestLine(u)));
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    this.fadeChat();
  }

  private requestLine(u: PublicProfile): HTMLElement {
    const room = this.room!;
    return h('div.chat-msg.join-request', {},
      avatarEl(u, 22),
      h('span.join-text', {}, nameText(u, 'chat-who', u.favoriteColor), ' wants to join the session'),
      h('button.btn.small.allow', { type: 'button', onclick: () => room.admit(u.id, true) }, 'Allow'),
      h('button.btn.small.deny', { type: 'button', onclick: () => room.admit(u.id, false) }, 'Deny'),
    );
  }

  private chatLine(m: ChatMsg): HTMLElement {
    const el = h(`div.chat-msg${m.system ? '.system' : ''}` as 'div', { 'data-at': m.at });
    if (m.system) { el.textContent = m.text; return el; }
    const who = this.room?.member(m.from);
    const name = h('span.chat-name', {}, who ? nameText(who, 'chat-who', who.favoriteColor) : 'Someone');
    if (who) name.append(badges(who.role, who.premium, who.badges));
    if (who) el.append(h('button.chat-pic', { type: 'button', title: who.displayName, 'aria-label': `${who.displayName}’s profile`, onclick: () => this.profileCard(who) }, avatarEl(who, 20)));
    if (m.text.includes(`<@${this.room?.you}>`)) el.classList.add('mentioned');
    el.append(name, this.chatText(m.text));
    return el;
  }

  /** Message text with <@id> shown as the person's name in their colour. */
  private chatText(text: string): HTMLElement {
    const el = h('span.chat-text');
    let last = 0;
    for (const m of text.matchAll(MENTION)) {
      el.append(text.slice(last, m.index));
      const who = this.room?.member(m[1]);
      el.append(who ? nameText({ displayName: '@' + who.displayName, gradient: who.gradient }, 'mention', who.favoriteColor) : '@someone');
      last = m.index + m[0].length;
    }
    el.append(text.slice(last));
    return el;
  }

  // ---- Mentions and emoji ----

  /** The @name or :code being typed at the caret, if any. */
  private token(): { kind: '@' | ':'; q: string; start: number } | null {
    const v = this.chatInput.value, end = this.chatInput.selectionStart ?? v.length;
    const m = /(^|\s)([@:])([^\s:@]*(?: [^\s:@]*)?)$/.exec(v.slice(0, end));
    if (!m) return null;
    const kind = m[2] as '@' | ':', q = m[3];
    if (kind === ':' && (q.length < 2 || q.includes(' '))) return null;
    return { kind, q, start: end - q.length - 1 };
  }

  private renderSuggest() {
    const t = this.token(), room = this.room;
    this.suggest.hidden = true;
    if (!t || !room) return;
    const q = t.q.toLowerCase();
    const items: HTMLElement[] = t.kind === '@'
      ? room.members.filter((m) => m.id !== room.you && !this.blocked(m.id) && (m.displayName.toLowerCase().includes(q) || m.handle.toLowerCase().includes(q))).slice(0, 6)
        .map((m) => h('button.suggest-item', { type: 'button', onclick: () => this.pick('@' + m.displayName + ' ', m) }, avatarEl(m, 20), nameText(m, 'person-name', m.favoriteColor), h('small', {}, '@' + m.handle)))
      : emojiMatches(q).map((n) => h('button.suggest-item', { type: 'button', onclick: () => this.pick(EMOJI[n] + ' ') }, h('span.emoji', {}, EMOJI[n]), h('small', {}, ':' + n + ':')));
    if (!items.length) return;
    items[0].classList.add('active');
    this.suggest.replaceChildren(...items);
    this.suggest.hidden = false;
  }

  private pick(text: string, who?: Member) {
    const t = this.token();
    if (!t) return;
    const v = this.chatInput.value;
    this.chatInput.value = v.slice(0, t.start) + text + v.slice(this.chatInput.selectionStart ?? v.length);
    this.chatInput.setSelectionRange(t.start + text.length, t.start + text.length);
    if (who) this.picks.set(who.displayName, who.id);
    this.suggest.hidden = true;
    this.chatInput.focus();
  }

  private suggestKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); if (!this.suggest.hidden) this.suggest.hidden = true; else this.toggleChat(false); return; }
    if (this.suggest.hidden) return;
    const items = [...this.suggest.children] as HTMLElement[], i = items.findIndex((x) => x.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      items[i]?.classList.remove('active');
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].classList.add('active');
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === 'Tab') { items[i]?.click(); e.preventDefault(); }
  }

  /** Someone mentioned you: a chime and a toast, even with chat closed. */
  private ping(m: ChatMsg) {
    const who = this.room?.member(m.from);
    this.ed.toast(`${who?.displayName ?? 'Someone'} mentioned you`);
    if (!this.ed.prefs.chime) return;
    try {
      const ac = this.audio ??= new AudioContext();
      if (ac.state === 'suspended') void ac.resume();
      const t0 = ac.currentTime;
      for (const [f, at] of [[880, 0], [1320, 0.09]] as const) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
        o.connect(g).connect(ac.destination);
        o.start(t0 + at); o.stop(t0 + at + 0.55);
      }
    } catch { /* no audio here */ }
  }

  /** With chat closed, old messages fade like a game chat. */
  private fadeChat() {
    clearTimeout(this.fadeTimer);
    const now = Date.now();
    for (const el of this.chatLog.children as HTMLCollectionOf<HTMLElement>) {
      el.classList.toggle('faded', !this.chatOpen && now - Number(el.dataset.at) > 15_000);
    }
  }

  private renderTyping() {
    const room = this.room;
    if (!room) return;
    const names = [...room.typing.keys()].filter((id) => id !== room.you && !this.blocked(id)).map((id) => room.member(id)?.displayName).filter(Boolean) as string[];
    if (!names.length) { this.typingEl.textContent = ''; this.typingEl.hidden = true; return; }
    this.typingEl.hidden = false;
    const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} people`;
    this.typingEl.replaceChildren(h('span.dots', {}, h('i'), h('i'), h('i')), h('span', {}, `${who} ${names.length === 1 ? 'is' : 'are'} typing`));
  }

  private kickedShown: RoomClient | null = null;
  private kickedNotice() {
    if (this.kickedShown === this.room) return;
    this.kickedShown = this.room;
    const body = h('div.modal-body', {}, h('p', {}, 'A host removed you from this room.'));
    const ok = h('button.btn.primary', {}, 'Back to start');
    const save = h('button.btn', { html: icon('download', 16) + '<span>Export a copy</span>', onclick: () => exportDialog(this.ed) });
    const close = modal('Removed', body, this.ed.readOnly ? [ok] : [save, ok], () => this.onLeave(), false);
    ok.addEventListener('click', () => close());
  }
}
