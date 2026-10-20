import { rectContains, rectIntersect, rectUnion, uid } from '../core/geom';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

const MAX_FILL = 8192;

export class FillTool implements Tool {
  constructor(private ed: Editor) {}

  down() {}
  move() {}
  cancel() {}

  up(p: PointerInfo) {
    const ed = this.ed, doc = ed.doc, st = ed.settings;
    if (!ed.layer.props.visible) { ed.toast('This layer is hidden'); return; }
    let region = ed.workArea();
    if (doc.settings.infinite) {
      // Unlimited canvas: fill within the visible area plus existing artwork, capped in size.
      region = rectUnion(region, doc.bounds())!;
      const cap = { x: Math.floor(p.x - MAX_FILL / 2), y: Math.floor(p.y - MAX_FILL / 2), w: MAX_FILL, h: MAX_FILL };
      region = rectIntersect(region, cap) ?? region;
    }
    if (!rectContains(region, p.x, p.y)) return;
    ed.pushRecent(ed.color);
    ed.apply({
      t: 'fill', id: uid(), layer: ed.activeLayer, x: Math.floor(p.x), y: Math.floor(p.y), color: ed.color,
      tolerance: st.fillTolerance, sampleAll: st.fillSampleAll, expand: st.fillExpand, region,
      clip: ed.selection ?? undefined,
    });
  }
}
