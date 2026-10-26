import { Rect, ctx2d, makeCanvas, transformRect } from '../core/geom';
import { type Adjustment, blendOp } from '../core/model';
import { adjustPixels } from './effects';
import type { SelMask } from './selection';
import type { DrawDoc, Layer } from '../core/document';
import { TiledSurface } from '../core/tiles';

export interface LiveLayer {
  layerId: string;
  buffer?: TiledSurface; // stroke / shape preview
  bufferAlpha?: number;
  bufferOp?: GlobalCompositeOperation;
  clip?: Path2D; // document-space clip for the buffer
  /** A feathered selection: the buffer shows through this instead of the hard clip. */
  clipMask?: SelMask;
  hole?: Path2D;
  floating?: { canvas: HTMLCanvasElement; x: number; y: number; m: DOMMatrix };
  /** The edit is on the layer's mask, not its pixels. */
  mask?: boolean;
}

// Region-sized scratch canvases: the layer group, the clip base, a clipped layer, and the mask.
// Drawing a canvas onto another snapshots all of it, so these stay close to the region's size
// rather than the whole view's.
const scratch: HTMLCanvasElement[] = [];
function getScratch(i: number, w: number, h: number) {
  let s = scratch[i];
  const big = s && s.width * s.height > Math.max(4 * w * h, 512 * 512);
  if (!s || s.width < w || s.height < h || big) scratch[i] = s = makeCanvas(big ? w : Math.max(w, s?.width ?? 0), big ? h : Math.max(h, s?.height ?? 0));
  return s;
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
  const layers = doc.layers;
  const byLayer = new Map<string, LiveLayer[]>();
  for (const l of lives) byLayer.set(l.layerId, [...(byLayer.get(l.layerId) ?? []), l]);
  const livesOf = (id: string) => byLayer.get(id) ?? [];
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const t = ctx.getTransform();
  const d = transformRect(t, region);
  const bx = Math.max(0, Math.floor(d.x)), by = Math.max(0, Math.floor(d.y));
  const bw = Math.min(W, Math.ceil(d.x + d.w)) - bx, bh = Math.min(H, Math.ceil(d.y + d.h)) - by;
  // Scratch pixel (0,0) is target pixel (bx,by).
  const fresh = (i: number) => {
    const sc = ctx2d(getScratch(i, bw, bh));
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(0, 0, bw, bh);
    sc.setTransform(t.a, t.b, t.c, t.d, t.e - bx, t.f - by);
    return sc;
  };
  // Layer pixels + uncommitted edits + mask, before opacity and blend.
  const drawRaw = (sc: CanvasRenderingContext2D, layer: Layer, mine: LiveLayer[]) => {
    layer.surface.drawTo(sc, region);
    for (const live of mine) if (!live.mask) drawLive(sc, live, region);
    const maskLives = mine.filter((l) => l.mask);
    if (!layer.mask && !maskLives.length) return;
    const mc = fresh(3);
    layer.mask?.drawTo(mc, region);
    for (const live of maskLives) drawLive(mc, live, region);
    sc.save();
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalCompositeOperation = 'destination-out';
    sc.drawImage(mc.canvas, 0, 0, bw, bh, 0, 0, bw, bh);
    sc.restore();
  };
  /** How much of the adjustment lands at each scratch pixel: where the layer's mask lets it through. */
  const maskWeight = (layer: Layer, mine: LiveLayer[]): Uint8ClampedArray | undefined => {
    const maskLives = mine.filter((l) => l.mask);
    if (!layer.mask && !maskLives.length) return undefined;
    const mc = fresh(3);
    layer.mask?.drawTo(mc, region);
    for (const live of maskLives) drawLive(mc, live, region);
    const md = mc.getImageData(0, 0, bw, bh).data, w = new Uint8ClampedArray(bw * bh);
    for (let j = 0; j < w.length; j++) w[j] = 255 - md[j * 4 + 3];
    return w;
  };
  /** Recolours what `sc` holds so far (its pixels at sx, sy) with an adjustment layer. */
  const adjust = (sc: CanvasRenderingContext2D, sx: number, sy: number, layer: Layer, adj: Adjustment, mine: LiveLayer[]) => {
    const img = sc.getImageData(sx, sy, bw, bh);
    adjustPixels(img.data, { ...adj, amount: adj.amount * layer.props.opacity }, maskWeight(layer, mine));
    // Through a scratch canvas, so the target's clip still applies.
    const tmp = fresh(2);
    tmp.setTransform(1, 0, 0, 1, 0, 0);
    tmp.putImageData(img, 0, 0);
    sc.save();
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalCompositeOperation = 'copy';
    sc.drawImage(tmp.canvas, 0, 0, bw, bh, sx, sy, bw, bh);
    sc.restore();
  };
  const blit = (sc: CanvasRenderingContext2D, alpha: number, op: GlobalCompositeOperation) => {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(sc.canvas, 0, 0, bw, bh, bx, by, bw, bh);
    ctx.restore();
  };

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const p = layer.props;
    if (opts.only) {
      if (p.id !== opts.only) continue;
      ctx.save();
      if (!opts.raw) { ctx.globalAlpha = p.opacity; ctx.globalCompositeOperation = blendOp(p.blend); }
      layer.surface.drawTo(ctx, region);
      ctx.restore();
      continue;
    }
    // Clipped layers ride on the first unclipped layer below them in the same folder.
    const clipped: Layer[] = [];
    while (i + 1 < layers.length && layers[i + 1].props.clip && layers[i + 1].parent === layer.parent) clipped.push(layers[++i]);
    if (!layer.shown) continue;
    const mine = livesOf(p.id);
    if (p.adjust) { if (bw > 0 && bh > 0) adjust(ctx, bx, by, layer, p.adjust, mine); continue; }
    // Painting over a plain layer: source-over is associative, so the stroke can go straight on
    // top with the layer's opacity, no group needed.
    const plain = !mine.length || (p.opacity === 1 && p.blend === 'normal' && mine.every((l) => !l.mask && !l.hole && !l.floating && (l.bufferOp ?? 'source-over') === 'source-over'));
    if (!layer.mask && !clipped.length && plain) {
      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.globalCompositeOperation = blendOp(p.blend);
      layer.surface.drawTo(ctx, region);
      ctx.restore();
      for (const live of mine) drawLive(ctx, live, region);
      continue;
    }
    if (bw <= 0 || bh <= 0) continue;
    const group = fresh(0);
    drawRaw(group, layer, mine);
    if (clipped.length) {
      const base = fresh(1);
      base.setTransform(1, 0, 0, 1, 0, 0);
      base.drawImage(group.canvas, 0, 0, bw, bh, 0, 0, bw, bh);
      for (const c of clipped) {
        if (!c.props.visible) continue;
        if (c.props.adjust) { adjust(group, 0, 0, c, c.props.adjust, livesOf(c.props.id)); continue; }
        const sc = fresh(2);
        drawRaw(sc, c, livesOf(c.props.id));
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalCompositeOperation = 'destination-in';
        sc.drawImage(base.canvas, 0, 0, bw, bh, 0, 0, bw, bh);
        sc.globalCompositeOperation = 'source-over';
        group.save();
        group.setTransform(1, 0, 0, 1, 0, 0);
        group.globalAlpha = c.props.opacity;
        group.globalCompositeOperation = blendOp(c.props.blend);
        group.drawImage(sc.canvas, 0, 0, bw, bh, 0, 0, bw, bh);
        group.restore();
      }
    }
    blit(group, p.opacity, blendOp(p.blend));
  }
}

function drawLive(sc: CanvasRenderingContext2D, live: LiveLayer, region: Rect) {
  if (live.hole) {
    sc.save();
    sc.globalCompositeOperation = 'destination-out';
    sc.fill(live.hole, 'evenodd');
    sc.restore();
  }
  if (live.buffer) {
    sc.save();
    sc.globalAlpha = live.bufferAlpha ?? 1;
    sc.globalCompositeOperation = live.bufferOp ?? 'source-over';
    if (live.clipMask) {
      const m = live.clipMask, soft = makeCanvas(region.w, region.h), c = ctx2d(soft);
      c.translate(-region.x, -region.y);
      live.buffer.drawTo(c, region);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(m.canvas, m.x, m.y);
      sc.drawImage(soft, region.x, region.y);
    } else {
      if (live.clip) sc.clip(live.clip, 'evenodd');
      live.buffer.drawTo(sc, region);
    }
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

export function renderRegion(doc: DrawDoc, r: Rect, opts: { paper?: boolean; only?: string; raw?: boolean } = {}): HTMLCanvasElement {
  const c = makeCanvas(r.w, r.h);
  const ctx = ctx2d(c, true);
  ctx.translate(-r.x, -r.y);
  composite(ctx, doc, r, opts);
  return c;
}
