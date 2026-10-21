import { uid } from '../core/geom';
import type { TileSnapshot } from '../core/tiles';
import { SmudgeRenderer } from '../engine/smudge';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

/** Works on the layer in place; the tiles it touches are remembered so the stroke can be undone or dropped. */
export class SmudgeTool implements Tool {
  private renderer: SmudgeRenderer | null = null;
  private before: TileSnapshot | null = null;
  private pts: number[] = [];
  private layer = '';

  constructor(private ed: Editor) {}

  busy() { return !!this.renderer; }

  down(p: PointerInfo) {
    const layer = this.ed.paintableLayer();
    if (!layer) return;
    this.layer = layer.props.id;
    this.before = new Map();
    this.renderer = new SmudgeRenderer(layer.surface, { ...this.ed.settings.smudge }, this.ed.selection?.pts, this.before);
    this.pts = [];
    this.add(p);
  }

  move(p: PointerInfo) { if (this.renderer) this.add(p); }

  private add(p: PointerInfo) {
    const x = round(p.x), y = round(p.y), pr = round(p.pressure);
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
    this.ed.apply({ t: 'smudge', id: uid(), layer: this.layer, brush: { ...this.ed.settings.smudge }, pts: this.pts, clip: this.ed.selection ?? undefined }, { applied: before });
  }

  cancel() {
    if (!this.renderer) return;
    this.ed.doc.layer(this.layer)?.surface.restore(this.before!);
    this.renderer = null;
    this.before = null;
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
