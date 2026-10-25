import { uid } from '../core/geom';
import { strokeFits } from '../shared/brush';
import type { TileSnapshot } from '../core/tiles';
import { SmudgeRenderer } from '../engine/smudge';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

/** Works on the layer in place; the tiles it touches are remembered so the stroke can be undone or dropped. */
export class SmudgeTool implements Tool {
  private renderer: SmudgeRenderer | null = null;
  private before: TileSnapshot | null = null;
  private pts: number[] = [];
  private len = 0;
  private layer = '';
  private mask: true | undefined;

  constructor(private ed: Editor) {}

  busy() { return !!this.renderer; }

  down(p: PointerInfo) {
    const layer = this.ed.paintableLayer();
    if (!layer) return;
    this.layer = layer.props.id;
    this.before = new Map();
    this.mask = this.ed.onMask;
    this.renderer = new SmudgeRenderer(this.ed.editSurface(layer), { ...this.ed.settings.smudge }, this.ed.selection ?? undefined, this.before);
    this.pts = [];
    this.len = 0;
    this.add(p);
  }

  move(p: PointerInfo) { if (this.renderer) this.add(p); }

  private add(p: PointerInfo) {
    // A very long stroke is committed in pieces, so none grows past what the room accepts.
    const x = round(p.x), y = round(p.y), pr = round(p.pressure);
    const n = this.pts.length;
    if (n) this.len += Math.hypot(x - this.pts[n - 3], y - this.pts[n - 2]);
    if (!strokeFits(n + 3, this.len, this.ed.settings.smudge.size, 0.8)) { this.up(); this.down(p); return; }
    this.pts.push(x, y, pr);
    const r = this.renderer!.add(x, y, pr);
    if (r) this.ed.view.invalidate(r);
  }

  up() {
    if (!this.renderer) return;
    const r = this.renderer.end();
    if (r) this.ed.view.invalidate(r);
    const before = this.before!;
    this.renderer = null;
    this.before = null;
    this.ed.apply({ t: 'smudge', id: uid(), layer: this.layer, brush: { ...this.ed.settings.smudge }, pts: this.pts, clip: this.ed.selection ?? undefined, mask: this.mask }, { applied: before });
  }

  cancel() {
    if (!this.renderer) return;
    const l = this.ed.doc.layer(this.layer);
    (this.mask ? l?.mask : l?.surface)?.restore(this.before!);
    this.renderer = null;
    this.before = null;
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
