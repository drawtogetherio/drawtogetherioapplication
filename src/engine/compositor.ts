import { Rect, ctx2d, makeCanvas, transformRect } from '../core/geom';
import { blendOp } from '../core/model';
import type { DrawDoc } from '../core/document';
import { TiledSurface } from '../core/tiles';

export interface LiveLayer {
  layerId: string;
  buffer?: TiledSurface; // stroke / shape preview
  bufferAlpha?: number;
  bufferOp?: GlobalCompositeOperation;
  clip?: Path2D; // document-space clip for the buffer
  hole?: Path2D;
  floating?: { canvas: HTMLCanvasElement; x: number; y: number; m: DOMMatrix };
}

let scratch: HTMLCanvasElement | null = null;
function getScratch(w: number, h: number) {
  if (!scratch || scratch.width < w || scratch.height < h) {
    scratch = makeCanvas(Math.max(w, scratch?.width ?? 0), Math.max(h, scratch?.height ?? 0));
  }
  return scratch;
}

/** Composite `region` (document coords) into `ctx`, whose transform maps document space to its pixels. */
export function composite(
  ctx: CanvasRenderingContext2D, doc: DrawDoc, region: Rect,
  opts: { lives?: LiveLayer[]; paper?: boolean; only?: string; raw?: boolean } = {},
) {
  const { lives = [], paper = true } = opts;
  if (paper && doc.settings.background) {
    ctx.fillStyle = doc.settings.background;
    ctx.fillRect(region.x, region.y, region.w, region.h);
  }
  for (const layer of doc.layers) {
    const p = layer.props;
    if (opts.only ? p.id !== opts.only : !layer.shown) continue;
    const mine = lives.length ? lives.filter((l) => l.layerId === p.id) : lives;
    if (!mine.length) {
      ctx.save();
      if (!opts.raw) {
        ctx.globalAlpha = p.opacity;
        ctx.globalCompositeOperation = blendOp(p.blend);
      }
      layer.surface.drawTo(ctx, region);
      ctx.restore();
      continue;
    }
    // Layer pixels + uncommitted buffer + floating selection, as one group. Only the region's pixels are touched.
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const t = ctx.getTransform();
    const d = transformRect(t, region);
    const bx = Math.max(0, Math.floor(d.x)), by = Math.max(0, Math.floor(d.y));
    const bw = Math.min(W, Math.ceil(d.x + d.w)) - bx, bh = Math.min(H, Math.ceil(d.y + d.h)) - by;
    if (bw <= 0 || bh <= 0) continue;
    const s = getScratch(W, H);
    const sc = ctx2d(s);
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(bx, by, bw, bh);
    sc.setTransform(t);
    layer.surface.drawTo(sc, region);
    for (const live of mine) {
      if (live.hole) {
        sc.save();
        sc.globalCompositeOperation = 'destination-out';
        sc.fill(live.hole);
        sc.restore();
      }
      if (live.buffer) {
        sc.save();
        if (live.clip) sc.clip(live.clip);
        sc.globalAlpha = live.bufferAlpha ?? 1;
        sc.globalCompositeOperation = live.bufferOp ?? 'source-over';
        live.buffer.drawTo(sc, region);
        sc.restore();
      }
      if (live.floating) {
        const f = live.floating;
        sc.save();
        sc.transform(f.m.a, f.m.b, f.m.c, f.m.d, f.m.e, f.m.f);
        sc.imageSmoothingQuality = 'high';
        sc.drawImage(f.canvas, f.x, f.y);
        sc.restore();
      }
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = p.opacity;
    ctx.globalCompositeOperation = blendOp(p.blend);
    ctx.drawImage(s, bx, by, bw, bh, bx, by, bw, bh);
    ctx.restore();
  }
}

export function renderRegion(doc: DrawDoc, r: Rect, opts: { paper?: boolean; only?: string; raw?: boolean } = {}): HTMLCanvasElement {
  const c = makeCanvas(r.w, r.h);
  const ctx = ctx2d(c, true);
  ctx.translate(-r.x, -r.y);
  composite(ctx, doc, r, opts);
  return c;
}
