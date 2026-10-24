import { dist, rectFromPoints, rectIntersect, rectRoundOut, uid } from '../core/geom';
import type { Editor } from '../editor';
import { fillRegion } from './fillTool';
import { drawAnts } from './selectTool';
import { PointerInfo, Tool } from './tool';

/** Draws a lasso and fills it; with "inside lines" on, only the parts the artwork's lines close off. */
export class LassoFillTool implements Tool {
  private pts: number[] | null = null;

  constructor(private ed: Editor) {}

  busy() { return !!this.pts; }

  down(p: PointerInfo) {
    if (!this.ed.paintableLayer()) return;
    this.pts = [p.x, p.y];
  }

  move(p: PointerInfo) {
    const pts = this.pts;
    if (!pts) return;
    const n = pts.length;
    if (dist(pts[n - 2], pts[n - 1], p.x, p.y) * this.ed.view.viewport.zoom > 2) pts.push(p.x, p.y);
    this.ed.view.requestRender();
  }

  up() {
    const pts = this.pts, ed = this.ed, st = ed.settings;
    if (!pts) return;
    this.pts = null;
    ed.view.requestRender();
    if (pts.length < 6) return;
    const box = rectRoundOut(rectFromPoints(pts)!, st.fillExpand + 1);
    const region = rectIntersect(box, fillRegion(ed, box.x + box.w / 2, box.y + box.h / 2));
    if (!region || region.w < 1 || region.h < 1) return;
    ed.pushRecent(ed.color);
    ed.apply({
      t: 'fillPoly', id: uid(), layer: ed.activeLayer, pts: pts.map((v) => Math.round(v * 100) / 100), color: ed.color, inside: st.lassoInside,
      tolerance: st.fillTolerance, sampleAll: st.fillSampleAll, expand: st.fillExpand, region, clip: ed.selection ?? undefined, mask: ed.onMask,
    });
  }

  cancel() { this.pts = null; this.ed.view.requestRender(); }

  overlay(ctx: CanvasRenderingContext2D, M: DOMMatrix) {
    if (this.pts) drawAnts(ctx, M, this.pts, 0, true);
  }
}
