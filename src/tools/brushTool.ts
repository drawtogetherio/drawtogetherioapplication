import { uid } from '../core/geom';
import { TiledSurface } from '../core/tiles';
import { StrokeRenderer } from '../engine/brush';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

/** Brush and eraser. Dabs go into a stroke buffer shown live, then the stroke is committed as one op. */
export class BrushTool implements Tool {
  private buffer: TiledSurface | null = null;
  private renderer: StrokeRenderer | null = null;
  private pts: number[] = [];

  constructor(private ed: Editor, private erase: boolean) {}

  private get params() { return this.erase ? this.ed.settings.eraser : this.ed.settings.brush; }

  busy() { return !!this.buffer; }

  down(p: PointerInfo) {
    const layer = this.ed.layer;
    if (!layer.props.visible) { this.ed.toast('This layer is hidden'); return; }
    const params = { ...this.params };
    this.buffer = new TiledSurface();
    this.renderer = new StrokeRenderer(this.buffer, params, this.erase ? '#000000' : this.ed.color);
    this.pts = [];
    this.ed.view.live = {
      layerId: layer.props.id, buffer: this.buffer, bufferAlpha: params.opacity,
      bufferOp: this.erase ? 'destination-out' : layer.props.alphaLock ? 'source-atop' : 'source-over',
      clip: this.ed.clipPath(),
    };
    this.add(p);
  }

  move(p: PointerInfo) { if (this.buffer) this.add(p); }

  private add(p: PointerInfo) {
    // Store rounded samples and render exactly those, so a replay of the op is pixel-identical.
    const x = round(p.x), y = round(p.y), pr = round(p.pressure);
    this.pts.push(x, y, pr);
    const r = this.renderer!.add(x, y, pr);
    if (r) this.ed.view.invalidate(r);
  }

  up() {
    if (!this.buffer) return;
    const r = this.renderer!.end();
    if (r) this.ed.view.invalidate(r);
    const buffer = this.buffer;
    const brush = { ...this.params };
    this.ed.view.live = null;
    this.buffer = null;
    if (!this.erase) this.ed.pushRecent(this.ed.color);
    this.ed.apply({
      t: 'stroke', id: uid(), layer: this.ed.activeLayer, erase: this.erase, brush,
      color: this.erase ? '#000000' : this.ed.color, pts: this.pts, clip: this.ed.selection ?? undefined,
    }, { buffer });
  }

  cancel() {
    if (!this.buffer) return;
    this.buffer = null;
    this.ed.view.live = null;
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
