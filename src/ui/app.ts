import { DrawDoc } from '../core/document';
import { Editor, ToolId } from '../editor';
import { BrushTool } from '../tools/brushTool';
import { SmudgeTool } from '../tools/smudgeTool';
import { EyedropperTool } from '../tools/eyedropperTool';
import { FillTool } from '../tools/fillTool';
import { SelectTool } from '../tools/selectTool';
import { ShapeTool } from '../tools/shapeTool';
import { InputController } from '../view/input';
import { ColorPicker } from './colorPicker';
import { confirmDialog, exportDialog, modal, newCanvasDialog } from './dialogs';
import { clear, dismissOnOutside, h } from './dom';
import { icon } from './icons';
import { LayersPanel } from './layersPanel';
import { Slider } from './slider';
import { uid } from '../core/geom';
import { RoomUI } from './roomUI';
import { Session } from './session';
import { isNativeApp } from '../io/native';
import { frameBar } from './frame';
import { EFFECTS } from '../core/model';
import { EFFECT_INFO } from '../engine/effects';
import { avatarEl, badges, nameLine } from './people';
import { THEMES, canUseTheme, customTheme } from '../shared/themes';
import { api } from '../net/api';
import { accentColor, applyMode, applyTheme, theme } from './theme';
import { preferencesDialog } from './prefsDialog';
import { KeyAction, actionFor, keyOf, applyPressure } from '../shared/prefs';
import { Studio } from './panels';
import { PREFS_KEY } from './session';
import { Home } from './home';
import { InvitePanel } from './invitePanel';
import { shareDialog } from './share';
import { BrushTool as BrushToolId, FILL_MODES, SELECT_MODES, SHAPE_KINDS, brushLibrary, brushPreview, currentPreset, iconChoices, sizePreview } from './toolPicker';
import { effectsBar } from './effectsBar';

const PICKER_TOOLS: ToolId[] = ['brush', 'eraser', 'smudge', 'fill', 'select', 'shape'];
const isBrushTool = (id: ToolId): id is BrushToolId => id === 'brush' || id === 'eraser' || id === 'smudge';

const TOOLS: { id: ToolId; label: string }[] = [
  { id: 'brush', label: 'Brush' }, { id: 'eraser', label: 'Eraser' }, { id: 'smudge', label: 'Smudge' }, { id: 'fill', label: 'Fill' },
  { id: 'select', label: 'Selection' }, { id: 'shape', label: 'Shapes' }, { id: 'eyedropper', label: 'Eyedropper' },
];

export const SAVE_BADGE = {
  cloud: { icon: 'cloud', short: '', label: 'Saved to your account', hint: 'Saved on the server. It’s on every device you log in from.' },
  device: { icon: 'device', short: '', label: 'Saved on this device', hint: 'Saved in the app on this device.' },
  cache: { icon: 'warning', short: 'In Cache', label: 'In cache: not permanent', hint: 'This isn’t permanent storage: your browser may clear it. Download the Doodlehive app to keep your drawings safe.' },
};

export class App {
  ed: Editor;
  input: InputController;
  private select: SelectTool;
  private toolButtons = new Map<ToolId, HTMLElement>();
  private options = h('div.optionsbar');
  private sliders: Slider[] = []; // size and opacity, vertical for the classic sidebar and flat for the studio panel
  private sidebar: HTMLElement;
  private studio: Studio;
  private studioSliders: HTMLElement;
  private layers: LayersPanel;
  private layersPop: HTMLElement;
  private picker: ColorPicker;
  private colorPop: HTMLElement;
  private toolsSlot: HTMLElement;
  private topbar: HTMLElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private colorBtn: HTMLButtonElement;
  private zoomLabel = h('button.zoom-label', { title: 'Fit to screen' });
  private toastEl = h('div.toast', { role: 'status' });
  private toastTimer = 0;
  readonly roomUI: RoomUI;
  readonly session: Session;
  readonly home: Home;
  private menuDyn = h('div.menu-dyn');
  private menuDot = h('span.red-dot', { hidden: true });
  private unread = 0;
  private dock = h('div.room-dock', { hidden: true });
  private membersPop = h('div.popover.members-pop', { hidden: true });
  private invitePanel = new InvitePanel();
  private invitePop = h('div.popover.invite-pop', { hidden: true });
  private toolPop = h('div.popover.tool-pop', { hidden: true });
  private saveBadge = h('div.save-badge', { hidden: true });
  private sliderPreview = h('div.slider-preview', { hidden: true, 'aria-hidden': 'true' });
  private sliderPreviewTimer = 0;
  private toolPopFor: ToolId | null = null;
  private layersBtn: HTMLButtonElement;
  private prefsTimer = 0;

