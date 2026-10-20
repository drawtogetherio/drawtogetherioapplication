import { DrawDoc } from '../core/document';
import { Editor, ToolId } from '../editor';
import { BRUSH_PRESETS, ERASER_PRESETS } from '../engine/brush';
import { BrushTool } from '../tools/brushTool';
import { EyedropperTool } from '../tools/eyedropperTool';
import { FillTool } from '../tools/fillTool';
import { SelectTool } from '../tools/selectTool';
import { ShapeTool } from '../tools/shapeTool';
import { InputController } from '../view/input';
import { ColorPicker } from './colorPicker';
import { confirmDialog, exportDialog, newCanvasDialog } from './dialogs';
import { clear, dismissOnOutside, h } from './dom';
import { icon } from './icons';
import { LayersPanel } from './layersPanel';
import { Slider } from './slider';
import { uid } from '../core/geom';
import { RoomUI } from './roomUI';
import { Session } from './session';
import { avatarEl, badges, nameLine } from './people';
import { THEMES, canUseTheme } from '../shared/themes';
import { api } from '../net/api';
import { applyTheme, theme } from './theme';
import { Home } from './home';
import { LOGO_SVG } from '../site/brand';
import { SELECT_MODES, SHAPE_KINDS, brushLibrary, brushPreview, iconChoices } from './toolPicker';

/** Tools whose button opens a drop-down when tapped while already selected. */
const PICKER_TOOLS: ToolId[] = ['brush', 'eraser', 'select', 'shape'];

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'brush', label: 'Brush', key: 'B' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', label: 'Fill', key: 'G' },
  { id: 'select', label: 'Selection', key: 'M' },
  { id: 'shape', label: 'Shapes', key: 'U' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I' },
];

export class App {
  ed: Editor;
  input: InputController;
  private select: SelectTool;
  private toolButtons = new Map<ToolId, HTMLElement>();
  private options = h('div.optionsbar');
  private sizeSlider: Slider;
  private opacitySlider: Slider;
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
  private dock = h('div.room-dock', { hidden: true });
  private membersPop = h('div.popover.members-pop', { hidden: true });
  /** Drop-down under a tool button: brush library, selection modes, shape kinds. */
  private toolPop = h('div.popover.tool-pop', { hidden: true });
  private toolPopFor: ToolId | null = null;

