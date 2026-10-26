import { Rect, rectUnion, uid } from '../core/geom';
import { TiledSurface } from '../core/tiles';
import { ShapeSpec, renderShape, shapeBounds } from '../engine/shapes';
import type { Editor } from '../editor';
import { snap, symmetryMaps } from '../ui/guides';
import type { Op } from '../core/model';
import { PointerInfo, Tool } from './tool';

export class ShapeTool implements Tool {
  private start: { x: number; y: number } | null = null;
  private spec: ShapeSpec | null = null;
  private copies: { m: DOMMatrix; spec: ShapeSpec; buffer: TiledSurface }[] = [];

  constructor(private ed: Editor) {}

  busy() { return !!this.start; }

  down(p: PointerInfo) {
    if (!this.ed.paintableLayer()) return;
    this.start = snap(this.ed, p.x, p.y);
    this.update(p);
  }

  move(p: PointerInfo) { if (this.start) this.update(p); }

  private update(p: PointerInfo) {
    const s = this.start!, st = this.ed.settings, b = this.ed.settings.brush, sp = snap(this.ed, p.x, p.y);
    let x1 = sp.x, y1 = sp.y;
    let x0 = s.x, y0 = s.y;
    if (p.shift) {
      const dx = x1 - x0, dy = y1 - y0;
      if (st.shape === 'line') {
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x1 = x0 + Math.cos(a) * len; y1 = y0 + Math.sin(a) * len;
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = x0 + Math.sign(dx || 1) * m; y1 = y0 + Math.sign(dy || 1) * m;
      }
    }
    if (p.alt) { x0 = s.x - (x1 - s.x); y0 = s.y - (y1 - s.y); }
    let old = this.spec ? shapeBounds(this.spec) : null;
    for (const c of this.copies) old = rectUnion(old, shapeBounds(c.spec));
    this.spec = { shape: st.shape, x0, y0, x1, y1, width: b.size, fill: st.shapeFill, color: this.ed.color };
    const buffer = new TiledSurface();
    let r: Rect | null = renderShape(buffer, this.spec);
    const layer = this.ed.layer!;
    const live = (buffer: TiledSurface) => ({
      layerId: layer.props.id, buffer, bufferAlpha: b.opacity,
      bufferOp: layer.props.alphaLock && !this.ed.onMask ? 'source-atop' : 'source-over', clip: this.ed.clipPath(), mask: this.ed.onMask,
    } as const);
    this.ed.view.live = live(buffer);
    // Mirrored boxes stay boxes; turned ones (radial) only for lines, which have no box to keep upright.
    this.copies = symmetryMaps(this.ed).filter((m) => st.shape === 'line' || (Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9)).map((m) => {
      const a = m.transformPoint({ x: x0, y: y0 }), z = m.transformPoint({ x: x1, y: y1 });
      const spec = { ...this.spec!, x0: round(a.x), y0: round(a.y), x1: round(z.x), y1: round(z.y) }, buf = new TiledSurface();
      r = rectUnion(r, renderShape(buf, spec));
      return { m, spec, buffer: buf };
    });
    this.ed.view.extraLive = this.copies.map((c) => live(c.buffer));
    this.ed.view.invalidate(rectUnion(old, r));
  }

  up() {
    if (!this.start || !this.spec) return;
    const spec = this.spec, buffer = this.ed.view.live?.buffer, copies = this.copies;
    this.start = null; this.spec = null; this.copies = [];
    this.ed.view.live = null;
    this.ed.view.extraLive = [];
    if (Math.hypot(spec.x1 - spec.x0, spec.y1 - spec.y0) < 1) { this.ed.view.invalidate(null); return; }
    this.ed.pushRecent(spec.color);
    const op = (sp: ShapeSpec): Op => ({
      t: 'shape', id: uid(), layer: this.ed.activeLayer, ...sp, opacity: this.ed.settings.brush.opacity,
      erase: false, clip: this.ed.selection ?? undefined, mask: this.ed.onMask,
    });
    this.ed.run([op(spec), ...copies.map((c) => op(c.spec))], 'shape', [{ buffer }, ...copies.map((c) => ({ buffer: c.buffer }))]);
  }

  cancel() {
    if (!this.start) return;
    this.start = null; this.spec = null; this.copies = [];
    this.ed.view.live = null;
    this.ed.view.extraLive = [];
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
