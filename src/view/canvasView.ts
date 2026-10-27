import { Rect, ctx2d, makeCanvas, rectIntersect, rectUnion, transformRect } from '../core/geom';
import { DrawDoc } from '../core/document';
import { TILE } from '../core/tiles';
import { LiveLayer, composite } from '../engine/compositor';
import { Viewport } from './viewport';
import { CANVAS_LOG, clog } from '../debug/canvasLog';

const MAX_COMPOSITE_PIXELS = 14_000_000;
/** A recomposite of the whole view (a zoom step on a big canvas with many layers) spreads over frames past this. */
const FRAME_BUDGET_MS = 10;
/** Dirty rects closer than this merge; past MAX_DIRTY they all collapse into one. */
const DIRTY_JOIN = 32, MAX_DIRTY = 24;

/** Layers composite into a cached, tile-aligned canvas, which is drawn with the view transform. */
export class CanvasView {
  canvas: HTMLCanvasElement;
  readonly viewport = new Viewport();
  /** The stage canvas was replaced (see `setLowLatency`); input listeners must move to the new one. */
  onCanvas: (c: HTMLCanvasElement) => void = () => {};
  private lowLatency = true;
  private ctx!: CanvasRenderingContext2D;
  dpr = 1;
  live: LiveLayer | null = null;
  /** Symmetry copies of the stroke in progress. */
  extraLive: LiveLayer[] = [];
  readonly remoteLive = new Map<string, LiveLayer>();
  overlay: ((ctx: CanvasRenderingContext2D, m: DOMMatrix) => void) | null = null;
  /** Runs before each frame composites; edits it makes land in the same frame. */
  prepare: (() => void) | null = null;

  private comp = makeCanvas(1, 1);
  private compKey = '';
  private compRange: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private compScale = 1;
  /** The previous composite, shown scaled under the rows not yet redrawn at the new scale. */
  private stale: { c: HTMLCanvasElement; range: Rect; s: number } | null = null;
  private spare = makeCanvas(1, 1);
  /** Tile rows of a view-wide recomposite done so far. */
  private rowsDone = 0;
  /** Separate areas waiting to be recomposited, so people drawing far apart don't repaint everything between them. */
  private dirty: Rect[] = [];
  private dirtyAll = true;
  private frame = 0;
  private checker: CanvasPattern | null = null;
  private workspace = '';
  private bg = makeCanvas(1, 1);
  private bgKey = '';
  private settled = false;
  private settleTimer = 0;

  constructor(public doc: DrawDoc, parent: HTMLElement) {
    this.canvas = this.makeStage();
    parent.appendChild(this.canvas);
    this.viewport.onChange = () => this.requestRender();
    new ResizeObserver(() => this.resize()).observe(parent);
    this.resize();
  }

  /**
   * A desynchronized canvas skips the compositor's queue, so the line reaches the screen a frame or
   * two sooner. The context is fixed at creation, so changing the setting means a new canvas.
   */
  private makeStage(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.className = 'stage';
    this.ctx = c.getContext('2d', { desynchronized: this.lowLatency, alpha: false })!;
    return c;
  }

  setLowLatency(on: boolean) {
    if (on === this.lowLatency) return;
    if (CANVAS_LOG) clog('lowLatency', on);
    this.lowLatency = on;
    const old = this.canvas;
    this.canvas = this.makeStage();
    old.replaceWith(this.canvas);
    this.onCanvas(this.canvas);
    this.resize();
  }

  setDoc(doc: DrawDoc) { this.doc = doc; this.invalidate(null); }

  resize() {
    this.workspace = getComputedStyle(document.body).getPropertyValue('--workspace') || '#2b2b2f';
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.viewport.w = Math.max(1, r.width);
    this.viewport.h = Math.max(1, r.height);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.requestRender();
  }

  invalidate(r: Rect | null) {
    if (!r) { this.dirtyAll = true; this.rowsDone = 0; }
    else if (r.w > 0 && r.h > 0 && (!this.dirtyAll || this.rowsDone)) this.addDirty(r);
    this.requestRender();
  }

