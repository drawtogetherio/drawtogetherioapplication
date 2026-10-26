import { Rect, rectContains, rectIntersect, rectUnion, uid } from '../core/geom';
import type { Editor } from '../editor';
import type { Op } from '../core/model';
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
export async function applyFill(ed: Editor, op: Extract<Op, { t: 'fill' | 'fillPoly' }>) {
  const doc = ed.doc, room = ed.room;
  if (room) room.freeze = true;
  try {
    const fill = await doc.prepareFill(op);
    if (ed.doc === doc && fill) ed.apply(op, { fill });
  } finally { if (room) room.freeze = false; }
}

/** The bucket, or in lasso mode the fill lasso. */
export class FillTool implements Tool {
  private lasso: LassoFillTool;
  private pending = false;

  constructor(private ed: Editor) { this.lasso = new LassoFillTool(ed); }

  private get isLasso() { return this.ed.settings.fillMode === 'lasso'; }
  busy() { return this.lasso.busy(); }
  down(p: PointerInfo) { if (this.isLasso) this.lasso.down(p); }
  move(p: PointerInfo) { this.lasso.move(p); }
  cancel() { this.lasso.cancel(); }
  overlay(ctx: CanvasRenderingContext2D, M: DOMMatrix) { this.lasso.overlay(ctx, M); }

  up(p: PointerInfo) {
    const ed = this.ed, st = ed.settings;
    if (this.isLasso) { this.lasso.up(); return; }
    if (!ed.paintableLayer()) return;
    const region = fillRegion(ed, p.x, p.y);
    if (!rectContains(region, p.x, p.y)) return;
    if (this.pending) return;
    ed.pushRecent(ed.color);
    this.pending = true;
    applyFill(ed, {
      t: 'fill', id: uid(), layer: ed.activeLayer, x: Math.floor(p.x), y: Math.floor(p.y), color: ed.color,
      tolerance: st.fillTolerance, sampleAll: st.fillSampleAll, expand: st.fillExpand, region,
      clip: ed.selection ?? undefined, mask: ed.onMask,
    }).finally(() => { this.pending = false; });
  }
}
