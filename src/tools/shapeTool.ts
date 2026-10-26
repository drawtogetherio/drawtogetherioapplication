import { Rect, rectUnion, uid } from '../core/geom';
import { POINT_SHAPES, type Op } from '../core/model';
import { TiledSurface } from '../core/tiles';
import { ShapeSpec, mapShape, renderShape, shapeBounds } from '../engine/shapes';
import type { Editor } from '../editor';
import { snap, symmetryMaps } from '../ui/guides';
import { PointerInfo, Tool } from './tool';

/** Drag a box for most shapes; click points for a polyline, curve or arc and double-click, Enter or the Done button to finish. */
export class ShapeTool implements Tool {
  private start: { x: number; y: number } | null = null;
  private spec: ShapeSpec | null = null;
  private copies: { spec: ShapeSpec; buffer: TiledSurface }[] = [];
  /** The points placed so far for a point shape; the last one follows the pointer while it is down. */
  private pts: number[] | null = null;
  private lastDown = { t: 0, x: 0, y: 0 };

  constructor(private ed: Editor) {}

  busy() { return !!this.start || !!this.pts; }
  get placing() { return !!this.pts; }

  down(p: PointerInfo) {
    if (!this.ed.paintableLayer()) return;
    const s = snap(this.ed, p.x, p.y);
    if (POINT_SHAPES.includes(this.ed.settings.shape)) {
      const dbl = performance.now() - this.lastDown.t < 400 && Math.hypot(p.sx - this.lastDown.x, p.sy - this.lastDown.y) < 6;
      this.lastDown = { t: performance.now(), x: p.sx, y: p.sy };
      const pts = this.pts, rx = round(s.x), ry = round(s.y);
      if (dbl && pts) { this.commit(); return; }
      if (!pts) { this.pts = [rx, ry, rx, ry]; this.start = s; this.render(this.pts); return; }
      // The last point was following the pointer; it is fixed now.
      pts[pts.length - 2] = rx; pts[pts.length - 1] = ry;
      const fixed = pts.length / 2, arc = this.ed.settings.shape === 'arc';
      if (arc ? fixed === 3 : fixed >= 3 && Math.hypot(s.x - pts[0], s.y - pts[1]) * this.ed.view.viewport.zoom < 10) {
        // Three points make the arc; clicking the first point closes a polyline or curve.
        if (!arc) { pts[pts.length - 2] = pts[0]; pts[pts.length - 1] = pts[1]; }
        this.render(pts); this.finish(false); return;
      }
      pts.push(rx, ry);
      this.start = s;
      this.render(pts);
      return;
    }
    this.start = s;
    this.update(p);
  }

  move(p: PointerInfo) {
    if (!this.start) return;
    if (this.pts) { const s = snap(this.ed, p.x, p.y); this.pts[this.pts.length - 2] = round(s.x); this.pts[this.pts.length - 1] = round(s.y); this.render(this.pts); }
    else this.update(p);
  }

  private update(p: PointerInfo) {
    const s = this.start!, st = this.ed.settings, sp = snap(this.ed, p.x, p.y);
    let x1 = sp.x, y1 = sp.y;
    let x0 = s.x, y0 = s.y;
    if (p.shift) {
      const dx = x1 - x0, dy = y1 - y0;
      if (st.shape === 'line' || st.shape === 'arrow') {
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x1 = x0 + Math.cos(a) * len; y1 = y0 + Math.sin(a) * len;
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = x0 + Math.sign(dx || 1) * m; y1 = y0 + Math.sign(dy || 1) * m;
      }
    }
    if (p.alt) { x0 = s.x - (x1 - s.x); y0 = s.y - (y1 - s.y); }
    this.render(null, { x0, y0, x1, y1 });
  }

  /** Draws the live shape (and its symmetry copies) from points or a box. */
  private render(pts: number[] | null, box = { x0: 0, y0: 0, x1: 0, y1: 0 }) {
    const st = this.ed.settings, b = st.brush;
    let old = this.spec ? shapeBounds(this.spec) : null;
    for (const c of this.copies) old = rectUnion(old, shapeBounds(c.spec));
    this.spec = { shape: st.shape, ...box, width: b.size, fill: st.shapeFill, color: this.ed.color, sides: st.shape === 'polygon' || st.shape === 'star' ? st.shapeSides : undefined, pts: pts ? [...pts] : undefined };
    if (st.shape === 'arc' && pts && pts.length < 6) this.spec = { ...this.spec, shape: 'polyline' };
    const buffer = new TiledSurface();
    let r: Rect | null = renderShape(buffer, this.spec);
    const layer = this.ed.layer!;
    const live = (buffer: TiledSurface) => ({
      layerId: layer.props.id, buffer, bufferAlpha: b.opacity,
      bufferOp: layer.props.alphaLock && !this.ed.onMask ? 'source-atop' : 'source-over', clip: this.ed.clipPath(), mask: this.ed.onMask,
    } as const);
    this.ed.view.live = live(buffer);
    this.copies = [];
    for (const m of symmetryMaps(this.ed)) {
      const spec = mapShape(m, this.spec);
      if (!spec) continue;
      const buf = new TiledSurface();
      r = rectUnion(r, renderShape(buf, spec));
      this.copies.push({ spec, buffer: buf });
    }
    this.ed.view.extraLive = this.copies.map((c) => live(c.buffer));
    this.ed.view.invalidate(rectUnion(old, r));
  }

  up() {
    if (!this.start || !this.spec) return;
    this.start = null;
    if (this.pts) return;
    const spec = this.spec;
    if (Math.hypot(spec.x1 - spec.x0, spec.y1 - spec.y0) < 1) { this.cancel(); return; }
    this.finish(false);
  }

  /** Finishes the shape being drawn or placed; a point still following the pointer is dropped. */
  commit() { this.finish(!!this.pts && !this.start); }

  private finish(dropLast: boolean) {
    if (dropLast && this.pts) { this.pts.splice(-2, 2); this.render(this.pts); }
    const spec = this.spec, buffer = this.ed.view.live?.buffer, copies = this.copies;
    this.start = null; this.spec = null; this.copies = []; this.pts = null;
    this.ed.view.live = null;
    this.ed.view.extraLive = [];
    if (!spec || !buffer || (spec.pts && spec.pts.length < 4)) { this.ed.view.invalidate(null); return; }
    this.ed.pushRecent(spec.color);
    const op = (sp: ShapeSpec): Op => ({
      t: 'shape', id: uid(), layer: this.ed.activeLayer, ...sp, opacity: this.ed.settings.brush.opacity,
      erase: false, clip: this.ed.selection ?? undefined, mask: this.ed.onMask,
    });
    this.ed.run([op(spec), ...copies.map((c) => op(c.spec))], 'shape', [{ buffer }, ...copies.map((c) => ({ buffer: c.buffer }))]);
  }

  cancel() {
    if (!this.start && !this.pts) return;
    this.start = null; this.spec = null; this.copies = []; this.pts = null;
    this.ed.view.live = null;
    this.ed.view.extraLive = [];
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
