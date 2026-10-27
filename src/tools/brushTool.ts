import { uid } from '../core/geom';
import { CANVAS_LOG, clog, resetStrokeStats, strokeStats } from '../debug/canvasLog';
import type { Op } from '../core/model';
import { strokeFits } from '../shared/brush';
import { brushAssets } from '../shared/brushAssets';
import { uploadAssets } from '../engine/brushAssets';
import { TiledSurface } from '../core/tiles';
import { StrokeRenderer } from '../engine/brush';
import { recognizeShape } from '../engine/quickShape';
import { ShapeSpec, mapShape, renderShape } from '../engine/shapes';
import type { Editor } from '../editor';
import { mapPts, symmetryMaps } from '../ui/guides';
import { PointerInfo, Tool } from './tool';

export class BrushTool implements Tool {
  private buffer: TiledSurface | null = null;
  /** The freehand stroke's own pixels, kept while a QuickShape stands in for it. */
  get stroke() { return this.buffer; }
  private renderer: StrokeRenderer | null = null;
  private pts: number[] = [];
  private tilt: number[] = [];
  private len = 0;
  private id = '';
  private sent = 0; // samples already streamed to the room
  private flushTimer = 0;
  /** With the stabilizer on: where the brush is, and the cursor pulling it. */
  tether: { bx: number; by: number; cx: number; cy: number } | null = null;
  /** The browser's guess at the next few samples, drawn ahead of the real line and replaced as it arrives. */
  private ahead: PointerInfo[] = [];
  /** Symmetry copies: each has its own buffer and renderer, and becomes its own stroke op. */
  private mirrors: { m: DOMMatrix; buffer: TiledSurface; renderer: StrokeRenderer; id: string; sent: number }[] = [];
  /** QuickShape: the stroke snapped to a shape after the pen held still; moving on lets go of it. */
  private quick: { spec: ShapeSpec; buffer: TiledSurface; copies: { spec: ShapeSpec; buffer: TiledSurface }[]; sx: number; sy: number } | null = null;
  private holdTimer = 0;
  /** Where the pen came to rest (screen px), and its latest sample: the hold lasts while it stays near. */
  private holdAt: { x: number; y: number } | null = null;
  private lastSample: PointerInfo | null = null;
  private live!: (buffer: TiledSurface) => NonNullable<Editor['view']['live']>;

  constructor(private ed: Editor, private erase: boolean) {}

  private get params() { return this.erase ? this.ed.settings.eraser : this.ed.settings.brush; }

  busy() { return !!this.buffer; }
  pen() { return this.tether ? { x: this.tether.bx, y: this.tether.by } : null; }

  down(p: PointerInfo) {
    const layer = this.ed.paintableLayer();
    if (!layer) return;
    const params = { ...this.params };
    if (this.ed.room) void uploadAssets(brushAssets(params));
    this.id = uid();
    this.sent = 0;
    this.buffer = new TiledSurface();
    const under = (this.ed.onMask ? layer.mask : layer.surface) ?? undefined;
    this.renderer = new StrokeRenderer(this.buffer, params, this.erase ? '#000000' : this.ed.color, { seed: this.id, under });
    this.pts = [];
    this.tilt = [];
    this.len = 0;
    this.tether = null;
    const live = this.live = (buffer: TiledSurface) => ({
      layerId: layer.props.id, buffer, bufferAlpha: params.opacity,
      bufferOp: this.erase ? 'destination-out' : layer.props.alphaLock && !this.ed.onMask ? 'source-atop' : 'source-over',
      clip: this.ed.clipPath(), clipMask: this.ed.clipMask(), mask: this.ed.onMask,
    } as const);
    this.quick = null;
    this.holdAt = null;
    this.ed.view.live = live(this.buffer);
    this.mirrors = symmetryMaps(this.ed).map((m, i) => {
      const buffer = new TiledSurface();
      const id = `${this.id}m${i}`;
      return { m, buffer, renderer: new StrokeRenderer(buffer, params, this.erase ? '#000000' : this.ed.color, { seed: id, under }), id, sent: 0 };
    });
    this.ed.view.extraLive = this.mirrors.map((c) => live(c.buffer));
    if (CANVAS_LOG) {
      resetStrokeStats();
      this.startedAt = performance.now();
      const vp = this.ed.view.viewport;
      clog('stroke.start', { id: this.id, erase: this.erase, brush: params, preset: this.erase ? this.ed.settings.eraserPreset : this.ed.settings.brushPreset,
        color: this.ed.color, layer: layer.props.id, layerTiles: layer.surface.tiles.size, mask: this.ed.onMask, zoom: vp.zoom, rot: vp.rot, mirrors: this.mirrors.length,
        stabilizer: this.ed.prefs.stabilizerOn ? this.ed.prefs.stabilizer : 0, quickShape: this.ed.prefs.quickShape, room: !!this.ed.room, x: p.x, y: p.y, p: p.pressure });
    }
    this.add(p);
  }
  private startedAt = 0;