  constructor(root: HTMLElement, doc: DrawDoc) {
    const stage = h('main.stage-wrap');
    this.ed = new Editor(doc, stage);
    const ed = this.ed;
    this.select = new SelectTool(ed);
    ed.tools = {
      brush: new BrushTool(ed, false), eraser: new BrushTool(ed, true), fill: new FillTool(ed),
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

    // ---- Top bar ----
    const btn = (name: string, title: string, fn: () => void, cls = '') =>
      h(`button.icon-btn${cls}` as 'button', { title, 'aria-label': title, html: icon(name), onclick: fn });

    const menuPop = this.menu();
    const menuBtn = btn('menu', 'Menu', () => { menuPop.hidden = !menuPop.hidden; if (!menuPop.hidden) this.renderMenuDyn(); });
    dismissOnOutside(menuPop, [menuBtn], () => { menuPop.hidden = true; });

    const left = h('div.bar-group', {},
      h('button.brand', {
        title: 'Home', 'aria-label': 'Doodlehive home', html: LOGO_SVG + '<span class="brand-word">doodle<span>hive</span></span>',
        onclick: () => { if (!this.session.offline) this.session.leaveRoom(); },
      }),
      menuBtn,
      btn('download', 'Export (Ctrl+Shift+E)', () => exportDialog(ed)),
      h('span.sep'),
      btn('flipH', 'Flip canvas horizontally (H)', () => ed.view.viewport.flip(true)),
      btn('flipV', 'Flip canvas vertically (V)', () => ed.view.viewport.flip(false)),
      btn('fit', 'Fit to screen (0)', () => ed.fitView()),
      this.zoomLabel,
    );
    this.zoomLabel.addEventListener('click', () => ed.fitView());

    const right = h('div.bar-group');
    for (const t of TOOLS) {
      const picker = PICKER_TOOLS.includes(t.id);
      const title = `${t.label} (${t.key})${picker ? ', tap again for options' : ''}`;
      const b = btn(t.id, title, () => {
        if (picker && ed.toolId === t.id) this.togglePicker(t.id, b);
        else { this.closePicker(); ed.setTool(t.id); }
      }, picker ? '.tool.has-picker' : '.tool');
      this.toolButtons.set(t.id, b);
      right.append(b);
    }
    right.append(h('span.sep'));

    const layers = new LayersPanel(ed);
    const layersPop = h('div.popover.layers-pop', { hidden: true }, layers.el);
    const layersBtn = btn('layers', 'Layers (L)', () => {
      layersPop.hidden = !layersPop.hidden; layers.open = !layersPop.hidden; if (layers.open) layers.render();
    });
    dismissOnOutside(layersPop, [layersBtn], () => { layersPop.hidden = true; layers.open = false; });

    const picker = new ColorPicker(ed);
    const colorPop = h('div.popover.color-pop', { hidden: true }, h('div.panel', {}, picker.el));
    this.colorBtn = h('button.color-btn', { title: 'Colour', 'aria-label': 'Colour' });
    this.colorBtn.addEventListener('click', () => { colorPop.hidden = !colorPop.hidden; if (!colorPop.hidden) picker.opened(); });
    dismissOnOutside(colorPop, [this.colorBtn], () => { colorPop.hidden = true; });
    right.append(layersBtn, this.colorBtn);

    const topbar = h('header.topbar', {}, left, right);

    // ---- Left sidebar (Procreate style) ----
    this.sizeSlider = new Slider({
      min: 1, max: 500, value: ed.sizeParams.size, vertical: true, curve: 2.4, label: 'Size',
      format: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + '', onInput: (v) => { ed.sizeParams.size = v; ed.emit('brush'); },
    });
    this.opacitySlider = new Slider({
      min: 0.01, max: 1, value: ed.sizeParams.opacity, vertical: true, label: 'Opacity',
      format: (v) => Math.round(v * 100) + '%', onInput: (v) => { ed.sizeParams.opacity = v; ed.emit('brush'); },
    });
    this.undoBtn = btn('undo', 'Undo (Ctrl+Z, two-finger tap)', () => ed.undo());
    this.redoBtn = btn('redo', 'Redo (Ctrl+Shift+Z, three-finger tap)', () => ed.redo());
    const sidebar = h('aside.sidebar', {}, this.sizeSlider.el, this.opacitySlider.el, this.undoBtn, this.redoBtn);

    root.append(topbar, this.options, stage, sidebar, this.roomUI.chatEl, this.dock, menuPop, layersPop, colorPop, this.membersPop, this.toolPop, this.home.el, this.toastEl);
    dismissOnOutside(this.toolPop, [...this.toolButtons.values(), this.options], () => this.closePicker());

    ed.on((w) => this.onChange(w));
    ed.view.viewport.onChange = () => { ed.view.requestRender(); this.updateZoom(); };
    this.bindKeys();
    this.onChange('tool');
    this.onChange('color');
    this.onChange('history');
    ed.fitView();
    this.refreshRoom();
  }

  /** Account section of the menu changes after login / logout. */
  refreshAccount() {
    // The account's saved theme wins over the one remembered on this device.
    const me = this.ed.me;
    if (me) applyTheme(canUseTheme(me.theme, me.premium) ? me.theme : null);
    this.renderMenuDyn();
    this.home.renderAccount();
  }

  /** Swatches for the app colour theme. Premium themes are locked without premium. */
  private themeRow(): HTMLElement {
    const me = this.ed.me;
    const row = h('div.theme-row', {}, h('div.menu-label', {}, 'Theme'));
    for (const t of THEMES) {
      const allowed = canUseTheme(t.id, !!me?.premium);
      const title = t.name + (t.premium ? (allowed ? ' (premium)' : ' (premium only)') : '');
      const b = h(`button.theme-swatch${t.id === theme().id ? '.active' : ''}${allowed ? '' : '.locked'}` as 'button', {
        title, 'aria-label': title, style: `--sw:${t.accent}`, 'aria-pressed': String(t.id === theme().id),
        onclick: async () => {
          if (!allowed) { this.toast(`${t.name} is a premium theme`); return; }
          applyTheme(t.id);
          this.renderMenuDyn();
          this.ed.view.requestRender();
          if (me) {
            try { this.ed.me = await api.updateMe({ theme: t.id }); } catch { this.toast('Couldn’t save your theme'); }
          }
        },
      });
      if (t.premium) b.append(badges(undefined, true));
      row.append(b);
    }
    return row;
  }

  /** Room dock (bottom right): connection state, members, chat, invite link. */
  refreshRoom() {
    const room = this.ed.room, d = this.dock;
    this.renderMenuDyn();
    clear(d);
    d.hidden = !room;
    if (!room) { this.membersPop.hidden = true; return; }
    const ib = (name: string, title: string, fn: () => void) =>
      h('button.icon-btn', { title, 'aria-label': title, html: icon(name, 20), onclick: fn });
    if (room.status === 'connecting' || room.status === 'reconnecting') {
      d.append(h('span.room-status', {}, room.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'));
    }
    const own = room.info?.ownerId === room.you;
    if (room.info?.private) {
      // A canvas just for you: no member list or chat, just a way to share it.
      if (own) d.append(h('button.btn.share-btn', { html: icon('users', 16) + '<span>Share</span>', onclick: () => this.shareCanvas() }));
      return;
    }
    const stack = h('span.avatar-stack');
    for (const m of room.members.slice(0, 4)) stack.append(avatarEl(m, 24));
    const membersBtn = h('button.members-btn', {
      title: 'People in this room', 'aria-label': 'People in this room',
      onclick: () => { this.membersPop.hidden = !this.membersPop.hidden; if (!this.membersPop.hidden) this.roomUI.renderMembers(); },
    }, stack, h('span', {}, String(room.members.length)));
    d.append(
      membersBtn,
      ib('chat', 'Chat (Enter)', () => this.roomUI.toggleChat()),
      ib('link', 'Copy invite link', () => this.copyInvite()),
    );
  }

  async copyText(text: string, done: string) {
    try { await navigator.clipboard.writeText(text); this.toast(done); }
    catch { this.toast(text); }
  }

  copyInvite() { return this.copyText(this.session.inviteLink(), 'Invite link copied'); }

  /** Turn a private canvas into a shared room and copy its invite link. */
  async shareCanvas() {
    const room = this.ed.room;
    if (!room) return;
    try {
      await api.updateRoom(room.id, { private: false });
      await this.copyInvite();
    } catch (e) { this.toast((e as Error).message); }
  }

  private async setPrivate(on: boolean) {
    const room = this.ed.room;
    if (!room) return;
    if (on && room.members.length > 1 && !(await confirmDialog('Make this canvas private?', 'Everyone else will be disconnected, and only you will be able to open it.', 'Make private'))) return;
    try { await api.updateRoom(room.id, { private: on }); } catch (e) { this.toast((e as Error).message); }
  }

  private onChange(w: string) {
    const ed = this.ed;
    if (w === 'tool') {
      for (const [id, b] of this.toolButtons) b.classList.toggle('active', id === ed.toolId);
      this.updateToolIcons();
      if (this.toolPopFor && this.toolPopFor !== ed.toolId) this.closePicker();
      this.renderOptions();
      this.syncSliders();
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
    } else if (w.startsWith('toast:')) {
      this.toast(w.slice(6));
    }
  }

  /** The selection and shape buttons show the mode they will use. */
  private updateToolIcons() {
    const st = this.ed.settings;
    const sel = SELECT_MODES.find((m) => m[0] === st.selectMode)!;
    const shp = SHAPE_KINDS.find((m) => m[0] === st.shape)!;
    this.toolButtons.get('select')!.innerHTML = icon(sel[2]);
    this.toolButtons.get('shape')!.innerHTML = icon(shp[2]);
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
    if (id === 'brush' || id === 'eraser') content = brushLibrary(ed, id === 'eraser', done);
    else if (id === 'select') content = iconChoices(SELECT_MODES, st.selectMode, (v) => { st.selectMode = v; ed.setTool('select'); done(); });
    else content = iconChoices(SHAPE_KINDS, st.shape, (v) => { st.shape = v; ed.setTool('shape'); done(); });
    this.toolPop.replaceChildren(content);
    this.toolPop.hidden = false;
    this.toolPopFor = id;
    for (const [tid, b] of this.toolButtons) b.classList.toggle('open', tid === id && b === anchor);
    // Drop down from the anchor, kept on screen.
    const r = anchor.getBoundingClientRect();
    const w = this.toolPop.offsetWidth;
    this.toolPop.style.top = `${Math.round(r.bottom + 6)}px`;
    this.toolPop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)))}px`;
  }

  /** Options-bar twin of the toolbar drop-down (current mode icon + name). */
  private modeButton([, label, ic]: [string, string, string]) {
    const b: HTMLButtonElement = h('button.preset-btn', {
      title: 'Change mode', 'aria-label': `Mode: ${label}. Change mode`,
      html: icon(ic, 18) + `<span>${label}</span><span class="caret">${icon('chevronDown', 14)}</span>`,
      onclick: () => this.togglePicker(this.ed.toolId, b),
    });
    return b;
  }

  private syncSliders() {
    this.sizeSlider.set(this.ed.sizeParams.size);
    this.opacitySlider.set(this.ed.sizeParams.opacity);
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

  // ---- Tool options bar (Clip Studio style sub-tool properties) ----
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
    if (ed.toolId === 'brush' || ed.toolId === 'eraser') {
      const erase = ed.toolId === 'eraser';
      const presets = erase ? ERASER_PRESETS : BRUSH_PRESETS;
      const params = erase ? st.eraser : st.brush;
      const name = presets[erase ? st.eraserPreset : st.brushPreset]?.name ?? 'Brush';
      const pick: HTMLButtonElement = h('button.preset-btn', {
        title: 'Choose a brush', 'aria-label': `Brush: ${name}. Choose a brush`, html: '',
        onclick: () => this.togglePicker(ed.toolId, pick),
      });
      pick.append(brushPreview(params, 64, 24), h('span', {}, name), h('span.caret', { html: icon('chevronDown', 14) }));
      o.append(pick,
        range('Hardness', params.hardness, 0, 1, (v) => { params.hardness = v; }),
        range('Flow', params.flow, 0.02, 1, (v) => { params.flow = v; }),
        range('Smoothing', params.smoothing, 0, 1, (v) => { params.smoothing = v; }),
        label('Pressure:'),
        toggle('Size', params.pressureSize > 0, (v) => { params.pressureSize = v ? 1 : 0; }),
        toggle('Opacity', params.pressureFlow > 0, (v) => { params.pressureFlow = v ? 1 : 0; }),
      );
    } else if (ed.toolId === 'fill') {
      o.append(
        range('Tolerance', st.fillTolerance, 0, 1, (v) => { st.fillTolerance = v; }),
        range('Expand', st.fillExpand, 0, 4, (v) => { st.fillExpand = Math.round(v); }, (v) => Math.round(v) + 'px'),
        label('Reference:'),
        seg([['all', 'All layers'], ['layer', 'This layer']] as const, st.fillSampleAll ? 'all' : 'layer', (v) => { st.fillSampleAll = v === 'all'; }),
      );
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
        o.append(h('span.hint', {}, ed.selection ? 'Drag inside to move, corners to scale, the blue dot to rotate.' : 'Drag to select. Painting stays inside the selection.'));
      }
    } else if (ed.toolId === 'shape') {
      o.append(
        this.modeButton(SHAPE_KINDS.find((m) => m[0] === st.shape)!),
        toggle('Filled', st.shapeFill, (v) => { st.shapeFill = v; }),
        h('span.hint', {}, 'Uses brush size and opacity. Shift constrains, Alt draws from centre.'),
      );
    } else if (ed.toolId === 'eyedropper') {
      o.append(h('span.hint', {}, 'Tap the canvas to pick a colour. Tip: hold Alt with the brush to pick quickly.'));
    }
  }

  private menu(): HTMLElement {
    const ed = this.ed;
    const st = ed.settings;
    const gamma = new Slider({
      min: 0.4, max: 2.5, value: st.pressureGamma, label: 'Pressure curve',
      format: (v) => (v < 0.95 ? 'Light ' : v > 1.05 ? 'Firm ' : 'Linear ') + v.toFixed(2),
      onInput: (v) => { st.pressureGamma = v; },
    });
    const finger = h('input', { type: 'checkbox' });
    const pop = h('div.popover.menu-pop', { hidden: true },
      h('div.panel', {},
        this.menuDyn,
        gamma.el,
        h('label.check.menu-check', {}, finger, 'Draw with finger (off once a pen is used)'),
        h('div.menu-sep'),
        h('div.shortcuts', { html: SHORTCUTS }),
      ),
    );
    finger.addEventListener('change', () => { st.fingerDraws = finger.checked; });
    pop.addEventListener('pointerenter', () => { finger.checked = st.fingerDraws; gamma.set(st.pressureGamma); });
    new MutationObserver(() => { finger.checked = st.fingerDraws; }).observe(pop, { attributes: true, attributeFilter: ['hidden'] });
    return pop;
  }

  /** Account, room and file actions; rebuilt whenever the menu opens. */
  private renderMenuDyn() {
    const ed = this.ed, s = this.session, d = this.menuDyn, st = ed.settings;
    const close = () => { (d.closest('.popover') as HTMLElement).hidden = true; };
    const item = (ic: string, text: string, fn: () => void, cls = '') =>
      h(`button.menu-item${cls}` as 'button', { html: icon(ic, 18) + `<span>${text}</span>`, onclick: () => { close(); fn(); } });
    clear(d);
    const me = ed.me;
    if (me) {
      d.append(h('div.account', {}, avatarEl(me, 36), h('div.account-text', {}, nameLine(me, undefined), h('small.muted', {}, '@' + me.handle))),
        h('div.row.account-actions', {},
          h('button.btn', { html: icon('user', 16) + '<span>Edit profile</span>', onclick: () => { close(); s.editProfile(); } }),
          h('button.btn', { html: icon('logout', 16) + '<span>Log out</span>', onclick: () => { close(); s.logout(); } })),
        h('div.menu-sep'));
    } else if (s.server) {
      d.append(item('user', 'Log in to draw together…', () => { location.href = '/login?next=/app'; }), h('div.menu-sep'));
    }
    if (ed.room) {
      const info = ed.room.info, own = info?.ownerId === ed.room.you;
      d.append(h('div.menu-label', {}, info?.name ?? 'Canvas'));
      if (info?.private) {
        if (own) d.append(item('users', 'Share with friends…', () => this.shareCanvas()));
      } else {
        d.append(item('link', 'Copy invite link', () => this.copyInvite()));
        if (own) d.append(item('lock', 'Make private', () => this.setPrivate(true)));
      }
      d.append(item('home', 'Back to home', () => s.leaveRoom()));
    } else if (me) {
      d.append(item('home', 'Home', () => s.showHome()));
      if (!this.ed.me?.guest) d.append(item('plus', 'Create new…', () => s.createNew()));
    } else {
      d.append(item('file', 'New canvas…', () => this.newCanvas()));
    }
    d.append(item('download', 'Export PNG / JPG / PSD…', () => exportDialog(ed)), h('div.menu-sep'));
    if (ed.room || me) {
      const tog = (label: string, get: () => boolean, set: (v: boolean) => void) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = get();
        cb.addEventListener('change', () => { set(cb.checked); ed.emit('settings'); ed.view.requestRender(); });
        return h('label.check.menu-check', {}, cb, label);
      };
      d.append(
        tog('Show name bubbles where others draw', () => st.showBubbles, (v) => { st.showBubbles = v; }),
        tog('Hide other people’s folders in Layers', () => st.hideOthersFolders, (v) => { st.hideOthersFolders = v; }),
        h('div.menu-sep'),
      );
    }
    d.append(this.themeRow(), h('div.menu-sep'));
  }

  async newCanvas() {
    const empty = this.ed.doc.log.length <= 1;
    if (!empty && !(await confirmDialog('Start a new canvas?', 'Your current drawing will be discarded. Export it first if you want to keep it.', 'Discard and start new'))) return;
    newCanvasDialog((doc) => this.ed.setDoc(doc));
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, M: DOMMatrix) {
    const ed = this.ed;
    this.select.overlay(ctx, M);
    this.roomUI.drawBubbles(ctx, M);
    const hv = ed.hover;
    if (hv && (ed.toolId === 'brush' || ed.toolId === 'eraser') && !this.input.altPick && !this.input.viewKey) {
      const p = M.transformPoint(hv);
      const r = Math.max(1, (ed.sizeParams.size * ed.view.viewport.zoom) / 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, r - 0.5), 0, Math.PI * 2); ctx.stroke();
    }
  }

  private bindKeys() {
    const ed = this.ed;
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea')) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); ed.redo(); return; }
      if (mod && k === 'a') { e.preventDefault(); ed.setTool('select'); this.select.selectAll(); return; }
      if (mod && k === 'd') { e.preventDefault(); this.select.deselect(); return; }
      if (mod && e.shiftKey && k === 'e') { e.preventDefault(); exportDialog(ed); return; }
      if (mod) return;
      if (e.key === ' ') { this.input.spaceHeld = true; ed.view.canvas.style.cursor = 'grab'; e.preventDefault(); return; }
      if (e.key === 'Alt') { this.input.altPick = true; e.preventDefault(); ed.view.requestRender(); return; }
      if (k === 'r' || k === 'z') {
        this.input.viewKey = k === 'r' ? 'rotate' : 'zoom';
        ed.view.canvas.style.cursor = k === 'r' ? 'grab' : 'zoom-in';
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
      const tool = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (tool) { ed.setTool(tool.id); return; }
      if (k === '[' || k === ']') {
        const p = ed.sizeParams;
        p.size = Math.max(1, Math.min(500, p.size * (k === ']' ? 1.15 : 1 / 1.15)));
        this.syncSliders(); ed.view.requestRender(); return;
      }
      if (k === 'h') ed.view.viewport.flip(true);
      else if (k === 'v') ed.view.viewport.flip(false);
      else if (k === '0') ed.fitView();
      else if (k === '=' || k === '+') this.zoomCenter(1.25);
      else if (k === '-') this.zoomCenter(0.8);
      else if (k === 'l') (document.querySelector('[aria-label="Layers (L)"]') as HTMLElement)?.click();
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') { this.input.spaceHeld = false; ed.view.canvas.style.cursor = ''; }
      const k = e.key.toLowerCase();
      if ((k === 'r' && this.input.viewKey === 'rotate') || (k === 'z' && this.input.viewKey === 'zoom')) {
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

  /** Delete key clears the selected area of the active layer. */
  private deleteSelection() {
    const ed = this.ed;
    if (!ed.selection) return;
    this.select.commit();
    const sel = ed.selection!;
    // An eraser "shape" covering the selection keeps this a normal, syncable op.
    const xs = sel.pts.filter((_, i) => i % 2 === 0), ys = sel.pts.filter((_, i) => i % 2 === 1);
    const x0 = Math.min(...xs) - 2, y0 = Math.min(...ys) - 2, x1 = Math.max(...xs) + 2, y1 = Math.max(...ys) + 2;
    ed.apply({
      t: 'shape', id: uid(), layer: ed.activeLayer, shape: 'rect', x0, y0, x1, y1,
      width: 0, fill: true, color: '#000000', opacity: 1, erase: true, clip: sel,
    });
  }
}

const SHORTCUTS = `
<strong>Shortcuts</strong>
<div><kbd>B</kbd> Brush <kbd>E</kbd> Eraser <kbd>G</kbd> Fill <kbd>M</kbd> Select <kbd>U</kbd> Shapes <kbd>I</kbd> Eyedropper</div>
<div><kbd>Ctrl Z</kbd> Undo <kbd>Ctrl Shift Z</kbd> Redo <kbd>[</kbd> <kbd>]</kbd> Brush size</div>
<div><kbd>R</kbd> + drag rotate (Shift snaps) · <kbd>Z</kbd> + drag zoom · tap a selected tool for its options</div>
<div><kbd>Space</kbd> drag to pan · <kbd>Ctrl</kbd>+scroll / pinch to zoom · <kbd>Alt</kbd>+scroll zoom</div>
<div><kbd>H</kbd> / <kbd>V</kbd> Flip view · <kbd>0</kbd> Fit · <kbd>Ctrl A</kbd> / <kbd>Ctrl D</kbd> Select all / none</div>
<div><kbd>Enter</kbd> Apply transform · <kbd>Esc</kbd> Cancel · <kbd>Delete</kbd> Clear selection</div>
<div style="margin-top:6px"><strong>Touch</strong>: two fingers pan / zoom / rotate · two-finger tap undo · three-finger tap redo</div>`;
