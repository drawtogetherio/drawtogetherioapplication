import { Rect, rectContains, rectIntersect, rectUnion, uid } from '../core/geom';
import type { Editor } from '../editor';
import { GradientTool } from './gradientTool';
import { LassoFillTool } from './lassoFillTool';
import { PointerInfo, Tool } from './tool';

const MAX_FILL = 8192;

/** Where a fill around (x, y) may reach: the canvas, or on an unlimited one the view plus the artwork, capped in size. */
export function fillRegion(ed: Editor, x: number, y: number): Rect {
  let region = ed.workArea();
  if (ed.doc.settings.infinite) {
    region = rectUnion(region, ed.doc.bounds())!;
    const cap = { x: Math.floor(x - MAX_FILL / 2), y: Math.floor(y - MAX_FILL / 2), w: MAX_FILL, h: MAX_FILL };
    region = rectIntersect(region, cap) ?? region;
  }
  return region;
}

/** Works the fill out in the worker first, so the pen never waits; the op lands when it's ready. */
/** The bucket, or in lasso mode the fill lasso. */
export class FillTool implements Tool {
  private lasso: LassoFillTool;
  private gradient: GradientTool;
  private pending = false;

  constructor(private ed: Editor) { this.lasso = new LassoFillTool(ed); this.gradient = new GradientTool(ed); }

  /** The drag tool for the current mode; the bucket itself works on release. */
  private get sub() { const m = this.ed.settings.fillMode; return m === 'lasso' ? this.lasso : m === 'gradient' ? this.gradient : null; }
  busy() { return this.lasso.busy() || this.gradient.busy(); }
  down(p: PointerInfo) { this.sub?.down(p); }
  move(p: PointerInfo) { this.lasso.move(p); this.gradient.move(p); }
  cancel() { this.lasso.cancel(); this.gradient.cancel(); }
  overlay(ctx: CanvasRenderingContext2D, M: DOMMatrix) { this.lasso.overlay(ctx, M); }

  up(p: PointerInfo) {
    const sub = this.sub;
    if (sub) { sub.up(); return; }
    this.bucket(p.x, p.y);
  }

  /** A bucket fill at a document point with the current colour, whatever the fill mode (also the colour drop). */
  bucket(x: number, y: number): boolean {
    const ed = this.ed, st = ed.settings;
    if (ed.readOnly || !ed.paintableLayer()) return false;
    const region = fillRegion(ed, x, y);
    if (!rectContains(region, x, y)) return false;
    if (this.pending) return false;
    ed.pushRecent(ed.color);
    this.pending = true;
    ed.applyPrepared({
      t: 'fill', id: uid(), layer: ed.activeLayer, x: Math.floor(x), y: Math.floor(y), color: ed.color,
      tolerance: st.fillTolerance, sampleAll: st.fillSampleAll, sampleLayer: ed.sampleLayer(), expand: st.fillExpand, region,
      clip: ed.selection ?? undefined, mask: ed.onMask,
    }).finally(() => { this.pending = false; });
    return true;
  }
}
