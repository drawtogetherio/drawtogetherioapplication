import { TiledSurface } from '../core/tiles';
import { StrokeRenderer } from '../engine/brush';
import { polyPath } from '../core/geom';
import type { Editor } from '../editor';
import type { RoomClient, RoomEvent } from '../net/roomClient';
import type { PublicProfile } from '../shared/profile';
import { CHAT_MAX, ChatMsg, Member } from '../shared/protocol';
import { clear, h } from './dom';
import { icon } from './icons';
import { avatarEl, avatarImage, badges, initials, inkOn, nameLine, nameText, profileCardBody } from './people';
import { confirmDialog, exportDialog, modal } from './dialogs';

interface RemoteStroke { renderer: StrokeRenderer; layerId: string; touched: number }
interface Bubble { x: number; y: number; drawing: boolean; t: number }

const BUBBLE_LINGER = 1200;

/**
 * Everything that appears only in a shared room: other people's live strokes and name bubbles,
 * the member list, and chat.
 */
export class RoomUI {
  readonly membersPanel = h('div.panel.members-panel');
  readonly chatEl: HTMLElement;
  private chatLog = h('div.chat-log', { 'aria-live': 'polite' });
  private typingEl = h('div.chat-typing');
  private chatInput: HTMLInputElement;
  private chatForm: HTMLFormElement;
  private strokes = new Map<string, RemoteStroke>();
  private bubbles = new Map<string, Bubble>();
  private unsub: (() => void) | null = null;
  private typingSent = 0;
  private fadeTimer = 0;
  chatOpen = false;
  onLeave: () => void = () => {};

