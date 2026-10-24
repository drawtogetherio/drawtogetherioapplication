import { Rect, rectContains, rectIntersect, rectUnion, uid } from '../core/geom';
import type { Editor } from '../editor';
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

export class FillTool implements Tool {
  constructor(private ed: Editor) {}

  down() {}
  move() {}
  cancel() {}

  up(p: PointerInfo) {
    const ed = this.ed, st = ed.settings;
    if (!ed.paintableLayer()) return;
    const region = fillRegion(ed, p.x, p.y);
    if (!rectContains(region, p.x, p.y)) return;
    ed.pushRecent(ed.color);
    ed.apply({
      t: 'fill', id: uid(), layer: ed.activeLayer, x: Math.floor(p.x), y: Math.floor(p.y), color: ed.color,
      tolerance: st.fillTolerance, sampleAll: st.fillSampleAll, expand: st.fillExpand, region,
      clip: ed.selection ?? undefined, mask: ed.onMask,
    });
  }
}