  private addDirty(r: Rect) {
    let cur = { ...r };
    // Absorb every rect this one touches (or nearly touches), repeating as it grows.
    for (let merged = true; merged;) {
      merged = false;
      for (let i = this.dirty.length - 1; i >= 0; i--) {
        const d = this.dirty[i];
        if (cur.x - DIRTY_JOIN < d.x + d.w && d.x - DIRTY_JOIN < cur.x + cur.w && cur.y - DIRTY_JOIN < d.y + d.h && d.y - DIRTY_JOIN < cur.y + cur.h) {
          cur = rectUnion(cur, d)!;
          this.dirty.splice(i, 1);
          merged = true;
        }
      }
    }
    this.dirty.push(cur);
    if (this.dirty.length > MAX_DIRTY) this.dirty = [this.dirty.reduce<Rect | null>((u, d) => rectUnion(u, d), null)!];
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame((at) => {
      const t0 = CANVAS_LOG ? performance.now() : 0;
      this.prepare?.(); this.frame = 0;
      const t1 = CANVAS_LOG ? performance.now() : 0, dirty = this.dirty.length, all = this.dirtyAll, area = CANVAS_LOG ? this.dirty.reduce((n, d) => n + d.w * d.h, 0) : 0;
      this.render();
      if (CANVAS_LOG) {
        const f = (v: number) => Math.round(v * 100) / 100, now = performance.now();
        clog('frame', { ms: f(now - t1), prep: f(t1 - t0), gap: f(at - this.lastFrame), late: f(t0 - at), dirty, all, area: Math.round(area), live: !!this.live });
        this.lastFrame = at;
      }
    });
  }
  private lastFrame = 0;

  /** The part of the document on screen. */
  visible(): Rect { const vp = this.viewport; return transformRect(vp.matrix().inverse(), { x: 0, y: 0, w: vp.w, h: vp.h }); }

  renderNow() { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.render(); }

  private render() {
    const vp = this.viewport, doc = this.doc, dpr = this.dpr;
    const ctx = this.ctx;
    const M = vp.matrix();
    const D = new DOMMatrix().scaleSelf(dpr, dpr).multiplySelf(M);

    const docRect: Rect | null = doc.settings.infinite ? null : { x: 0, y: 0, w: doc.settings.width, h: doc.settings.height };
    let visible: Rect | null = this.visible();
    if (docRect) visible = rectIntersect(visible, docRect);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.background(D, docRect), 0, 0);