  constructor(private ed: Editor) {
    this.chatInput = h('input.chat-input', { type: 'text', id: 'chat-input', maxlength: CHAT_MAX, placeholder: 'Say something…', autocomplete: 'off', 'aria-label': 'Chat message' });
    this.chatForm = h('form.chat-form', {}, this.chatInput, h('button.icon-btn', { type: 'submit', title: 'Send', 'aria-label': 'Send', html: icon('send', 18) }));
    this.chatForm.hidden = true;
    this.chatEl = h('div.chat', { hidden: true }, this.chatLog, this.typingEl, this.chatForm);
    this.chatForm.addEventListener('submit', (e) => { e.preventDefault(); this.sendChat(); });
    this.chatInput.addEventListener('input', () => this.typing(this.chatInput.value.trim().length > 0));
    this.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.toggleChat(false); e.stopPropagation(); } });
    this.chatInput.addEventListener('blur', () => this.typing(false));
    setInterval(() => this.tick(), 1000);
  }

  get room() { return this.ed.room; }

  attach(room: RoomClient) {
    this.unsub?.();
    this.strokes.clear();
    this.bubbles.clear();
    this.unsub = room.on((e) => this.handle(e));
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

  private handle(e: RoomEvent) {
    const ed = this.ed;
    switch (e.kind) {
      case 'op':
        if (this.strokes.delete(e.op.id)) { ed.view.remoteLive.delete(e.op.id); }
        return;
      case 'members':
        this.renderMembers();
        ed.emit('members');
        ed.view.requestRender();
        return;
      case 'chat':
      case 'requests':
        this.renderChat();
        return;
      case 'typing':
        this.renderTyping();
        return;
      case 'live': {
        let s = this.strokes.get(e.live.stroke);
        const l = e.live;
        if (!s) {
          const buffer = new TiledSurface();
          s = { renderer: new StrokeRenderer(buffer, l.brush, l.color), layerId: l.layer, touched: 0 };
          this.strokes.set(l.stroke, s);
          const layer = ed.doc.layer(l.layer);
          ed.view.remoteLive.set(l.stroke, {
            layerId: l.layer, buffer, bufferAlpha: l.brush.opacity,
            bufferOp: l.erase ? 'destination-out' : layer?.props.alphaLock ? 'source-atop' : 'source-over',
            clip: l.clip ? polyPath(l.clip.pts) : undefined,
          });
        }
        s.touched = Date.now();
        for (let i = 0; i + 2 < l.pts.length; i += 3) {
          const r = s.renderer.add(l.pts[i], l.pts[i + 1], l.pts[i + 2]);
          if (r) ed.view.invalidate(r);
        }
        const n = l.pts.length;
        if (n >= 3) this.bubbles.set(e.from, { x: l.pts[n - 3], y: l.pts[n - 2], drawing: true, t: Date.now() });
        return;
      }
      case 'live-end':
        if (this.strokes.delete(e.stroke)) { ed.view.remoteLive.delete(e.stroke); ed.view.invalidate(null); }
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

  /** Housekeeping: drop stale live strokes, typing indicators and bubbles. */
  private tick() {
    const now = Date.now();
    for (const [id, s] of this.strokes) {
      if (now - s.touched > 10_000) { this.strokes.delete(id); this.ed.view.remoteLive.delete(id); this.ed.view.invalidate(null); }
    }
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
    if (!room || !this.ed.settings.showBubbles) return;
    const now = Date.now();
    let animating = false;
    for (const [uid, b] of this.bubbles) {
      const m = room.member(uid);
      if (!m || uid === room.you) continue;
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
    ctx.strokeStyle = m.favoriteColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    // avatar
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
    const order = { owner: 0, host: 1, member: 2 } as const;
    const members = [...room.members].sort((a, b) => order[a.role] - order[b.role] || a.displayName.localeCompare(b.displayName));
    panel.append(h('div.panel-head', {}, h('span.panel-title', {}, `In this room · ${members.length}`)));
    const list = h('div.member-list');
    for (const m of members) {
      const row = h('button.member-row', { type: 'button', onclick: () => this.profileCard(m) },
        avatarEl(m, 32),
        h('span.member-text', {}, nameLine(m, m.role, m.id === room.you), h('small', {}, '@' + m.handle)),
      );
      list.append(row);
    }
    panel.append(list);
    if (room.isHost) panel.append(h('p.muted.small', {}, 'Hosts can edit anyone’s layers and remove people from the room.'));
  }

  profileCard(m: Member) {
    const room = this.room!;
    const actions: HTMLElement[] = [];
    const meRole = room.me?.role;
    const canKick = room.isHost && m.id !== room.you && m.role !== 'owner' && !(m.role === 'host' && meRole !== 'owner');
    let close = () => {};
    if (meRole === 'owner' && m.id !== room.you) {
      const on = m.role !== 'host';
      actions.push(h('button.btn', { onclick: () => { room.send({ type: 'set-host', user: m.id, on }); close(); } }, on ? 'Make host' : 'Remove host'));
    }
    if (canKick) {
      actions.push(h('button.btn.danger', {
        html: icon('kick', 16) + '<span>Remove from room</span>',
        onclick: async () => {
          close();
          if (await confirmDialog('Remove from room?', `${m.displayName} will be disconnected and can’t rejoin for 10 minutes. Their layers stay in the room.`, 'Remove')) {
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
    const text = this.chatInput.value.trim();
    if (!text || !this.room) return;
    this.room.send({ type: 'chat', text });
    this.chatInput.value = '';
    this.typingSent = 0;
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
    const msgs = room.chat.slice(-(this.chatOpen ? 50 : 6));
    // Join requests sit under the messages and only hosts get them.
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
    if (who) name.append(badges(who.role, who.premium));
    el.append(name, h('span.chat-text', {}, m.text));
    return el;
  }

  /** When chat is closed, messages fade out after a while (like a game chat). */
  private fadeChat() {
    clearTimeout(this.fadeTimer);
    const now = Date.now();
    for (const el of this.chatLog.children as HTMLCollectionOf<HTMLElement>) {
      const old = now - Number(el.dataset.at) > 15_000;
      el.classList.toggle('faded', !this.chatOpen && old);
    }
  }

  private renderTyping() {
    const room = this.room;
    if (!room) return;
    const names = [...room.typing.keys()].filter((id) => id !== room.you).map((id) => room.member(id)?.displayName).filter(Boolean) as string[];
    if (!names.length) { this.typingEl.textContent = ''; this.typingEl.hidden = true; return; }
    this.typingEl.hidden = false;
    const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} people`;
    this.typingEl.replaceChildren(h('span.dots', {}, h('i'), h('i'), h('i')), h('span', {}, `${who} ${names.length === 1 ? 'is' : 'are'} typing`));
  }

  private kickedShown: RoomClient | null = null;
  private kickedNotice() {
    if (this.kickedShown === this.room) return; // status can be reported more than once
    this.kickedShown = this.room;
    const body = h('div.modal-body', {}, h('p', {}, 'A host removed you from this room. You can keep your own copy by exporting before you leave.'));
    const ok = h('button.btn.primary', {}, 'Back to start');
    const save = h('button.btn', { html: icon('download', 16) + '<span>Export a copy</span>', onclick: () => exportDialog(this.ed) });
    const close = modal('You were removed', body, [save, ok], () => this.onLeave(), false);
    ok.addEventListener('click', () => close());
  }
}
