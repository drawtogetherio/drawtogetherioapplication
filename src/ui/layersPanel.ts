import { Rect, ctx2d, uid } from '../core/geom';
import { BLEND_LABELS, BLEND_MODES, BlendMode, LayerProps } from '../core/model';
import type { Layer } from '../core/document';
import type { Editor } from '../editor';
import { h } from './dom';
import { icon } from './icons';
import { Slider } from './slider';
import { textDialog } from './dialogs';

const THUMB = 56;

/** Layer list with visibility, reordering (drag), blend mode, opacity and layer actions. */
export class LayersPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private blend: HTMLSelectElement;
  private opacity: Slider;
  private lockBtn: HTMLButtonElement;
  private thumbs = new Map<string, HTMLCanvasElement>();
  private thumbTimer = 0;
  open = false;

  constructor(private ed: Editor) {
    this.list = h('div.layer-list');
    this.blend = h('select.blend-select', { 'aria-label': 'Blend mode' });
    for (const m of BLEND_MODES) this.blend.append(h('option', { value: m }, BLEND_LABELS[m]));
    this.blend.addEventListener('change', () => this.setProps({ blend: this.blend.value as BlendMode }));
    this.opacity = new Slider({
      min: 0, max: 1, value: 1, label: 'Opacity', format: (v) => Math.round(v * 100) + '%',
      onInput: (v) => this.setProps({ opacity: Math.round(v * 100) / 100 }, true),
    });
    this.lockBtn = h('button.icon-btn', { title: 'Lock transparency (paint only on existing pixels)', html: icon('lock', 18), onclick: () => this.setProps({ alphaLock: !this.ed.layer.props.alphaLock }) });

    const act = (name: string, title: string, fn: () => void) => h('button.icon-btn', { title, 'aria-label': title, html: icon(name, 18), onclick: fn });
    this.el = h('div.panel.layers-panel', {},
      h('div.panel-head', {}, h('span.panel-title', {}, 'Layers'), act('plus', 'New layer', () => this.ed.addLayer())),
      this.list,
      h('div.layer-props', {},
        h('div.row', {}, this.blend),
        this.opacity.el,
        h('div.row.layer-actions', {},
          act('rename', 'Rename', () => this.rename()),
          act('copy', 'Duplicate', () => this.ed.duplicateLayer()),
          act('merge', 'Merge down', () => this.merge()),
          this.lockBtn,
          act('clear', 'Clear layer', () => { this.ed.commitPending(); this.ed.apply({ t: 'layer.clear', id: uid(), layer: this.ed.activeLayer }); }),
          act('trash', 'Delete layer', () => this.remove()),
        ),
      ),
    );
    ed.on((w) => {
      if (w === 'layers' || w === 'doc') { this.scheduleThumbs(); if (this.open) this.render(); }
    });
  }

  private setProps(props: Partial<Omit<LayerProps, 'id'>>, coalesce = false) {
    const id = this.ed.activeLayer;
    if (coalesce) {
      // Live opacity drag: change directly, record a single undo step after a pause.
      const layer = this.ed.layer;
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

  private async rename() {
    const name = await textDialog('Rename layer', this.ed.layer.props.name);
    if (name && name.trim()) this.setProps({ name: name.trim().slice(0, 60) });
  }

  private merge() {
    this.ed.commitPending();
    const idx = this.ed.doc.indexOf(this.ed.activeLayer);
    if (idx <= 0) { this.ed.toast('No layer below to merge into'); return; }
    const below = this.ed.doc.layers[idx - 1].props.id;
    this.ed.apply({ t: 'layer.merge', id: uid(), layer: this.ed.activeLayer });
    this.ed.setActiveLayer(below);
  }

  private remove() {
    this.ed.commitPending();
    if (this.ed.doc.layers.length <= 1) { this.ed.apply({ t: 'layer.clear', id: uid(), layer: this.ed.activeLayer }); return; }
    this.ed.apply({ t: 'layer.remove', id: uid(), layer: this.ed.activeLayer });
  }

  render() {
    const doc = this.ed.doc;
    const rows = [...doc.layers].reverse().map((l) => this.row(l));
    this.list.replaceChildren(...rows);
    const p = this.ed.layer.props;
    this.blend.value = p.blend;
    if (!this.pendingOpacity) this.opacity.set(p.opacity);
    this.lockBtn.classList.toggle('on', p.alphaLock);
  }

  private row(l: Layer): HTMLElement {
    const p = l.props;
    const thumb = this.thumb(l);
    const vis = h('button.icon-btn.vis', {
      title: p.visible ? 'Hide layer' : 'Show layer', html: icon(p.visible ? 'eye' : 'eyeOff', 18),
      onclick: (e: Event) => { e.stopPropagation(); this.ed.apply({ t: 'layer.props', id: uid(), layer: p.id, props: { visible: !p.visible } }); },
    });
    const meta = [p.blend !== 'normal' ? BLEND_LABELS[p.blend] : '', p.opacity < 1 ? Math.round(p.opacity * 100) + '%' : '', p.alphaLock ? 'Locked α' : ''].filter(Boolean).join(' · ');
    const row = h(`div.layer-row${p.id === this.ed.activeLayer ? '.active' : ''}${p.visible ? '' : '.hidden-layer'}` as 'div', { 'data-id': p.id },
      h('div.layer-thumb', {}, thumb),
      h('div.layer-name', {}, h('div', {}, p.name), meta ? h('small', {}, meta) : null),
      vis,
    );
    row.addEventListener('pointerdown', (e) => this.dragStart(e, row, p.id));
    row.addEventListener('dblclick', () => this.rename());
    return row;
  }

  /** Tap selects a layer; dragging vertically reorders it. */
  private dragStart(e: PointerEvent, row: HTMLElement, id: string) {
    if ((e.target as HTMLElement).closest('.vis')) return;
    const y0 = e.clientY;
    let dragging = false;
    row.setPointerCapture(e.pointerId);
    const rows = [...this.list.children] as HTMLElement[];
    const from = rows.indexOf(row);
    let target = from;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      if (!dragging && Math.abs(dy) > 8) { dragging = true; row.classList.add('dragging'); }
      if (!dragging) return;
      row.style.transform = `translateY(${dy}px)`;
      const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
      target = rows.filter((r) => r !== row && r.getBoundingClientRect().top + r.offsetHeight / 2 < mid).length;
    };
    const up = () => {
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', up);
      row.removeEventListener('pointercancel', up);
      if (!dragging) { this.ed.setActiveLayer(id); return; }
      row.style.transform = '';
      row.classList.remove('dragging');
      if (target !== from) {
        // List is shown top-first; document order is bottom-first.
        const n = this.ed.doc.layers.length;
        this.ed.apply({ t: 'layer.move', id: uid(), layer: id, index: n - 1 - target });
      } else this.render();
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', up);
    row.addEventListener('pointercancel', up);
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

  private scheduleThumbs() {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => {
      for (const l of this.ed.doc.layers) {
        const c = this.thumbs.get(l.props.id);
        if (c) this.drawThumb(l, c);
      }
    }, 250);
  }

  private drawThumb(l: Layer, c: HTMLCanvasElement) {
    const s = this.ed.doc.settings;
    const area: Rect | null = s.infinite ? this.ed.doc.bounds() : { x: 0, y: 0, w: s.width, h: s.height };
    const ctx = ctx2d(c);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, THUMB, THUMB);
    if (!area) return;
    const k = Math.min(THUMB / area.w, THUMB / area.h);
    ctx.translate((THUMB - area.w * k) / 2, (THUMB - area.h * k) / 2);
    ctx.scale(k, k);
    ctx.translate(-area.x, -area.y);
    ctx.imageSmoothingQuality = 'high';
    l.surface.drawTo(ctx, area);
  }
}