  constructor(root: HTMLElement, doc: DrawDoc) {
    const stage = h('main.stage-wrap');
    this.ed = new Editor(doc, stage);
    const ed = this.ed;
    this.select = new SelectTool(ed);
    ed.tools = {
      brush: new BrushTool(ed, false), eraser: new BrushTool(ed, true), smudge: new SmudgeTool(ed), fill: new FillTool(ed),
      select: this.select, shape: new ShapeTool(ed), eyedropper: new EyedropperTool(ed),
    };
    this.input = new InputController(ed, ed.view.canvas);
    ed.view.overlay = (ctx, M) => this.drawOverlay(ctx, M);
    this.roomUI = new RoomUI(ed);
    this.session = new Session(this);
    this.home = new Home(this);
    this.roomUI.onLeave = () => this.session.leaveRoom();
    this.membersPop.append(this.roomUI.membersPanel);
    dismissOnOutside(this.membersPop, [this.dock], () => { this.membersPop.hidden = true; });
    this.invitePop.append(this.invitePanel.el);
    dismissOnOutside(this.invitePop, [this.dock], () => { this.invitePop.hidden = true; });

    const btn = (name: string, title: string, fn: () => void, cls = '') =>
      h(`button.icon-btn${cls}` as 'button', { title, 'aria-label': title, html: icon(name), onclick: fn });

    const menuPop = this.menu();
    const menuBtn = btn('menu', 'Menu', () => { menuPop.hidden = !menuPop.hidden; if (!menuPop.hidden) this.renderMenuDyn(); });
    menuBtn.classList.add('has-dot');
    menuBtn.append(this.menuDot);
    dismissOnOutside(menuPop, [menuBtn], () => { menuPop.hidden = true; });

    const effectsPop = h('div.popover.effects-pop', { hidden: true }, h('div.panel', {}, ...EFFECTS.map((e) =>
      h('button.menu-item', { html: `<span>${EFFECT_INFO[e].name}</span>`, onclick: () => { effectsPop.hidden = true; effectsBar(ed, e); } }))));
    const effectsBtn = btn('sparkle', 'Effects', () => {
      effectsPop.style.left = `${effectsBtn.getBoundingClientRect().left}px`;
      effectsPop.hidden = !effectsPop.hidden;
    }, '.edit-only');
    dismissOnOutside(effectsPop, [effectsBtn], () => { effectsPop.hidden = true; });

    const left = h('div.bar-group', {},
      menuBtn,
      btn('download', 'Export (Ctrl+Shift+E)', () => this.export(), '.edit-only'),
      h('span.sep'),
      btn('flipH', 'Flip canvas horizontally (H)', () => ed.view.viewport.flip(true)),
      btn('flipV', 'Flip canvas vertically (V)', () => ed.view.viewport.flip(false)),
      btn('fit', 'Fit to screen (0)', () => ed.fitView()),
      effectsBtn,
      this.zoomLabel,
    );
    this.zoomLabel.addEventListener('click', () => ed.fitView());

    const right = h('div.bar-group');
    this.toolsSlot = h('span.sep.edit-only');
    for (const t of TOOLS) {
      const picker = PICKER_TOOLS.includes(t.id);
      const b = btn(t.id, t.label, () => {
        if (picker && ed.toolId === t.id) this.togglePicker(t.id, b);
        else { this.closePicker(); ed.setTool(t.id); }
      }, picker ? '.tool.has-picker' : '.tool');
      this.toolButtons.set(t.id, b);
      right.append(b);
    }
    right.append(this.toolsSlot);

    const layers = this.layers = new LayersPanel(ed);
    const layersPop = this.layersPop = h('div.popover.layers-pop', { hidden: true }, layers.el);
    const layersBtn = this.layersBtn = btn('layers', 'Layers', () => {
      if (this.studioOn) { this.studio.show('layers', !ed.prefs.panels.layers.show); return; }
      layersPop.hidden = !layersPop.hidden; layers.open = !layersPop.hidden; if (layers.open) layers.render();
    }, '.edit-only');
    dismissOnOutside(layersPop, [layersBtn], () => { layersPop.hidden = true; layers.open = false; });

    const picker = this.picker = new ColorPicker(ed);
    const colorPop = this.colorPop = h('div.popover.color-pop', { hidden: true }, h('div.panel', {}, picker.el));
    this.colorBtn = h('button.color-btn.edit-only', { title: 'Colour', 'aria-label': 'Colour' });
    this.colorBtn.addEventListener('click', () => {
      if (this.studioOn) { this.studio.show('color', !ed.prefs.panels.color.show); return; }
      colorPop.hidden = !colorPop.hidden; if (!colorPop.hidden) picker.opened();
    });
    dismissOnOutside(colorPop, [this.colorBtn], () => { colorPop.hidden = true; });
    right.append(layersBtn, this.colorBtn, h('span.sep'), this.saveBadge);
    this.saveBadge.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) return; this.saveBadge.classList.toggle('open'); });
    dismissOnOutside(this.saveBadge, [], () => this.saveBadge.classList.remove('open'));
    const topbar = this.topbar = h('header.topbar', {}, left, right);
    frameBar(topbar, right);

    const peek = { onStart: () => this.showSliderPreview(), onEnd: () => this.hideSliderPreview() };
    const sliders = (vertical: boolean) => [
      new Slider({
        min: 1, max: 500, value: ed.sizeParams.size, vertical, curve: 2.4, label: 'Size', ...peek,
        format: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + '', onInput: (v) => { ed.sizeParams.size = v; ed.emit('brush'); this.showSliderPreview(); },
      }),
      new Slider({
        min: 0.01, max: 1, value: ed.sizeParams.opacity, vertical, label: 'Opacity', ...peek,
        format: (v) => Math.round(v * 100) + '%', onInput: (v) => { ed.sizeParams.opacity = v; ed.emit('brush'); this.showSliderPreview(); },
      }),
    ];
    this.sliders = [...sliders(true), ...sliders(false)];
    this.studioSliders = h('div.sp-sliders', {}, this.sliders[2].el, this.sliders[3].el);
    this.undoBtn = btn('undo', 'Undo (Ctrl+Z, two-finger tap)', () => ed.undo());
    this.redoBtn = btn('redo', 'Redo (Ctrl+Shift+Z, three-finger tap)', () => ed.redo());
    const sidebar = this.sidebar = h('aside.sidebar', {}, this.sliders[0].el, this.sliders[1].el, this.undoBtn, this.redoBtn);
    this.studio = new Studio(ed, stage);

    root.append(topbar, this.options, stage, sidebar, this.studio.el, this.sliderPreview, this.roomUI.chatEl, this.dock, menuPop, effectsPop, this.invitePop, layersPop, colorPop, this.membersPop, this.toolPop, this.home.el, this.toastEl);
    dismissOnOutside(this.toolPop, [...this.toolButtons.values(), this.options], () => this.closePicker());

    ed.on((w) => this.onChange(w));
    ed.view.viewport.onChange = () => { ed.view.requestRender(); this.updateZoom(); };
    this.bindKeys();
    this.applyPrefs();
    this.onChange('tool');
    this.onChange('color');
    this.onChange('history');
    ed.fitView();
    this.refreshRoom();
  }

  /** Unread notifications: a red dot on the menu button and its bell. */
  setUnread(n: number) {
    this.unread = n;
    this.menuDot.hidden = !n;
    this.renderMenuDyn();
  }

  refreshAccount() {
    // The account's saved theme wins over the one remembered on this device.
    const me = this.ed.me;
    if (me) applyTheme(canUseTheme(me.theme, me.premium) ? me.theme : null);
    if (me && !me.guest) this.home.loadNotices();
    this.applyPrefs();
    this.renderMenuDyn();
    this.home.renderAccount();
  }

  /** Puts the preferences into effect: colour mode, shortcuts, hover outline. */
  applyPrefs() {
    const p = this.ed.prefs, st = this.ed.settings;
    applyMode(p.mode);
    applyPressure(p, st.brush);
    applyPressure(p, st.eraser);
    const key = (a: KeyAction) => { const k = keyOf(p, a); return k ? ` (${k.toUpperCase()})` : ''; };
    for (const t of TOOLS) {
      const b = this.toolButtons.get(t.id)!;
      b.title = t.label + key(t.id);
      b.setAttribute('aria-label', b.title);
    }
    this.layersBtn.title = 'Layers' + key('layers');
    this.layersBtn.setAttribute('aria-label', this.layersBtn.title);
    this.applyLayout();
    this.ed.view.requestRender();
  }

  get studioOn() { return this.ed.prefs.layout === 'studio'; }

  resetLayout() { this.studio.reset(); }

  /** Moves the tools, options, sliders, colour picker and layers between the classic bars and the studio panels. */
  applyLayout() {
    const studio = this.studioOn, ed = this.ed;
    document.body.classList.toggle('studio', studio);
    this.studio.el.hidden = !studio;
    this.closePicker();
    this.layersPop.hidden = this.colorPop.hidden = true;
    this.picker.setWheel(studio);
    const tools = [...this.toolButtons.values()];
    if (studio) {
      this.studio.frame('tools', ...tools, h('span.sp-gap'), this.undoBtn, this.redoBtn);
      this.studio.frame('brush', this.studioSliders, this.options);
      this.studio.frame('color', this.picker.pickerEl);
      this.studio.frame('swatches', this.picker.swatchesEl);
      this.studio.frame('layers', this.layers.el);
      this.studio.apply();
      this.picker.opened();
      this.layers.open = true;
      this.layers.render();
    } else {
      for (const b of tools) this.toolsSlot.before(b);
      this.topbar.after(this.options);
      this.sidebar.before(ed.view.canvas.parentElement!);
      this.sidebar.append(this.undoBtn, this.redoBtn);
      this.picker.el.append(this.picker.pickerEl, this.picker.swatchesEl);
      this.layersPop.append(this.layers.el);
      this.layers.open = false;
    }
    ed.view.resize();
  }

  /** Saved with the account, or on this device when drawing without one. */
  savePrefs() {
    clearTimeout(this.prefsTimer);
    this.prefsTimer = window.setTimeout(async () => {
      const prefs = this.ed.prefs;
      if (!this.ed.me) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ } return; }
      try { this.ed.me = await api.updateMe({ prefs }); } catch { this.toast('Couldn’t save your preferences'); }
    }, 400);
  }

  /** Honey is free; the other swatches and a colour of your own are premium. */
  themeRow(): HTMLElement {
    const me = this.ed.me, premium = !!me?.premium;
    const row = h('div.theme-row');
    const swatches: HTMLElement[] = [];
    const custom = h('input.theme-swatch.custom', { type: 'color', title: premium ? 'Custom (premium)' : 'Custom (premium only)', 'aria-label': 'Custom theme colour', 'data-id': 'custom' });
    const mark = () => {
      const cur = theme();
      for (const b of swatches) { const on = b.dataset.id === cur.id || (b === custom && cur.name === 'Custom'); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
      custom.value = cur.name === 'Custom' ? cur.accent : '#8a7cff';
      custom.style.setProperty('--sw', custom.value);
    };
    let timer = 0;
    const pick = (id: string) => {
      applyTheme(id);
      mark();
      this.ed.view.requestRender();
      if (!me) return;
      clearTimeout(timer);
      timer = window.setTimeout(async () => { try { this.ed.me = await api.updateMe({ theme: id }); } catch { this.toast('Couldn’t save your theme'); } }, 300);
    };
    for (const t of THEMES) {
      const allowed = canUseTheme(t.id, premium);
      const title = t.name + (t.premium ? (allowed ? ' (premium)' : ' (premium only)') : '');
      const b = h(`button.theme-swatch${allowed ? '' : '.locked'}` as 'button', {
        type: 'button', title, 'aria-label': title, style: `--sw:${t.accent}`, 'data-id': t.id,
        onclick: () => { if (allowed) pick(t.id); else this.toast(`${t.name} is a premium theme`); },
      });
      if (t.premium) b.append(badges(undefined, true));
      swatches.push(b);
      row.append(b);
    }
    if (premium) custom.addEventListener('input', () => pick(customTheme(custom.value)));
    else { custom.classList.add('locked'); custom.addEventListener('click', (e) => { e.preventDefault(); this.toast('Custom colours are a premium theme'); }); }
    swatches.push(custom);
    row.append(custom);
    mark();
    return row;
  }

  refreshRoom() {
    const room = this.ed.room, local = this.session.local, d = this.dock;
    document.body.classList.toggle('spectating', !!room?.spectator);
    this.renderMenuDyn();
    this.renderSaveBadge();
    clear(d);
    d.hidden = !room && !local;
    if (!room) {
      this.membersPop.hidden = this.invitePop.hidden = true;
      if (local) d.append(h('button.btn.share-btn', { html: icon('users', 16) + '<span>Share</span>', onclick: () => this.shareCanvas() }));
      return;
    }
    const ib = (name: string, title: string, fn: () => void) =>
      h('button.icon-btn', { title, 'aria-label': title, html: icon(name, 20), onclick: fn });
    if (room.status === 'connecting' || room.status === 'reconnecting') {
      d.append(h('span.room-status', {}, room.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'));
    }
    const own = room.info?.ownerId === room.you;
    if (room.info?.private && own) {
      d.append(
        h('button.btn.share-btn', { html: icon('users', 16) + '<span>Share</span>', onclick: () => this.shareCanvas() }),
        ib('link', 'Share links', () => this.shareLinks()),
      );
      return;
    }
    if (room.spectator) d.append(h('span.watch-tag', { html: icon('eye', 16) + '<span>Watching</span>' }));
    const stack = h('span.avatar-stack');
    for (const m of room.members.slice(0, 4)) stack.append(avatarEl(m, 24));
    const membersBtn = h('button.members-btn', {
      title: 'People in this room', 'aria-label': 'People in this room',
      onclick: () => { this.membersPop.hidden = !this.membersPop.hidden; if (!this.membersPop.hidden) this.roomUI.renderMembers(); },
    }, stack, h('span', {}, String(room.members.length)));
    d.append(
      membersBtn,
      ib('chat', 'Chat (Enter)', () => this.roomUI.toggleChat()),
      ib('link', 'Share links', () => this.shareLinks()),
    );
    if (room.isHost && !this.ed.me?.guest) {
      d.append(ib('userPlus', 'Invite friends', () => {
        this.invitePop.hidden = !this.invitePop.hidden;
        if (!this.invitePop.hidden) this.invitePanel.render(room);
      }));
    }
  }

  /** Where the open drawing lives: a cloud for the server, a warning for browser storage. */
  private renderSaveBadge() {
    const room = this.ed.room, me = this.ed.me, b = this.saveBadge;
    const kind = !me || me.guest || room?.spectator ? null : room && !room.info?.ephemeral ? 'cloud' : room || this.session.local ? (isNativeApp ? 'device' : 'cache') : null;
    b.hidden = !kind;
    b.className = 'save-badge' + (kind ? ' ' + kind : '');
    clear(b);
    if (!kind) return;
    const text = SAVE_BADGE[kind];
    b.append(
      h('button.save-pill', { type: 'button', 'aria-label': text.label, html: icon(text.icon, 16) + (text.short ? `<span>${text.short}</span>` : '') }),
      h('div.hint', { role: 'tooltip' }, text.hint, kind === 'cache' ? h('a', { href: '/' }, 'Get the app') : null),
    );
  }

  async copyText(text: string, done: string) {
    try { await navigator.clipboard.writeText(text); this.toast(done); }
    catch { this.toast(text); }
  }

  async copyInvite() { await this.session.flushThumb(); return this.copyText(this.session.inviteLink(), 'Invite link copied'); }

  private export() { if (!this.ed.readOnly) exportDialog(this.ed); }

  shareLinks() {
    const room = this.ed.room;
    if (!room?.info) return;
    const row = (label: string, value: string, note: string) => {
      const input = h('input', { type: 'text', readonly: true, value, 'aria-label': label });
      input.addEventListener('focus', () => input.select());
      return h('div.link-row', {},
        h('span.link-label', {}, label, h('small', {}, note)),
        h('div.row', {}, input, h('button.icon-btn', { title: 'Copy', 'aria-label': `Copy ${label.toLowerCase()}`, html: icon('copy', 18), onclick: () => this.copyText(value, `${label} copied`) })),
      );
    };
    const rows: HTMLElement[] = [];
    if (!room.spectator) {
      if (!room.info.private) rows.push(row('Draw link', this.session.inviteLink(), 'Join and draw'));
      rows.push(row('Room code', room.id, 'Paste it on the home screen'));
    }
    const watch = this.session.watchLink();
    if (watch) rows.push(row('Watch link', watch, 'Watch and chat only'));
    modal('Share links', h('div.modal-body.share-links', {}, ...rows), []);
  }

  async shareCanvas() {
    const room = this.ed.room, local = this.session.local;
    if (!room && local) {
      const share = await shareDialog(local.meta.share, false);
      if (share) await this.session.shareLocal(share).catch((e) => this.toast((e as Error).message));
      return;
    }
    if (!room?.info) return;
    const wasPrivate = room.info.private;
    const share = await shareDialog(room.info.share, !wasPrivate);
    if (!share) return;
    try {
      await api.updateRoom(room.id, { share });
      if (wasPrivate) await this.copyInvite();
    } catch (e) { this.toast((e as Error).message); }
  }

  private async makePrivate() {
    const room = this.ed.room;
    if (!room?.info) return;
    const live = room.info.ephemeral;
    if (room.members.length > 1 && !(await confirmDialog(live ? 'Stop sharing?' : 'Make this canvas private?', 'Everyone else will be disconnected.', live ? 'Stop sharing' : 'Make private'))) return;
    if (live) { this.session.unshare(); return; }
    try { await api.updateRoom(room.id, { share: { ...room.info.share, visibility: 'private' } }); } catch (e) { this.toast((e as Error).message); }
  }

  private onChange(w: string) {
    const ed = this.ed;
    if (w === 'tool') {
      for (const [id, b] of this.toolButtons) b.classList.toggle('active', id === ed.toolId);
      this.updateToolIcons();
      if (this.toolPopFor && this.toolPopFor !== ed.toolId) this.closePicker();
      this.renderOptions();
      this.syncSliders();
      this.sliders[1].el.hidden = this.sliders[3].el.hidden = ed.toolId === 'smudge';
    } else if (w === 'color') {
      this.colorBtn.style.background = ed.color;
    } else if (w === 'history') {
      this.undoBtn.disabled = !ed.doc.history.canUndo;
      this.redoBtn.disabled = !ed.doc.history.canRedo;
      this.session.scheduleThumb();
    } else if (w === 'selection') {
      if (ed.toolId === 'select') this.renderOptions();
    } else if (w === 'doc') {
      this.renderOptions();
    } else if (w === 'brush') {
      this.syncSliders();
    } else if (w === 'prefs') {
      this.savePrefs();
    } else if (w.startsWith('toast:')) {
      this.toast(w.slice(6));
    }
  }

  /** What the brush will look like at the size and opacity being dragged to. */
  private showSliderPreview() {
    const ed = this.ed, p = ed.sizeParams, el = this.sliderPreview;
    if (!isBrushTool(ed.toolId)) return;
    clearTimeout(this.sliderPreviewTimer);
    const name = ed.preset(currentPreset(ed, ed.toolId)).name;
    const info = `${Math.round(p.size)} px${ed.toolId === 'smudge' ? '' : ` · ${Math.round(p.opacity * 100)}%`}${p.size > 120 ? ' · shown smaller' : ''}`;
    el.replaceChildren(sizePreview(p, ed.toolId === 'brush' ? ed.color : '#8a8a96'), h('span.slider-preview-text', {}, h('strong', {}, name), info));
    el.hidden = false;
  }

  private hideSliderPreview() {
    clearTimeout(this.sliderPreviewTimer);
    this.sliderPreviewTimer = window.setTimeout(() => { this.sliderPreview.hidden = true; }, 500);
  }

  private updateToolIcons() {
    const st = this.ed.settings;
    const sel = SELECT_MODES.find((m) => m[0] === st.selectMode)!;
    const shp = SHAPE_KINDS.find((m) => m[0] === st.shape)!;
    const fil = FILL_MODES.find((m) => m[0] === st.fillMode)!;
    this.toolButtons.get('select')!.innerHTML = icon(sel[2]);
    this.toolButtons.get('shape')!.innerHTML = icon(shp[2]);
    this.toolButtons.get('fill')!.innerHTML = icon(fil[2]);
  }

  private closePicker() {
    this.toolPop.hidden = true;
    this.toolPopFor = null;
    for (const b of this.toolButtons.values()) b.classList.remove('open');
  }

  togglePicker(id: ToolId, anchor: HTMLElement) {
    if (this.toolPopFor === id && !this.toolPop.hidden) { this.closePicker(); return; }
    const ed = this.ed, st = ed.settings;
    const done = () => { this.closePicker(); this.updateToolIcons(); this.renderOptions(); this.syncSliders(); };
    let content: HTMLElement;
    if (isBrushTool(id)) content = brushLibrary(this, id, done);
    else if (id === 'select') content = iconChoices(SELECT_MODES, st.selectMode, (v) => { st.selectMode = v; ed.setTool('select'); done(); });
    else if (id === 'fill') content = iconChoices(FILL_MODES, st.fillMode, (v) => { st.fillMode = v; ed.setTool('fill'); done(); });
    else content = iconChoices(SHAPE_KINDS, st.shape, (v) => { st.shape = v; ed.setTool('shape'); done(); });
    this.toolPop.replaceChildren(content);
    this.toolPop.hidden = false;
    this.toolPopFor = id;
    for (const [tid, b] of this.toolButtons) b.classList.toggle('open', tid === id && b === anchor);
    const r = anchor.getBoundingClientRect();
    const w = this.toolPop.offsetWidth, hh = this.toolPop.offsetHeight;
    if (this.studioOn && anchor.closest('.sp')) {
      // Beside the vertical toolbar instead of under it.
      this.toolPop.style.top = `${Math.round(Math.max(8, Math.min(window.innerHeight - hh - 8, r.top)))}px`;
      this.toolPop.style.left = `${Math.round(Math.min(window.innerWidth - w - 8, r.right + 6))}px`;
      return;
    }
    this.toolPop.style.top = `${Math.round(r.bottom + 6)}px`;
    this.toolPop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`;
  }

  private modeButton([, label, ic]: [string, string, string]) {
    const b: HTMLButtonElement = h('button.preset-btn', {
      title: 'Change mode', 'aria-label': `Mode: ${label}. Change mode`,
      html: icon(ic, 18) + `<span>${label}</span><span class="caret">${icon('chevronDown', 14)}</span>`,
      onclick: () => this.togglePicker(this.ed.toolId, b),
    });
    return b;
  }

  private syncSliders() {
    const p = this.ed.sizeParams;
    this.sliders.forEach((s, i) => s.set(i % 2 ? p.opacity : p.size));
  }

  private updateZoom() {
    const vp = this.ed.view.viewport;
    const deg = Math.round((((vp.rot * 180) / Math.PI) % 360 + 360) % 360);
    this.zoomLabel.textContent = `${Math.round(vp.zoom * 100)}%${deg ? ` · ${deg}°` : ''}${vp.flipX < 0 || vp.flipY < 0 ? ' · flipped' : ''}`;
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  private renderOptions() {
    const ed = this.ed, st = ed.settings, o = this.options;
    clear(o);
    const label = (t: string) => h('span.opt-label', {}, t);
    const seg = <T extends string>(items: [T, string, string?][], value: T, set: (v: T) => void) => {
      const s = h('div.segmented');
      for (const [v, text, ic] of items) {
        s.append(h(`button${v === value ? '.active' : ''}` as 'button', { title: text, onclick: () => { set(v); this.renderOptions(); }, html: ic ? icon(ic, 18) + `<span>${text}</span>` : text }));
      }
      return s;
    };
    const range = (name: string, value: number, min: number, max: number, set: (v: number) => void, fmt = (v: number) => Math.round(v * 100) + '%') => {
      const s = new Slider({ min, max, value, label: name, format: fmt, onInput: set });
      s.el.classList.add('compact');
      return s.el;
    };
    const toggle = (name: string, value: boolean, set: (v: boolean) => void) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = value;
      cb.addEventListener('change', () => set(cb.checked));
      return h('label.check', {}, cb, name);
    };

    o.append(h('span.opt-title', {}, TOOLS.find((t) => t.id === ed.toolId)!.label));
    if (isBrushTool(ed.toolId)) {
      const tool = ed.toolId, smudge = tool === 'smudge';
      const params = tool === 'eraser' ? st.eraser : smudge ? st.smudge : st.brush;
      const name = ed.preset(currentPreset(ed, tool)).name;
      const pick: HTMLButtonElement = h('button.preset-btn', {
        title: 'Choose a brush', 'aria-label': `Brush: ${name}. Choose a brush`, html: '',
        onclick: () => this.togglePicker(tool, pick),
      });
      pick.append(brushPreview(params, 64, 24), h('span', {}, name), h('span.caret', { html: icon('chevronDown', 14) }));
      o.append(pick);
      // The simple layout keeps the bar short; the studio brush panel has room for everything.
      if (this.studioOn) o.append(
        range(smudge ? 'Strength' : 'Flow', params.flow, 0.02, 1, (v) => { params.flow = v; }),
        range('Hardness', params.hardness, 0, 1, (v) => { params.hardness = v; }),
        range('Grain', params.grain ?? 0, 0, 1, (v) => { params.grain = v; }),
        range('Smoothing', params.smoothing, 0, 1, (v) => { params.smoothing = v; }),
      );
      const pf = ed.prefs, pref = () => ed.emit('prefs');
      if (!smudge) {
        o.append(toggle('Stabilizer', pf.stabilizerOn, (v) => { pf.stabilizerOn = v; pref(); this.renderOptions(); }));
        if (pf.stabilizerOn) o.append(range('', pf.stabilizer, 0, 1, (v) => { pf.stabilizer = v; pref(); }));
      }
      o.append(label('Pressure:'));
      if (smudge) o.append(
        toggle('Size', params.pressureSize > 0, (v) => { params.pressureSize = v ? 0.5 : 0; }),
        toggle('Strength', params.pressureFlow > 0, (v) => { params.pressureFlow = v ? 0.5 : 0; }),
      );
      else o.append(
        toggle('Size', params.pressureSize > 0, (v) => { pf.pressureSize = v; applyPressure(pf, st.brush); applyPressure(pf, st.eraser); pref(); }),
        toggle('Opacity', params.pressureFlow > 0, (v) => { pf.pressureOpacity = v; applyPressure(pf, st.brush); applyPressure(pf, st.eraser); pref(); }),
      );
    } else if (ed.toolId === 'fill' || (ed.toolId === 'select' && st.selectMode === 'wand')) {
      o.append(this.modeButton((ed.toolId === 'fill' ? FILL_MODES.find((m) => m[0] === st.fillMode) : SELECT_MODES.find((m) => m[0] === st.selectMode))!));
      if (ed.toolId === 'fill' && st.fillMode === 'lasso') o.append(toggle('Fill inside lines', st.lassoInside, (v) => { st.lassoInside = v; }));
      o.append(range('Tolerance', st.fillTolerance, 0, 1, (v) => { st.fillTolerance = v; }));
      if (ed.toolId !== 'select') o.append(range('Expand', st.fillExpand, 0, 4, (v) => { st.fillExpand = Math.round(v); }, (v) => Math.round(v) + 'px'));
      o.append(
        label('Reference:'),
        seg([['all', 'All layers'], ['layer', 'This layer']] as const, st.fillSampleAll ? 'all' : 'layer', (v) => { st.fillSampleAll = v === 'all'; }),
      );
      if (ed.toolId === 'select' && ed.selection) o.append(h('button.btn', { onclick: () => this.select.deselect() }, 'Deselect'));
    } else if (ed.toolId === 'select') {
      o.append(this.modeButton(SELECT_MODES.find((m) => m[0] === st.selectMode)!));
      o.append(h('button.btn', { onclick: () => this.select.selectAll() }, 'Select all'));
      if (ed.selection) {
        o.append(
          h('button.btn', { onclick: () => this.select.deselect() }, 'Deselect'),
          h('button.icon-btn', { title: 'Flip selection horizontally', html: icon('flipH', 18), onclick: () => this.select.flip(true) }),
          h('button.icon-btn', { title: 'Flip selection vertically', html: icon('flipV', 18), onclick: () => this.select.flip(false) }),
        );
      }
      if (this.select.xf) {
        o.append(
          h('button.btn.primary', { html: icon('check', 16) + '<span>Apply</span>', onclick: () => { this.select.commit(); } }),
          h('button.btn', { onclick: () => { this.select.cancel(); } }, 'Cancel'),
        );
      } else {
        o.append(h('span.hint', {}, ed.selection ? 'Drag to move, corners scale, dot rotates' : 'Drag to select'));
      }
    } else if (ed.toolId === 'shape') {
      o.append(
        this.modeButton(SHAPE_KINDS.find((m) => m[0] === st.shape)!),
        toggle('Filled', st.shapeFill, (v) => { st.shapeFill = v; }),
        h('span.hint', {}, 'Shift constrains, Alt from centre'),
      );
    } else if (ed.toolId === 'eyedropper') {
      o.append(h('span.hint', {}, 'Tap to pick. Alt + brush also works'));
    }
  }

  private menu(): HTMLElement {
    return h('div.popover.menu-pop', { hidden: true }, h('div.panel', {}, this.menuDyn));
  }

  private renderMenuDyn() {
    const ed = this.ed, s = this.session, d = this.menuDyn, st = ed.settings;
    const close = () => { (d.closest('.popover') as HTMLElement).hidden = true; };
    const item = (ic: string, text: string, fn: () => void, cls = '') =>
      h(`button.menu-item${cls}` as 'button', { html: icon(ic, 18) + `<span>${text}</span>`, onclick: () => { close(); fn(); } });
    clear(d);
    const me = ed.me;
    if (me) {
      d.append(h('div.account', {}, avatarEl(me, 36), h('div.account-text', {}, nameLine(me, undefined), h('small.muted', {}, '@' + me.handle)),
          me.guest ? null : h('button.icon-btn.menu-bell', { title: 'Notifications', 'aria-label': 'Notifications', html: icon('bell', 18), onclick: () => { close(); this.home.showNotices(); } },
            h('span.red-dot', { hidden: !this.unread }))),
        h('div.row.account-actions', {},
          h('button.btn', { html: icon('user', 16) + '<span>Edit profile</span>', onclick: () => { close(); s.editProfile(); } }),
          h('button.btn', { html: icon('logout', 16) + '<span>Log out</span>', onclick: () => { close(); s.logout(); } })),
        h('div.menu-sep'));
    } else if (s.server) {
      d.append(item('user', 'Log in to draw together…', () => { location.href = '/login?next=/app'; }), h('div.menu-sep'));
    }
    if (ed.room || s.local) {
      const info = ed.room?.info, own = info?.ownerId === ed.room?.you;
      d.append(h('div.menu-label', {}, info?.name ?? s.local?.meta.name ?? 'Canvas'));
      if (!ed.room) d.append(item('users', 'Share…', () => this.shareCanvas()));
      else if (info?.private) {
        if (own) d.append(item('users', 'Share with friends…', () => this.shareCanvas()));
      } else if (own) {
        d.append(item('users', 'Sharing…', () => this.shareCanvas()), item('lock', info?.ephemeral ? 'Stop sharing' : 'Make private', () => this.makePrivate()));
      }
      if (ed.room) d.append(item('link', 'Share links…', () => this.shareLinks()));
      d.append(item('home', 'Back to home', () => s.leaveRoom()));
    } else if (me) {
      d.append(item('home', 'Home', () => s.showHome()));
      if (!this.ed.me?.guest) d.append(item('plus', 'Create new…', () => s.createNew()));
    } else {
      d.append(item('file', 'New canvas…', () => this.newCanvas()));
    }
    if (!ed.readOnly) d.append(item('download', 'Export PNG / PSD / .hivecanvas…', () => this.export()));
    d.append(item('settings', 'Preferences…', () => preferencesDialog(this)), h('div.menu-sep'));
    if (ed.room && !ed.readOnly) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = st.hideOthersFolders;
      cb.addEventListener('change', () => { st.hideOthersFolders = cb.checked; ed.emit('settings'); });
      d.append(h('label.check.menu-check', {}, cb, 'Only my folder in Layers'), h('div.menu-sep'));
    }
  }

  async newCanvas() {
    const empty = this.ed.doc.log.length <= 1;
    if (!empty && !(await confirmDialog('Start a new canvas?', 'The current drawing is discarded.', 'Discard'))) return;
    newCanvasDialog((doc) => this.ed.setDoc(doc));
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, M: DOMMatrix) {
    const ed = this.ed;
    this.select.overlay(ctx, M);
    if (ed.currentTool !== this.select) ed.currentTool.overlay?.(ctx, M);
    this.roomUI.drawBubbles(ctx, M);
    const tool = ed.currentTool, t = tool instanceof BrushTool ? tool.tether : null;
    const hv = t ? { x: t.bx, y: t.by } : ed.hover;
    if (hv && (t || ed.prefs.hoverPreview) && !ed.readOnly && (ed.toolId === 'brush' || ed.toolId === 'eraser' || ed.toolId === 'smudge') && !this.input.altPick && !this.input.viewKey) {
      const p = M.transformPoint(hv);
      const r = Math.max(1, (ed.sizeParams.size * ed.view.viewport.zoom) / 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, r - 0.5), 0, Math.PI * 2); ctx.stroke();
      if (t) {
        // The rope from the brush to the cursor.
        const c = M.transformPoint({ x: t.cx, y: t.cy });
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        ctx.strokeStyle = accentColor();
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = accentColor();
        ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  private bindKeys() {
    const ed = this.ed;
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea')) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (ed.readOnly && (k === 'l' || (mod && (k === 'a' || k === 'e')))) return;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); ed.redo(); return; }
      if (mod && k === 'a') { e.preventDefault(); ed.setTool('select'); this.select.selectAll(); return; }
      if (mod && k === 'd') { e.preventDefault(); this.select.deselect(); return; }
      if (mod && e.shiftKey && k === 'e') { e.preventDefault(); this.export(); return; }
      if (mod) return;
      if (e.key === ' ') { this.input.spaceHeld = true; ed.view.canvas.style.cursor = 'grab'; e.preventDefault(); return; }
      if (e.key === 'Alt') { this.input.altPick = true; e.preventDefault(); ed.view.requestRender(); return; }
      const hold = actionFor(ed.prefs, k);
      if (hold === 'rotate' || hold === 'zoomDrag') {
        this.input.viewKey = hold === 'rotate' ? 'rotate' : 'zoom';
        ed.view.canvas.style.cursor = hold === 'rotate' ? 'grab' : 'zoom-in';
        return;
      }
      if (e.key === 'Enter') {
        if (this.select.xf || !ed.room) this.select.commit();
        else { e.preventDefault(); this.roomUI.toggleChat(true); }
        return;
      }
      if (e.key === 'Escape') {
        if (!this.toolPop.hidden) this.closePicker();
        else if (this.roomUI.chatOpen) this.roomUI.toggleChat(false);
        else if (this.select.xf) this.select.cancel(); else this.select.deselect();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelection(); return; }
      const action = actionFor(ed.prefs, k);
      if (!action) return;
      if (TOOLS.some((t) => t.id === action)) { ed.setTool(action as ToolId); return; }
      if (action === 'sizeUp' || action === 'sizeDown') {
        const p = ed.sizeParams;
        p.size = Math.max(1, Math.min(500, p.size * (action === 'sizeUp' ? 1.15 : 1 / 1.15)));
        this.syncSliders(); ed.view.requestRender(); return;
      }
      if (action === 'flipH') ed.view.viewport.flip(true);
      else if (action === 'flipV') ed.view.viewport.flip(false);
      else if (action === 'fit') ed.fitView();
      else if (action === 'zoomIn') this.zoomCenter(1.25);
      else if (action === 'zoomOut') this.zoomCenter(0.8);
      else if (action === 'layers') this.layersBtn.click();
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') { this.input.spaceHeld = false; ed.view.canvas.style.cursor = ''; }
      const action = actionFor(ed.prefs, e.key.toLowerCase());
      if ((action === 'rotate' && this.input.viewKey === 'rotate') || (action === 'zoomDrag' && this.input.viewKey === 'zoom')) {
        this.input.viewKey = null; ed.view.canvas.style.cursor = '';
      }
      if (e.key === 'Alt') { this.input.altPick = false; ed.view.requestRender(); }
    });
    window.addEventListener('blur', () => { this.input.spaceHeld = false; this.input.altPick = false; this.input.viewKey = null; ed.view.canvas.style.cursor = ''; });
  }

  private zoomCenter(f: number) {
    const vp = this.ed.view.viewport;
    vp.zoomAt(vp.w / 2, vp.h / 2, f);
  }

  private deleteSelection() {
    const ed = this.ed;
    if (!ed.selection) return;
    this.select.commit();
    const sel = ed.selection!;
    // An erasing shape op, so it syncs and undoes like any edit.
    const xs = sel.pts.filter((_, i) => i % 2 === 0), ys = sel.pts.filter((_, i) => i % 2 === 1);
    const x0 = Math.min(...xs) - 2, y0 = Math.min(...ys) - 2, x1 = Math.max(...xs) + 2, y1 = Math.max(...ys) + 2;
    ed.apply({
      t: 'shape', id: uid(), layer: ed.activeLayer, shape: 'rect', x0, y0, x1, y1,
      width: 0, fill: true, color: '#000000', opacity: 1, erase: true, clip: sel, mask: ed.onMask,
    });
  }
}