  move(p: PointerInfo) {
    if (!this.buffer) return;
    if (this.quick) {
      if (Math.hypot(p.sx - this.quick.sx, p.sy - this.quick.sy) < 20) return;
      this.quick = null;
      this.ed.view.live = this.live(this.buffer);
      this.ed.view.extraLive = this.mirrors.map((c) => this.live(c.buffer));
      this.ed.view.invalidate(null);
    }
    this.ahead = [];
    this.add(this.pull(p));
    // The rope moves even when the brush doesn't.
    if (this.tether) this.ed.view.requestRender();
  }

  predict(pts: PointerInfo[]) {
    if (!this.buffer || this.erase || this.tether) return;
    this.ahead = pts;
    if (pts.length) this.ed.view.requestRender();
  }

  /** The predicted tail as a plain line in the stroke's colour, at the pen's width. */
  overlay(ctx: CanvasRenderingContext2D, M: DOMMatrix) {
    const n = this.pts.length;
    if (!this.ahead.length || n < 3) return;
    const b = this.params, zoom = this.ed.view.viewport.zoom;
    const width = (p: number) => b.size * (1 - b.pressureSize * (1 - (b.minSize + (1 - b.minSize) * p))) * zoom;
    ctx.save();
    ctx.strokeStyle = this.ed.color;
    ctx.globalAlpha = b.opacity * Math.min(1, b.flow * 1.5);
    ctx.lineCap = ctx.lineJoin = 'round';
    let last = M.transformPoint({ x: this.pts[n - 3], y: this.pts[n - 2] }), lp = this.pts[n - 1];
    for (const p of this.ahead) {
      const q = M.transformPoint({ x: p.x, y: p.y });
      ctx.lineWidth = Math.max(0.5, width((lp + p.pressure) / 2));
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      last = q; lp = p.pressure;
    }
    ctx.restore();
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
    // Rounded samples are what gets rendered, so a replay matches exactly.
    const x = round(p.x), y = round(p.y), pr = round(p.pressure);
    const n = this.pts.length;
    if (n) this.len += Math.hypot(x - this.pts[n - 3], y - this.pts[n - 2]);
    if (!strokeFits(n + 3, this.len, this.params.size, 0.8)) { this.up(); this.down(p); return; }
    this.pts.push(x, y, pr);
    const tx = this.params.tilt ? Math.round(p.tiltX) : 0, ty = this.params.tilt ? Math.round(p.tiltY) : 0;
    if (this.params.tilt) this.tilt.push(tx, ty);
    const t0 = CANVAS_LOG ? performance.now() : 0;
    const r = this.renderer!.add(x, y, pr, tx, ty);
    if (CANVAS_LOG) { const d = performance.now() - t0; strokeStats.adds++; strokeStats.addMs += d; strokeStats.addMax = Math.max(strokeStats.addMax, d); }
    if (r) this.ed.view.invalidate(r);
    for (const c of this.mirrors) {
      const [mx, my] = mapPts(c.m, [x, y, pr]);
      const mr = c.renderer.add(mx, my, pr, tx, ty);
      if (mr) this.ed.view.invalidate(mr);
    }
    if (this.ed.room && !this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), 33);
    // An Apple Pencil resting on the glass still reports tiny moves and pressure changes: only moving
    // off the spot where the pen came to rest restarts the wait.
    this.lastSample = p;
    const h = this.holdAt;
    if (!this.erase && this.ed.prefs.quickShape && (!h || Math.hypot(p.sx - h.x, p.sy - h.y) > HOLD_SLOP)) {
      clearTimeout(this.holdTimer);
      this.holdAt = { x: p.sx, y: p.sy };
      this.holdTimer = window.setTimeout(() => this.snapShape(this.lastSample ?? p), HOLD_MS);
    }
  }

  /** Swaps the live stroke for the shape it looks like. */
  private snapShape(p: PointerInfo) {
    if (!this.buffer || this.quick) return;
    const spec = recognizeShape(this.pts, this.params.size, this.ed.color);
    if (CANVAS_LOG) clog('quickshape', { samples: this.pts.length / 3, shape: spec?.shape ?? null });
    if (!spec) return;
    const buffer = new TiledSurface();
    renderShape(buffer, spec);
    const copies = this.mirrors.flatMap((c) => { const sp = mapShape(c.m, spec); if (!sp) return []; const buf = new TiledSurface(); renderShape(buf, sp); return [{ spec: sp, buffer: buf }]; });
    this.quick = { spec, buffer, copies, sx: p.sx, sy: p.sy };
    this.ed.view.live = this.live(buffer);
    this.ed.view.extraLive = copies.map((c) => this.live(c.buffer));
    this.ed.view.invalidate(null);
  }

  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    const room = this.ed.room;
    if (!room || this.sent >= this.pts.length) return;
    const tilt = this.params.tilt ? this.tilt.slice((this.sent / 3) * 2) : undefined;
    const live = (stroke: string, pts: number[]) => room.send({ type: 'live', live: {
      stroke, layer: this.ed.activeLayer, erase: this.erase, brush: this.params, color: this.erase ? '#000000' : this.ed.color,
      clip: this.ed.selection ?? undefined, mask: this.ed.onMask, pts, tilt,
    } });
    live(this.id, this.pts.slice(this.sent));
    for (const c of this.mirrors) live(c.id, mapPts(c.m, this.pts.slice(this.sent)));
    this.sent = this.pts.length;
  }

  up() {
    if (!this.buffer) return;
    clearTimeout(this.holdTimer);
    if (this.quick) return this.commitQuick();
    // The line ends where the brush is, not where the cursor was.
    this.tether = null;
    this.ahead = [];
    const r = this.renderer!.end();
    if (r) this.ed.view.invalidate(r);
    const tEnd = CANVAS_LOG ? performance.now() : 0;
    for (const c of this.mirrors) { const mr = c.renderer.end(); if (mr) this.ed.view.invalidate(mr); }
    this.flush();
    const buffer = this.buffer, mirrors = this.mirrors;
    const brush = { ...this.params };
    this.ed.view.live = null;
    this.ed.view.extraLive = [];
    this.buffer = null;
    this.mirrors = [];
    if (!this.erase) this.ed.pushRecent(this.ed.color);
    const tilt = brush.tilt ? this.tilt : undefined;
    const op = (id: string, pts: number[]): Op => ({
      t: 'stroke', id, layer: this.ed.activeLayer, erase: this.erase, brush,
      color: this.erase ? '#000000' : this.ed.color, pts, clip: this.ed.selection ?? undefined, mask: this.ed.onMask, tilt,
    });
    const run = () => this.ed.run([op(this.id, this.pts), ...mirrors.map((c) => op(c.id, mapPts(c.m, this.pts)))], 'stroke', [{ buffer }, ...mirrors.map((c) => ({ buffer: c.buffer }))]);
    if (CANVAS_LOG) {
      const s = strokeStats, f = (v: number) => Math.round(v * 100) / 100;
      clog('stroke.end', { id: this.id, samples: this.pts.length / 3, length: f(this.len), ms: f(tEnd - this.startedAt), bufferTiles: buffer.tiles.size,
        adds: s.adds, addMs: f(s.addMs), addMax: f(s.addMax), dabs: s.dabs, syncs: s.syncs, syncMs: f(s.syncMs), syncMax: f(s.syncMax), syncMPx: f(s.syncPx / 1e6) });
    }
    // A room only takes a stroke once its brush images are on the server.
    const ids = brushAssets(brush);
    if (ids.length && this.ed.room) void uploadAssets(ids).then(run); else run();
  }

  private commitQuick() {
    const q = this.quick!, ids = [this.id, ...this.mirrors.map((c) => c.id)];
    this.quick = null; this.buffer = null; this.mirrors = []; this.tether = null; this.ahead = [];
    clearTimeout(this.flushTimer); this.flushTimer = 0;
    for (const id of ids) this.ed.room?.send({ type: 'live-end', stroke: id });
    this.ed.view.live = null;
    this.ed.view.extraLive = [];
    this.ed.pushRecent(this.ed.color);
    const op = (sp: ShapeSpec): Op => ({
      t: 'shape', id: uid(), layer: this.ed.activeLayer, ...sp, opacity: this.params.opacity, erase: false,
      clip: this.ed.selection ?? undefined, mask: this.ed.onMask,
    });
    this.ed.run([op(q.spec), ...q.copies.map((c) => op(c.spec))], 'shape', [{ buffer: q.buffer }, ...q.copies.map((c) => ({ buffer: c.buffer }))]);
  }

  cancel() {
    if (!this.buffer) return;
    if (CANVAS_LOG) clog('stroke.cancel', { id: this.id, samples: this.pts.length / 3 });
    clearTimeout(this.holdTimer);
    this.quick = null;
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    this.ed.room?.send({ type: 'live-end', stroke: this.id });
    for (const c of this.mirrors) this.ed.room?.send({ type: 'live-end', stroke: c.id });
    this.buffer = null;
    this.mirrors = [];
    this.tether = null;
    this.ahead = [];
    this.ed.view.live = null;
    this.ed.view.extraLive = [];
    this.ed.view.invalidate(null);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
/** Rope length in screen px at the stabilizer's maximum. */
const ROPE_MAX = 160;
/** How long the pen holds still before QuickShape snaps the stroke, and how far (screen px) it may drift meanwhile. */
const HOLD_MS = 650, HOLD_SLOP = 8;
