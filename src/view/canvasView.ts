import { Rect, ctx2d, makeCanvas, rectIntersect, rectUnion, transformRect } from '../core/geom';
import { DrawDoc } from '../core/document';
import { TILE } from '../core/tiles';
import { LiveLayer, composite } from '../engine/compositor';
import { Viewport } from './viewport';

const MAX_COMPOSITE_PIXELS = 14_000_000;

/**
 * Draws the document to the screen. Layers are composited in document space into a cached
 * canvas aligned to the tile grid (no seams, blend modes evaluated in document space), and that
 * single image is then drawn with the view transform (pan/zoom/rotate/flip).
 */
export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  readonly viewport = new Viewport();
  dpr = 1;
  /** This user's uncommitted stroke / transform. */
  live: LiveLayer | null = null;
  /** Other people's in-progress strokes, by stroke id. */
  readonly remoteLive = new Map<string, LiveLayer>();
  overlay: ((ctx: CanvasRenderingContext2D, m: DOMMatrix) => void) | null = null;

  private comp = makeCanvas(1, 1);
  private compKey = '';
  private dirty: Rect | null = null;
  private dirtyAll = true;
  private frame = 0;
  private checker: CanvasPattern | null = null;

  constructor(public doc: DrawDoc, parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage';
    parent.appendChild(this.canvas);
    this.viewport.onChange = () => this.requestRender();
    new ResizeObserver(() => this.resize()).observe(parent);
    this.resize();
  }

  setDoc(doc: DrawDoc) { this.doc = doc; this.invalidate(null); }

  resize() {
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

  /** Mark a document area (or everything, with null) as needing recomposite. */
  invalidate(r: Rect | null) {
    if (!r) this.dirtyAll = true;
    else this.dirty = rectUnion(this.dirty, r);
    this.requestRender();
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  renderNow() { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.render(); }

  private render() {
    const vp = this.viewport, doc = this.doc, dpr = this.dpr;
    const ctx = ctx2d(this.canvas);
    const M = vp.matrix();
    const D = new DOMMatrix().scaleSelf(dpr, dpr).multiplySelf(M);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--workspace') || '#2b2b2f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const docRect: Rect | null = doc.settings.infinite ? null : { x: 0, y: 0, w: doc.settings.width, h: doc.settings.height };
    let visible: Rect | null = transformRect(M.inverse(), { x: 0, y: 0, w: vp.w, h: vp.h });
    if (docRect) visible = rectIntersect(visible, docRect);

    // Paper / transparency checkerboard under the composite.
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
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }

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
        this.compKey = key;
        this.comp.width = nx * k;
        this.comp.height = ny * k;
        this.dirtyAll = true;
      }
      let region: Rect | null = this.dirtyAll ? range : this.dirty ? rectIntersect(this.dirty, range) : null;
      if (region) {
        // Snap the region to whole composite pixels.
        const px0 = Math.floor((region.x - ox) * s), py0 = Math.floor((region.y - oy) * s);
        const px1 = Math.ceil((region.x + region.w - ox) * s), py1 = Math.ceil((region.y + region.h - oy) * s);
        region = { x: ox + px0 / s, y: oy + py0 / s, w: (px1 - px0) / s, h: (py1 - py0) / s };
        const cc = ctx2d(this.comp);
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
        const lives = [...this.remoteLive.values()];
        if (this.live) lives.push(this.live);
        composite(cc, doc, region, { lives });
        cc.restore();
      }
      this.dirty = null;
      this.dirtyAll = false;

      ctx.setTransform(D);
      ctx.imageSmoothingEnabled = zd < 4;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.comp, 0, 0, this.comp.width, this.comp.height, ox, oy, this.comp.width / s, this.comp.height / s);
    } else {
      this.dirty = null;
      this.dirtyAll = false;
    }

    if (this.overlay) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      this.overlay(ctx, M);
    }
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