    if (visible) {
      const zd = vp.zoom * dpr;
      let k = zd >= 1 ? TILE : Math.max(1, Math.ceil(zd * TILE));
      const tx0 = Math.floor(visible.x / TILE), ty0 = Math.floor(visible.y / TILE);
      const tx1 = Math.floor((visible.x + visible.w) / TILE), ty1 = Math.floor((visible.y + visible.h) / TILE);
      const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
      while (k > 1 && nx * ny * k * k > MAX_COMPOSITE_PIXELS) k = Math.floor(k * 0.8);
      const key = [tx0, ty0, nx, ny, k].join(',');
      const s = k / TILE, ox = tx0 * TILE, oy = ty0 * TILE;
      const range = { x: ox, y: oy, w: nx * TILE, h: ny * TILE };

      if (key !== this.compKey) {
        if (this.compKey) {
          this.stale = { c: this.comp, range: this.compRange, s: this.compScale };
          this.comp = this.spare;
          this.spare = this.stale.c;
        }
        this.compKey = key;
        this.compRange = range;
        this.compScale = s;
        this.comp.width = nx * k;
        this.comp.height = ny * k;
        this.dirtyAll = true;
        this.rowsDone = 0;
      }
      const lives = [...this.remoteLive.values()];
      if (this.live) lives.push(this.live, ...this.extraLive);
      const cc = ctx2d(this.comp);
      const draw = (region: Rect) => {
        const px0 = Math.floor((region.x - ox) * s), py0 = Math.floor((region.y - oy) * s);
        const px1 = Math.ceil((region.x + region.w - ox) * s), py1 = Math.ceil((region.y + region.h - oy) * s);
        region = { x: ox + px0 / s, y: oy + py0 / s, w: (px1 - px0) / s, h: (py1 - py0) / s };
        cc.save();
        cc.setTransform(1, 0, 0, 1, 0, 0);
        cc.clearRect(px0, py0, px1 - px0, py1 - py0);
        cc.beginPath();
        cc.rect(px0, py0, px1 - px0, py1 - py0);
        cc.clip();
        cc.setTransform(s, 0, 0, s, -ox * s, -oy * s);
        if (docRect) { cc.beginPath(); cc.rect(docRect.x, docRect.y, docRect.w, docRect.h); cc.clip(); }
        cc.imageSmoothingEnabled = true;
        cc.imageSmoothingQuality = 'high';
        composite(cc, doc, region, { lives });
        cc.restore();
      };
      if (this.dirtyAll) {
        // Row by row within the frame budget; the rest next frame, with the old composite showing meanwhile.
        const start = performance.now();
        while (this.rowsDone < ny && (this.rowsDone === 0 || performance.now() - start < FRAME_BUDGET_MS)) {
          draw({ x: ox, y: oy + this.rowsDone * TILE, w: nx * TILE, h: TILE });
          this.rowsDone++;
        }
        if (this.rowsDone < ny) this.requestRender();
        else { this.dirtyAll = false; this.stale = null; }
      }
      for (const d of this.dirty) { const region = rectIntersect(d, range); if (region) draw(region); }
      this.dirty = [];

      if (this.stale && this.rowsDone < ny) {
        const st = this.stale, y = oy + this.rowsDone * TILE;
        ctx.setTransform(D);
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, y, nx * TILE, (ny - this.rowsDone) * TILE);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(st.c, 0, 0, st.c.width, st.c.height, st.range.x, st.range.y, st.c.width / st.s, st.c.height / st.s);
        ctx.restore();
      }
      ctx.setTransform(D);
      ctx.imageSmoothingEnabled = zd < 4;
      ctx.imageSmoothingQuality = this.blitQuality(zd / s);
      ctx.drawImage(this.comp, 0, 0, this.comp.width, this.comp.height, ox, oy, this.comp.width / s, this.comp.height / s);
    } else {
      this.dirty = [];
      this.dirtyAll = false;
    }

    if (this.overlay) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      this.overlay(ctx, M);
    }
  }

  /** Workspace, the paper and its shadow, and the checkerboard; redrawn only when the view moves. */
  private background(D: DOMMatrix, docRect: Rect | null): HTMLCanvasElement {
    const doc = this.doc, dpr = this.dpr;
    const key = [this.canvas.width, this.canvas.height, D.a, D.b, D.c, D.d, D.e, D.f, this.workspace, doc.settings.background, docRect?.w, docRect?.h].join(',');
    if (key === this.bgKey) return this.bg;
    this.bgKey = key;
    const bg = this.bg;
    bg.width = this.canvas.width;
    bg.height = this.canvas.height;
    const ctx = ctx2d(bg);
    ctx.fillStyle = this.workspace;
    ctx.fillRect(0, 0, bg.width, bg.height);
    ctx.setTransform(D);
    if (docRect) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 18 * dpr;
      ctx.fillStyle = doc.settings.background ?? '#fff';
      ctx.fillRect(0, 0, docRect.w, docRect.h);
      ctx.restore();
    }
    if (!doc.settings.background) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (docRect) { ctx.setTransform(D); ctx.beginPath(); ctx.rect(0, 0, docRect.w, docRect.h); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clip(); }
      ctx.fillStyle = this.checkerPattern(ctx);
      ctx.fillRect(0, 0, bg.width, bg.height);
      ctx.restore();
    }
    return bg;
  }

  /**
   * Resampling the whole view in high quality every frame is slow, so busy frames use bilinear and
   * one high-quality frame follows once things settle. At about 1:1 the two look the same.
   */
  private blitQuality(scale: number): ImageSmoothingQuality {
    if (Math.abs(scale - 1) < 0.02) return 'low';
    if (this.settled) { this.settled = false; return 'high'; }
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => { this.settled = true; this.requestRender(); }, 200);
    return 'low';
  }

  private checkerPattern(ctx: CanvasRenderingContext2D) {
    if (!this.checker) {
      const c = makeCanvas(16, 16);
      const x = ctx2d(c);
      x.fillStyle = '#fff'; x.fillRect(0, 0, 16, 16);
      x.fillStyle = '#d9d9de'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
      this.checker = ctx.createPattern(c, 'repeat');
    }
    return this.checker!;
  }
}
