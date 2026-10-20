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
  private id = '';
  private sent = 0; // samples already streamed to the room
  private flushTimer = 0;

  constructor(private ed: Editor, private erase: boolean) {}

  private get params() { return this.erase ? this.ed.settings.eraser : this.ed.settings.brush; }

  busy() { return !!this.buffer; }

  down(p: PointerInfo) {
    const layer = this.ed.paintableLayer();
    if (!layer) return;
    const params = { ...this.params };
    this.id = uid();
    this.sent = 0;
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
    if (this.ed.room && !this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), 33);
  }

  /** Stream new samples so others see the stroke while it is drawn. */
  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    const room = this.ed.room;
    if (!room || this.sent >= this.pts.length) return;
    room.send({ type: 'live', live: {
      stroke: this.id, layer: this.ed.activeLayer, erase: this.erase, brush: this.params, color: this.erase ? '#000000' : this.ed.color,
      clip: this.ed.selection ?? undefined, pts: this.pts.slice(this.sent),
    } });
    this.sent = this.pts.length;
  }

  up() {
    if (!this.buffer) return;
    const r = this.renderer!.end();
    if (r) this.ed.view.invalidate(r);
    this.flush();
    const buffer = this.buffer;
    const brush = { ...this.params };
    this.ed.view.live = null;
    this.buffer = null;
    if (!this.erase) this.ed.pushRecent(this.ed.color);
    this.ed.apply({
      t: 'stroke', id: this.id, layer: this.ed.activeLayer, erase: this.erase, brush,
      color: this.erase ? '#000000' : this.ed.color, pts: this.pts, clip: this.ed.selection ?? undefined,
    }, { buffer });
  }

  cancel() {
    if (!this.buffer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    this.ed.room?.send({ type: 'live-end', stroke: this.id });
    this.buffer = null;
    this.ed.view.live = null;
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
