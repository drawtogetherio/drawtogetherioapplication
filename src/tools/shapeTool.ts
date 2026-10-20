import { rectUnion, uid } from '../core/geom';
import { TiledSurface } from '../core/tiles';
import { ShapeSpec, renderShape, shapeBounds } from '../engine/shapes';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

/** Line, rectangle and ellipse. Shift constrains (square / circle / 45° lines), Alt draws from the centre. */
export class ShapeTool implements Tool {
  private start: { x: number; y: number } | null = null;
  private spec: ShapeSpec | null = null;

  constructor(private ed: Editor) {}

  busy() { return !!this.start; }

  down(p: PointerInfo) {
    if (!this.ed.paintableLayer()) return;
    this.start = { x: p.x, y: p.y };
    this.update(p);
  }

  move(p: PointerInfo) { if (this.start) this.update(p); }

  private update(p: PointerInfo) {
    const s = this.start!, st = this.ed.settings, b = this.ed.settings.brush;
    let x1 = p.x, y1 = p.y;
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
    const old = this.spec ? shapeBounds(this.spec) : null;
    this.spec = { shape: st.shape, x0, y0, x1, y1, width: b.size, fill: st.shapeFill, color: this.ed.color };
    const buffer = new TiledSurface();
    const r = renderShape(buffer, this.spec);
    const layer = this.ed.layer!;
    this.ed.view.live = {
      layerId: layer.props.id, buffer, bufferAlpha: b.opacity,
      bufferOp: layer.props.alphaLock ? 'source-atop' : 'source-over', clip: this.ed.clipPath(),
    };
    this.ed.view.invalidate(rectUnion(old, r));
  }

  up() {
    if (!this.start || !this.spec) return;
    const spec = this.spec, buffer = this.ed.view.live?.buffer;
    this.start = null; this.spec = null;
    this.ed.view.live = null;
    if (Math.hypot(spec.x1 - spec.x0, spec.y1 - spec.y0) < 1) { this.ed.view.invalidate(shapeBounds(spec)); return; }
    this.ed.pushRecent(spec.color);
    this.ed.apply({
      t: 'shape', id: uid(), layer: this.ed.activeLayer, ...spec, opacity: this.ed.settings.brush.opacity,
      erase: false, clip: this.ed.selection ?? undefined,
    }, { buffer });
  }

  cancel() {
    if (!this.start) return;
    this.start = null; this.spec = null;
    this.ed.view.live = null;
    this.ed.view.invalidate(null);
  }
}
