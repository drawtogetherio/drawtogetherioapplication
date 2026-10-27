import type { DrawDoc } from '../core/document';
import { Rect, ctx2d } from '../core/geom';
import { TILE } from '../core/tiles';
import type { Editor } from '../editor';
import { composite } from '../engine/compositor';
import { h } from './dom';
import { icon } from './icons';
import { floating } from './float';

const W = 176, H = 120, REDRAW_MS = 500;

/** The whole drawing in a corner with the screen's window on it; drag the window to pan. */
export class Minimap {
  private canvas = h('canvas.minimap-img');
  private frame = h('div.minimap-frame');
  private reset = h('button.icon-btn.small', { type: 'button', title: 'Back to the corner', 'aria-label': 'Back to the corner', html: icon('undo', 12), hidden: true });
  private head = h('div.minimap-head', {}, h('span', {}, 'Map'), h('span.row', {}, this.reset,
    h('button.icon-btn.small', { type: 'button', title: 'Hide the minimap', 'aria-label': 'Hide the minimap', html: icon('x', 12) })));
  readonly el = h('div.minimap', { 'aria-label': 'Canvas overview' }, this.head, this.canvas, this.frame);
  private area: Rect | null = null;
  private timer = 0;

  constructor(private ed: Editor) {
    this.canvas.width = W * 2; this.canvas.height = H * 2;
    ed.on((w) => {
      if (w === 'doc' || w === 'layers' || w.startsWith('pixels:')) this.schedule();
      else if (w === 'view') this.place();
    });
    const win = floating(this.el, this.head, 'doodlehive.minimapPos', { onMove: (moved) => { this.reset.hidden = !moved; } });
    this.reset.onclick = () => win.reset();
    (this.head.lastElementChild!.lastElementChild as HTMLElement).onclick = () => { ed.prefs.minimap = false; this.el.hidden = true; ed.emit('prefs'); };
    let drag: { x: number; y: number } | null = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (this.head.contains(e.target as Node)) return;
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
      if (!this.frame.contains(e.target as Node)) this.centerAt(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!drag || !this.area) return;
      const s = this.scale();
      ed.view.viewport.cx += (e.clientX - drag.x) / s; ed.view.viewport.cy += (e.clientY - drag.y) / s;
      ed.view.viewport.onChange();
      drag = { x: e.clientX, y: e.clientY };
    });
    this.el.addEventListener('pointerup', () => { drag = null; });
    this.el.addEventListener('pointercancel', () => { drag = null; });
    this.schedule();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = 0; this.draw(); }, REDRAW_MS);
  }

  /** Screen pixels per document pixel on the map. */
  private scale() { return this.area ? Math.min(W / this.area.w, H / this.area.h) : 1; }

  private centerAt(e: PointerEvent) {
    if (!this.area) return;
    const r = this.canvas.getBoundingClientRect(), s = this.scale(), vp = this.ed.view.viewport;
    vp.cx = this.area.x + (e.clientX - r.left) / s; vp.cy = this.area.y + (e.clientY - r.top) / s;
    vp.onChange();
  }

  private draw() {
    const doc: DrawDoc = this.ed.doc, s = doc.settings;
    const b = s.infinite ? doc.bounds() : { x: 0, y: 0, w: s.width, h: s.height };
    this.el.classList.toggle('empty', !b);
    if (!b) { this.area = null; return; }
    // A margin so the window can sit past the drawing on unlimited canvases.
    const pad = s.infinite ? Math.max(b.w, b.h) * 0.15 : 0;
    this.area = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    const k = this.scale() * 2, c = this.canvas, ctx = ctx2d(c);
    c.width = Math.max(1, Math.round(this.area.w * k)); c.height = Math.max(1, Math.round(this.area.h * k));
    c.style.width = `${c.width / 2}px`; c.style.height = `${c.height / 2}px`;
    ctx.fillStyle = s.background ?? '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    // Compositing straight at map size keeps a 4K canvas cheap; tiles land on whole pixels so no seams show.
    const tp = Math.max(1, Math.floor(TILE * k)), kk = tp / TILE;
    ctx.setTransform(kk, 0, 0, kk, -this.area.x * kk, -this.area.y * kk);
    composite(ctx, doc, b, { paper: false });
    this.place();
  }

  /** Moves the window to where the view is; the app calls it when the view changes. */
  place() {
    const a = this.area;
    if (!a) return;
    const vp = this.ed.view.viewport, s = this.scale();
    const w = (vp.w / vp.zoom) * s, hh = (vp.h / vp.zoom) * s, f = this.frame.style;
    f.left = `${(vp.cx - a.x) * s - w / 2}px`; f.top = `${(vp.cy - a.y) * s - hh / 2}px`;
    f.width = `${w}px`; f.height = `${hh}px`;
    f.transform = `rotate(${-vp.rot}rad)`;
  }
}
