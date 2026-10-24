import { uid } from '../core/geom';
import { MAX_STROKE_PTS } from '../shared/brush';
import { TiledSurface } from '../core/tiles';
import { StrokeRenderer } from '../engine/brush';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

export class BrushTool implements Tool {
  private buffer: TiledSurface | null = null;
  private renderer: StrokeRenderer | null = null;
  private pts: number[] = [];
  private id = '';
  private sent = 0; // samples already streamed to the room
  private flushTimer = 0;
  /** With the stabilizer on: where the brush is, and the cursor pulling it. */
  tether: { bx: number; by: number; cx: number; cy: number } | null = null;

  constructor(private ed: Editor, private erase: boolean) {}

  private get params() { return this.erase ? this.ed.settings.eraser : this.ed.settings.brush; }

  busy() { return !!this.buffer; }
  pen() { return this.tether ? { x: this.tether.bx, y: this.tether.by } : null; }

  down(p: PointerInfo) {
    const layer = this.ed.paintableLayer();
    if (!layer) return;
    const params = { ...this.params };
    this.id = uid();
    this.sent = 0;
    this.buffer = new TiledSurface();
    this.renderer = new StrokeRenderer(this.buffer, params, this.erase ? '#000000' : this.ed.color);
    this.pts = [];
    this.tether = null;
    this.ed.view.live = {
      layerId: layer.props.id, buffer: this.buffer, bufferAlpha: params.opacity,
      bufferOp: this.erase ? 'destination-out' : layer.props.alphaLock && !this.ed.onMask ? 'source-atop' : 'source-over',
      clip: this.ed.clipPath(), mask: this.ed.onMask,
    };
    this.add(p);
  }

  move(p: PointerInfo) {
    if (!this.buffer) return;
    this.add(this.pull(p));
    // The rope moves even when the brush doesn't.
    if (this.tether) this.ed.view.requestRender();
  }

  /** The brush trails the cursor on a rope: it only moves once the rope is taut. */
  private pull(p: PointerInfo): PointerInfo {
    const pf = this.ed.prefs, L = pf.stabilizerOn ? (pf.stabilizer * ROPE_MAX) / this.ed.view.viewport.zoom : 0;
    if (!L) return p;
    const t = this.tether ?? (this.tether = { bx: p.x, by: p.y, cx: p.x, cy: p.y });
    t.cx = p.x; t.cy = p.y;
    const dx = p.x - t.bx, dy = p.y - t.by, d = Math.hypot(dx, dy);
    if (d > L) { t.bx += (dx / d) * (d - L); t.by += (dy / d) * (d - L); }
    return { ...p, x: t.bx, y: t.by };
  }

  private add(p: PointerInfo) {
    // A very long stroke is committed in pieces, so none grows past what the room accepts.
    if (this.pts.length >= MAX_STROKE_PTS) { this.up(); this.down(p); return; }
    // Rounded samples are what gets rendered, so a replay matches exactly.
    const x = round(p.x), y = round(p.y), pr = round(p.pressure);
    this.pts.push(x, y, pr);
    const r = this.renderer!.add(x, y, pr);
    if (r) this.ed.view.invalidate(r);
    if (this.ed.room && !this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), 33);
  }

  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    const room = this.ed.room;
    if (!room || this.sent >= this.pts.length) return;
    room.send({ type: 'live', live: {
      stroke: this.id, layer: this.ed.activeLayer, erase: this.erase, brush: this.params, color: this.erase ? '#000000' : this.ed.color,
      clip: this.ed.selection ?? undefined, mask: this.ed.onMask, pts: this.pts.slice(this.sent),
    } });
    this.sent = this.pts.length;
  }

  up() {
    if (!this.buffer) return;
    // The line ends where the brush is, not where the cursor was.
    this.tether = null;
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
      color: this.erase ? '#000000' : this.ed.color, pts: this.pts, clip: this.ed.selection ?? undefined, mask: this.ed.onMask,
    }, { buffer });
  }

  cancel() {
    if (!this.buffer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    this.ed.room?.send({ type: 'live-end', stroke: this.id });
    this.buffer = null;
    this.tether = null;
    this.ed.view.live = null;
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
/** Rope length in screen px at the stabilizer's maximum. */
const ROPE_MAX = 160;
