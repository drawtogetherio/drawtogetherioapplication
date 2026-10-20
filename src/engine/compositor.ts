import { Rect, ctx2d, makeCanvas } from '../core/geom';
import { blendOp } from '../core/model';
import type { DrawDoc } from '../core/document';
import { TiledSurface } from '../core/tiles';

/** In-progress state of the active layer that is not yet committed to the document. */
export interface LiveLayer {
  layerId: string;
  buffer?: TiledSurface; // stroke / shape preview
  bufferAlpha?: number;
  bufferOp?: GlobalCompositeOperation;
  clip?: Path2D; // document-space clip for the buffer
  /** Area lifted out of the layer while a selection is being transformed. */
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

/**
 * Composite the document into `ctx`, whose current transform maps document coordinates to its
 * pixels, limited to `region` (document coords). The caller sets up any clip.
 */
export function composite(
  ctx: CanvasRenderingContext2D, doc: DrawDoc, region: Rect,
  opts: { live?: LiveLayer | null; paper?: boolean; only?: string; raw?: boolean } = {},
) {
  const { live, paper = true } = opts;
  if (paper && doc.settings.background) {
    ctx.fillStyle = doc.settings.background;
    ctx.fillRect(region.x, region.y, region.w, region.h);
  }
  for (const layer of doc.layers) {
    const p = layer.props;
    if (opts.only ? p.id !== opts.only : !p.visible) continue;
    const isLive = live && live.layerId === p.id;
    if (!isLive) {
      ctx.save();
      if (!opts.raw) {
        ctx.globalAlpha = p.opacity;
        ctx.globalCompositeOperation = blendOp(p.blend);
      }
      layer.surface.drawTo(ctx, region);
      ctx.restore();
      continue;
    }
    // Render the live layer as a group: layer pixels + uncommitted buffer + floating selection.
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const s = getScratch(W, H);
    const sc = ctx2d(s);
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(0, 0, W, H);
    sc.setTransform(ctx.getTransform());
    layer.surface.drawTo(sc, region);
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
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = p.opacity;
    ctx.globalCompositeOperation = blendOp(p.blend);
    ctx.drawImage(s, 0, 0, W, H, 0, 0, W, H);
    ctx.restore();
  }
}

/** Render a document region at 1:1 into a new canvas. */
export function renderRegion(doc: DrawDoc, r: Rect, opts: { paper?: boolean; only?: string; raw?: boolean } = {}): HTMLCanvasElement {
  const c = makeCanvas(r.w, r.h);
  const ctx = ctx2d(c, true);
  ctx.translate(-r.x, -r.y);
  composite(ctx, doc, r, opts);
  return c;
}
