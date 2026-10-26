import { Rect, rectFromPoints, rectIntersect, uid } from '../core/geom';
import type { Op } from '../core/model';
import { TiledSurface } from '../core/tiles';
import { renderGradient } from '../engine/gradient';
import type { Editor } from '../editor';
import { fillRegion } from './fillTool';
import { PointerInfo, Tool } from './tool';

/** Drag to lay a gradient across the selection, or the whole canvas. */
export class GradientTool implements Tool {
  private start: { x: number; y: number } | null = null;
  private region: Rect | null = null;
  private spec: Op & { t: 'gradient' } | null = null;

  constructor(private ed: Editor) {}

  busy() { return !!this.start; }

  down(p: PointerInfo) {
    if (!this.ed.paintableLayer()) return;
    const ed = this.ed, sel = ed.selection;
    let region = fillRegion(ed, p.x, p.y);
    if (sel) region = rectIntersect(region, rectFromPoints(sel.pts, 1)!) ?? region;
    this.region = region;
    this.start = { x: p.x, y: p.y };
    this.update(p);
  }

  move(p: PointerInfo) { if (this.start) this.update(p); }

  private update(p: PointerInfo) {
    const ed = this.ed, st = ed.settings, s = this.start!, layer = ed.layer!;
    let x1 = p.x, y1 = p.y;
    if (p.shift) { const a = Math.round(Math.atan2(y1 - s.y, x1 - s.x) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(x1 - s.x, y1 - s.y); x1 = s.x + Math.cos(a) * l; y1 = s.y + Math.sin(a) * l; }
    const r = (v: number) => Math.round(v * 100) / 100;
    const end = st.gradientEnd;
    this.spec = {
      t: 'gradient', id: uid(), layer: ed.activeLayer, kind: st.gradientKind, x0: r(s.x), y0: r(s.y), x1: r(x1), y1: r(y1),
      stops: [{ at: 0, color: ed.color, alpha: st.gradientAlpha }, { at: 1, color: end ?? ed.color, alpha: end ? st.gradientAlpha : 0 }],
      opacity: 1, region: this.region!, clip: ed.selection ?? undefined, mask: ed.onMask,
    };
    const buffer = new TiledSurface();
    renderGradient(buffer, this.spec);
    ed.view.live = {
      layerId: layer.props.id, buffer, bufferAlpha: 1,
      bufferOp: layer.props.alphaLock && !ed.onMask ? 'source-atop' : 'source-over', clip: ed.clipPath(), clipMask: ed.clipMask(), mask: ed.onMask,
    };
    ed.view.invalidate(this.region);
  }

  up() {
    const spec = this.spec, buffer = this.ed.view.live?.buffer;
    if (!this.start || !spec || !buffer) return;
    this.start = null; this.spec = null;
    this.ed.view.live = null;
    if (Math.hypot(spec.x1 - spec.x0, spec.y1 - spec.y0) < 1) { this.ed.view.invalidate(null); return; }
    this.ed.pushRecent(this.ed.color);
    this.ed.run([spec], 'gradient', { buffer });
  }

  cancel() {
    if (!this.start) return;
    this.start = null; this.spec = null;
    this.ed.view.live = null;
    this.ed.view.invalidate(null);
  }
}
