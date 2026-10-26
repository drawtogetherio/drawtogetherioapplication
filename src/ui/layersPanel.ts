import { Rect, ctx2d, uid } from '../core/geom';
import { BLEND_LABELS, BLEND_MODES, BlendMode, LayerProps } from '../core/model';
import type { DocNode, Folder, Layer } from '../core/document';
import type { Editor } from '../editor';
import { h } from './dom';
import { effectsBar } from './effectsBar';
import { ADJUST_DEFAULTS, EFFECT_INFO } from '../engine/effects';
import { ADJUSTMENTS } from '../core/model';
import { icon } from './icons';
import { Slider } from './slider';
import { textDialog } from './dialogs';
import { avatarEl } from './people';

const THUMB = 48;

interface Row { node: DocNode; depth: number; el: HTMLElement }

/** Layers and folders; drag rows to reorder or into a folder. */
export class LayersPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private blend: HTMLSelectElement;
  private opacity: Slider;
  private lockBtn: HTMLButtonElement;
  private clipBtn: HTMLButtonElement;
  private refBtn: HTMLButtonElement;
  private maskBtn: HTMLButtonElement;
  private applyMaskBtn: HTMLButtonElement;
  private maskHint = h('div.mask-hint', { hidden: true }, 'Editing the mask: paint hides, erase shows.');
  private footer: HTMLElement;
  private folderFooter: HTMLElement;
  private dropLine = h('div.drop-line', { hidden: true });
  private thumbs = new Map<string, HTMLCanvasElement>();
  private maskThumbs = new Map<string, HTMLCanvasElement>();
  private thumbTimer = 0;
  /** Layers whose thumbnails are stale; null means all of them. */
  private staleThumbs: Set<string> | null = new Set();
  private thumbArea = '';
  private collapsed = new Set<string>();
  selectedFolder: string | null = null;
  private rows: Row[] = [];
  open = false;

  constructor(private ed: Editor, meter?: HTMLElement) {
    this.list = h('div.layer-list', {}, this.dropLine);
    this.blend = h('select.blend-select', { 'aria-label': 'Blend mode' });
    for (const m of BLEND_MODES) this.blend.append(h('option', { value: m }, BLEND_LABELS[m]));
    this.blend.addEventListener('change', () => this.setProps({ blend: this.blend.value as BlendMode }));
    this.opacity = new Slider({
      min: 0, max: 1, value: 1, label: 'Opacity', format: (v) => Math.round(v * 100) + '%',
      onInput: (v) => this.setProps({ opacity: Math.round(v * 100) / 100 }, true),
    });
    this.lockBtn = h('button.icon-btn', {
      title: 'Lock transparency (paint only on existing pixels)', html: icon('lock', 18),
      onclick: () => { const l = this.ed.layer; if (l) this.setProps({ alphaLock: !l.props.alphaLock }); },
    });

    const act = (name: string, title: string, fn: () => void, cls = '') => h('button.icon-btn', { title, 'aria-label': title, class: cls, html: icon(name, 18), onclick: fn });
    this.clipBtn = act('clipMask', 'Clip to the layer below', () => this.ed.toggleClip());
    this.refBtn = act('target', 'Reference: fills and the wand read their edges from this layer', () => {
      const id = this.ed.activeLayer;
      this.ed.referenceLayer = this.ed.referenceLayer === id ? null : id;
      this.ed.emit('layers'); this.ed.emit('tool');
    });
    this.maskBtn = act('maskIc', 'Add mask', () => this.ed.setMask(!this.ed.layer?.mask));
    this.applyMaskBtn = act('check', 'Apply mask to pixels', () => this.ed.applyMask());
    this.footer = h('div.layer-props', {},
      h('div.row', {}, this.blend),
      this.opacity.el,
      h('div.row.layer-actions', {},
        act('rename', 'Rename layer', () => this.renameLayer()),
        act('copy', 'Duplicate layer', () => this.ed.duplicateLayer()),
        act('merge', 'Merge down', () => this.merge()),
        this.lockBtn, this.clipBtn, this.refBtn, this.maskBtn, this.applyMaskBtn,
        act('clear', 'Clear layer', () => { this.ed.commitPending(); if (this.ed.layer) this.ed.apply({ t: 'layer.clear', id: uid(), layer: this.ed.activeLayer, mask: this.ed.onMask }); }),
        act('trash', 'Delete layer', () => this.removeLayer(), 'danger'),
      ),
      this.maskHint,
    );
    this.folderFooter = h('div.layer-props', { hidden: true },
      h('div.row.layer-actions', {},
        act('rename', 'Rename folder', () => this.renameFolder()),
        act('plus', 'New layer in this folder', () => this.ed.addLayer()),
        act('folderPlus', 'New folder inside', () => this.ed.addFolder()),
        act('trash', 'Delete folder and its layers', () => this.removeFolder(), 'danger'),
      ),
    );
    this.el = h('div.panel.layers-panel', {},
      h('div.panel-head', {}, h('span.panel-title', {}, 'Layers'),
        h('span.head-actions', {}, meter ?? null, act('sparkle', 'New adjustment layer', () => this.addAdjustment()), act('folderPlus', 'New folder', () => this.ed.addFolder()), act('plus', 'New layer', () => this.ed.addLayer()))),
      this.list,
      this.footer,
      this.folderFooter,
    );
    ed.on((w) => {
      if (w.startsWith('pixels:')) {
        // Only that layer's pixels changed: refresh its thumbnail, leave the rows alone.
        this.staleThumbs?.add(w.slice(7));
        this.scheduleThumbs();
      } else if (w === 'layers' || w === 'doc' || w === 'members' || w === 'settings') {
        if (this.selectedFolder && (!this.ed.doc.folder(this.selectedFolder) || this.ed.targetFolder !== this.selectedFolder)) this.selectedFolder = null;
        if (w === 'layers' || w === 'doc') this.staleThumbs = null;
        this.scheduleThumbs();
        if (this.open) this.render();
      }
    });
  }

  private setProps(props: Partial<Omit<LayerProps, 'id' | 'owner'>>, coalesce = false) {
    const layer = this.ed.layer;
    if (!layer || !this.ed.canEdit(layer.props.id)) return;
    const id = layer.props.id;
    if (coalesce) {
      // Live opacity drag: change directly, record a single undo step after a pause.
      const before = this.pendingOpacity?.layer === id ? this.pendingOpacity.from : layer.props.opacity;
      Object.assign(layer.props, props);
      this.ed.view.invalidate(null);
      clearTimeout(this.pendingOpacity?.timer);
      this.pendingOpacity = {
        layer: id, from: before,
        timer: window.setTimeout(() => {
          const to = layer.props.opacity;
          layer.props.opacity = before;
          this.pendingOpacity = null;
          if (to !== before) this.ed.apply({ t: 'layer.props', id: uid(), layer: id, props: { opacity: to } });
        }, 350),
      };
      return;
    }
    this.ed.apply({ t: 'layer.props', id: uid(), layer: id, props });
  }
  private pendingOpacity: { layer: string; from: number; timer: number } | null = null;

  folderLabel(f: Folder): { name: string; color: string | null; member?: ReturnType<NonNullable<Editor['room']>['member']> } {
    if (f.props.user && f.props.owner) {
      const m = this.ed.room?.member(f.props.owner);
      return { name: m?.displayName ?? f.props.name, color: m ? (m.gradient ? m.gradient[0] : m.favoriteColor) : f.props.color ?? null, member: m };
    }
    return { name: f.props.name, color: f.props.color ?? null };
  }

  private async renameLayer() {
    const l = this.ed.layer;
    if (!l || !this.ed.canEdit(l.props.id)) return;
    const name = await textDialog('Rename layer', l.props.name);
    if (name && name.trim()) this.setProps({ name: name.trim().slice(0, 60) });
  }

  private async renameFolder() {
    const f = this.selectedFolder && this.ed.doc.folder(this.selectedFolder);
    if (!f || !this.ed.canEdit(f.props.id)) return;
    if (f.props.user) { this.ed.toast('Member folders use the member’s display name'); return; }
    const name = await textDialog('Rename folder', f.props.name);
    if (name && name.trim()) this.ed.apply({ t: 'folder.props', id: uid(), folder: f.props.id, props: { name: name.trim().slice(0, 60) } });
  }

  private removeFolder() {
    const f = this.selectedFolder && this.ed.doc.folder(this.selectedFolder);
    if (!f || !this.ed.canEdit(f.props.id)) return;
    if (f.props.user && !this.ed.room?.isHost) { this.ed.toast('Your own folder can’t be deleted'); return; }
    this.ed.commitPending();
    this.ed.apply({ t: 'folder.remove', id: uid(), folder: f.props.id });
    this.selectedFolder = null;
  }

  private merge() {
    this.ed.commitPending();
    const l = this.ed.layer;
    if (!l) return;
    const below = this.ed.doc.layerBelow(l.props.id);
    if (!below) { this.ed.toast('There’s no layer directly below in this folder'); return; }
    if (!this.ed.canEdit(l.props.id) || !this.ed.canEdit(below.props.id)) { this.ed.toast('You can only merge your own layers'); return; }
    this.ed.apply({ t: 'layer.merge', id: uid(), layer: l.props.id });
    this.ed.setActiveLayer(below.props.id);
  }

  private removeLayer() {
    this.ed.commitPending();
    const l = this.ed.layer;
    if (!l || !this.ed.canEdit(l.props.id)) return;
    if (!this.ed.room && this.ed.doc.layers.length <= 1) { this.ed.apply({ t: 'layer.clear', id: uid(), layer: l.props.id }); return; }
    this.ed.apply({ t: 'layer.remove', id: uid(), layer: l.props.id });
  }

  private listed(n: DocNode) {
    if (!this.ed.room || !this.ed.settings.hideOthersFolders) return true;
    return n.props.owner === this.ed.room.you;
  }

  render() {
    const ed = this.ed, doc = ed.doc;
    this.rows = [];
    const walk = (parent: string | null, depth: number) => {
      const ids = [...doc.children(parent)].reverse(); // top of the stack first
      for (const id of ids) {
        const n = doc.node(id)!;
        if (depth === 0 && !this.listed(n)) continue;
        this.rows.push({ node: n, depth, el: n.kind === 'layer' ? this.layerRow(n, depth) : this.folderRow(n, depth) });
        if (n.kind === 'folder' && !this.collapsed.has(id)) walk(id, depth + 1);
      }
    };
    walk(null, 0);
    const empty = !this.rows.length ? h('div.layers-empty', {}, ed.room ? 'Your folder will appear here.' : 'No layers yet.') : null;
    this.list.replaceChildren(this.dropLine, ...this.rows.map((r) => r.el), ...(empty ? [empty] : []));

    const folderMode = !!this.selectedFolder;
    this.footer.hidden = folderMode;
    this.folderFooter.hidden = !folderMode;
    const l = ed.layer;
    const editable = !!l && ed.canEdit(l.props.id);
    this.footer.classList.toggle('disabled', !editable);
    this.blend.disabled = !editable;
    if (l) {
      this.blend.value = l.props.blend;
      if (!this.pendingOpacity) this.opacity.set(l.props.opacity);
      this.lockBtn.classList.toggle('on', l.props.alphaLock);
      this.clipBtn.classList.toggle('on', !!l.props.clip);
      this.refBtn.classList.toggle('on', ed.referenceLayer === l.props.id);
      this.maskBtn.classList.toggle('on', !!l.mask);
      this.maskBtn.title = this.maskBtn.ariaLabel = l.mask ? 'Delete mask' : 'Add mask';
      this.applyMaskBtn.hidden = !l.mask;
      this.maskHint.hidden = !ed.onMask;
    }
  }

  private indent(depth: number) { return `padding-left:${6 + depth * 16}px`; }

  private folderRow(f: Folder, depth: number): HTMLElement {
    const ed = this.ed;
    const { name, color, member } = this.folderLabel(f);
    const open = !this.collapsed.has(f.props.id);
    const mine = ed.canEdit(f.props.id);
    const chevron = h('button.icon-btn.chev', {
      title: open ? 'Collapse' : 'Expand', html: icon(open ? 'chevronDown' : 'chevronRight', 16),
      onclick: (e: Event) => { e.stopPropagation(); if (open) this.collapsed.add(f.props.id); else this.collapsed.delete(f.props.id); this.render(); },
    });
    const vis = this.visButton(f.props.visible, mine || ed.canEdit(f.props.id), () =>
      ed.apply({ t: 'folder.props', id: uid(), folder: f.props.id, props: { visible: !f.props.visible } }));
    const lead = member ? avatarEl(member, 22) : h('span.folder-ic', { html: icon('folder', 18) });
    const row = h(`div.layer-row.folder-row${this.selectedFolder === f.props.id ? '.active' : ''}${f.shown ? '' : '.hidden-layer'}` as 'div',
      { 'data-id': f.props.id, style: this.indent(depth) + (color ? `;--folder:${color}` : '') },
      chevron, lead,
      h('div.layer-name', {}, h('div', {}, name), f.props.user && member?.id === ed.room?.you ? h('small', {}, 'Your folder') : null),
      mine ? null : h('span.lock-ic', { title: 'Only its owner or a host can edit this', html: icon('lock', 14) }),
      vis,
    );
    if (color) row.classList.add('colored');
    row.addEventListener('pointerdown', (e) => this.dragStart(e, row, f));
    return row;
  }

  private layerRow(l: Layer, depth: number): HTMLElement {
    const ed = this.ed;
    const p = l.props;
    const mine = ed.canEdit(p.id);
    const vis = this.visButton(p.visible, mine, () => ed.apply({ t: 'layer.props', id: uid(), layer: p.id, props: { visible: !p.visible } }));
    const meta = [p.blend !== 'normal' ? BLEND_LABELS[p.blend] : '', p.opacity < 1 ? Math.round(p.opacity * 100) + '%' : '', p.alphaLock ? 'Locked α' : '', p.clip ? 'Clipped' : '', ed.referenceLayer === p.id ? 'Reference' : ''].filter(Boolean).join(' · ');
    const active = p.id === ed.activeLayer && !this.selectedFolder;
    const onMask = active && ed.onMask;
    const row = h(`div.layer-row${active ? '.active' : ''}${l.shown ? '' : '.hidden-layer'}${p.clip ? '.clipped' : ''}` as 'div', { 'data-id': p.id, style: this.indent(depth) },
      p.clip ? h('span.clip-ic', { html: icon('clipMask', 14) }) : null,
      p.adjust
        ? h('div.layer-thumb.adjust-thumb', { title: 'Edit adjustment', html: icon('sparkle', 22),
          // On the active row the badge opens the settings instead of starting a drag (which would re-render the row under the click).
          onpointerdown: (e: Event) => { if (active && mine) e.stopPropagation(); },
          onclick: () => { if (active && mine) effectsBar(this.ed, p.adjust!.effect, l); } })
        : h(`div.layer-thumb${active && !onMask ? '.editing' : ''}` as 'div', { title: l.mask ? 'Edit pixels' : null }, this.thumb(l)),
      l.mask ? h(`div.layer-thumb.mask-thumb${onMask ? '.editing' : ''}` as 'div', { title: 'Edit mask', 'data-mask': '1' }, this.maskThumb(l)) : null,
      h('div.layer-name', {}, h('div', {}, p.name), meta ? h('small', {}, meta) : null),
      mine ? null : h('span.lock-ic', { title: `Belongs to ${ed.ownerName(p.owner)}`, html: icon('lock', 14) }),
      vis,
    );
    row.addEventListener('pointerdown', (e) => this.dragStart(e, row, l));
    row.addEventListener('dblclick', (e) => { if (p.adjust && mine && !(e.target as Element).closest('.layer-name')) effectsBar(this.ed, p.adjust.effect, l); else this.renameLayer(); });
    return row;
  }

  /** Picks which adjustment the new layer makes, then opens its settings. */
  private addAdjustment() {
    const pop = h('div.popover.panel.adjust-pick', {}, ...ADJUSTMENTS.map((e) =>
      h('button.menu-item', { html: `<span>${EFFECT_INFO[e].name}</span>`, onclick: () => {
        pop.remove();
        const d = ADJUST_DEFAULTS[e], l = this.ed.addAdjustmentLayer({ effect: e, amount: 1, params: d.params ? [...d.params] : undefined, colors: d.colors ? [...d.colors] : undefined });
        if (l) effectsBar(this.ed, e, l);
      } })));
    this.el.append(pop);
    setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target as Node)) pop.remove(); }, { once: true, capture: true }));
  }

  private visButton(visible: boolean, enabled: boolean, toggle: () => void) {
    const b = h('button.icon-btn.vis', {
      title: visible ? 'Hide' : 'Show', html: icon(visible ? 'eye' : 'eyeOff', 18),
      onclick: (e: Event) => { e.stopPropagation(); if (enabled) toggle(); },
    });
    if (!enabled) b.disabled = true;
    return b;
  }

  private select(n: DocNode, mask = false) {
    if (n.kind === 'folder') { this.selectedFolder = n.props.id; this.ed.targetFolder = n.props.id; this.render(); }
    else { this.selectedFolder = null; this.ed.setActiveLayer(n.props.id, mask); }
  }

  private dragStart(e: PointerEvent, row: HTMLElement, node: DocNode) {
    if ((e.target as HTMLElement).closest('.vis, .chev')) return;
    const mask = !!(e.target as HTMLElement).closest('[data-mask]');
    const y0 = e.clientY;
    let dragging = false;
    let target: { parent: string | null; index: number } | null = null;
    try { row.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const canMove = this.ed.canEdit(node.props.id) && !(node.kind === 'folder' && node.props.user && !this.ed.room?.isHost);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      if (!dragging && Math.abs(dy) > 8 && canMove) { dragging = true; row.classList.add('dragging'); }
      if (!dragging) return;
      row.style.transform = `translateY(${dy}px)`;
      target = this.dropTarget(ev.clientY, node);
    };
    const up = () => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      row.removeEventListener('pointercancel', up);
      this.dropLine.hidden = true;
      this.list.querySelector('.drop-into')?.classList.remove('drop-into');
      if (!dragging) { this.select(node, mask); return; }
      row.style.transform = '';
      row.classList.remove('dragging');
      if (target) this.ed.apply({ t: 'node.move', id: uid(), node: node.props.id, parent: target.parent, index: target.index });
      else this.render();
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
    row.addEventListener('pointercancel', up);
  }

  private dropTarget(y: number, moving: DocNode): { parent: string | null; index: number } | null {
    const doc = this.ed.doc;
    this.list.querySelector('.drop-into')?.classList.remove('drop-into');
    this.dropLine.hidden = true;
    const rows = this.rows.filter((r) => r.node !== moving && !(moving.kind === 'folder' && doc.isWithin(r.node.props.id, moving.props.id)));
    let hit: Row | undefined;
    let where: 'above' | 'below' | 'into' = 'below';
    for (const r of rows) {
      const b = r.el.getBoundingClientRect();
      if (y < b.top || y > b.bottom) continue;
      hit = r;
      const t = (y - b.top) / b.height;
      where = r.node.kind === 'folder' && t > 0.3 && t < 0.7 ? 'into' : t < 0.5 ? 'above' : 'below';
      break;
    }
    if (!hit) return null;
    let parent: string | null, index: number;
    if (where === 'into') { parent = hit.node.props.id; index = doc.children(parent).length; }
    else {
      const pl = doc.place(hit.node.props.id);
      parent = pl.parent;
      index = where === 'above' ? pl.index + 1 : pl.index;
    }
    // Moving within the same parent: account for the row leaving its old slot.
    const from = doc.place(moving.props.id);
    if (from.parent === parent && from.index < index) index--;
    const ed = this.ed;
    const allowed = parent === null ? !ed.room || ed.room.isHost : ed.canEdit(parent);
    if (!allowed) return null;
    const lb = hit.el.getBoundingClientRect(), list = this.list.getBoundingClientRect();
    if (where === 'into') hit.el.classList.add('drop-into');
    else {
      this.dropLine.hidden = false;
      this.dropLine.style.top = (where === 'above' ? lb.top : lb.bottom) - list.top + this.list.scrollTop - 1 + 'px';
    }
    return { parent, index };
  }

  private thumb(l: Layer): HTMLCanvasElement {
    let c = this.thumbs.get(l.props.id);
    if (!c) {
      c = h('canvas', { width: THUMB, height: THUMB });
      this.thumbs.set(l.props.id, c);
      this.drawThumb(l, c);
    }
    return c;
  }

  private maskThumb(l: Layer): HTMLCanvasElement {
    let c = this.maskThumbs.get(l.props.id);
    if (!c) {
      c = h('canvas', { width: THUMB, height: THUMB });
      this.maskThumbs.set(l.props.id, c);
      this.drawThumb(l, c, true);
    }
    return c;
  }

  /** Throttled rather than debounced, so thumbnails keep up while people draw without running per stroke. */
  private scheduleThumbs() {
    if (this.thumbTimer) return;
    this.thumbTimer = window.setTimeout(() => {
      this.thumbTimer = 0;
      const s = this.ed.doc.settings;
      const area: Rect | null = s.infinite ? this.ed.doc.bounds() : { x: 0, y: 0, w: s.width, h: s.height };
      const key = area ? [area.x, area.y, area.w, area.h].join(',') : '';
      // A new framing redraws every thumbnail; otherwise only the layers that changed.
      const stale = key === this.thumbArea ? this.staleThumbs : null;
      this.thumbArea = key;
      this.staleThumbs = new Set();
      for (const [id, c] of this.thumbs) {
        const l = this.ed.doc.layer(id);
        if (!l) this.thumbs.delete(id);
        else if (!stale || stale.has(id)) this.drawThumb(l, c, false, area);
      }
      for (const [id, c] of this.maskThumbs) {
        const l = this.ed.doc.layer(id);
        if (!l?.mask) this.maskThumbs.delete(id);
        else if (!stale || stale.has(id)) this.drawThumb(l, c, true, area);
      }
    }, 300);
  }

  private thumbFrame(): Rect | null {
    const s = this.ed.doc.settings;
    return s.infinite ? this.ed.doc.bounds() : { x: 0, y: 0, w: s.width, h: s.height };
  }

  /** The layer's pixels, or its mask as black on white (black hides, like other apps show it). */
  private drawThumb(l: Layer, c: HTMLCanvasElement, mask = false, area = this.thumbFrame()) {
    const ctx = ctx2d(c);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, THUMB, THUMB);
    if (mask) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, THUMB, THUMB); }
    if (!area) return;
    const k = Math.min(THUMB / area.w, THUMB / area.h);
    ctx.translate((THUMB - area.w * k) / 2, (THUMB - area.h * k) / 2);
    ctx.scale(k, k);
    ctx.translate(-area.x, -area.y);
    ctx.imageSmoothingQuality = 'high';
    if (!mask) { l.surface.drawTo(ctx, area); return; }
    const m = l.mask!.extract(area);
    const mc = ctx2d(m);
    mc.globalCompositeOperation = 'source-in';
    mc.fillStyle = '#000';
    mc.fillRect(0, 0, area.w, area.h);
    ctx.drawImage(m, area.x, area.y);
  }
}
