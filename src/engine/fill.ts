import { Rect, ctx2d, makeCanvas, polyPath } from '../core/geom';
import { hexToRgb } from './brush';

type Match = (i: number) => boolean;

/** Pixels within `tolerance` of the colour at byte offset `i0`, compared premultiplied so transparent pixels all match each other. */
function matcher(d: Uint8ClampedArray, i0: number, tolerance: number): Match {
  const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
  const tol = tolerance * 255 * 4;
  return (i) => {
    const a = d[i + 3];
    const dr = Math.abs((d[i] * a - r0 * a0) / 255), dg = Math.abs((d[i + 1] * a - g0 * a0) / 255);
    const db = Math.abs((d[i + 2] * a - b0 * a0) / 255), da = Math.abs(a - a0);
    return dr + dg + db + da <= tol;
  };
}

/** Scanline flood from `seeds` (pixel indices) over pixels that match; `within` limits where it may go. */
function flood(W: number, H: number, seeds: number[], match: Match, within?: Uint8Array): Uint8Array {
  const mask = new Uint8Array(W * H);
  const ok = (p: number) => !mask[p] && (!within || within[p]) && match(p * 4);
  const stack: number[] = [];
  for (const s of seeds) if (ok(s)) stack.push(s % W, Math.floor(s / W));
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    let x = x0;
    let p = y * W + x;
    while (x >= 0 && ok(p)) { x--; p--; }
    x++; p++;
    let up = false, down = false;
    while (x < W && ok(p)) {
      mask[p] = 1;
      if (y > 0) {
        if (ok(p - W)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
      }
      if (y < H - 1) {
        if (ok(p + W)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
      }
      x++; p++;
    }
  }
  return mask;
}

/** The connected area of similar colour around a point, as a mask over `region`. */
export function regionMask(src: ImageData, region: Rect, seedX: number, seedY: number, tolerance: number): Uint8Array | null {
  const W = src.width, H = src.height;
  const sx = Math.floor(seedX - region.x), sy = Math.floor(seedY - region.y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const p = sy * W + sx;
  return flood(W, H, [p], matcher(src.data, p * 4, tolerance));
}

/** The bucket's mask: the connected area, grown by `expand`. Pure, so it can run in a worker. */
export function floodMask(src: ImageData, region: Rect, seedX: number, seedY: number, tolerance: number, expand: number): Uint8Array | null {
  const m = regionMask(src, region, seedX, seedY, tolerance);
  return m && grow(m, src.width, src.height, expand);
}

/** Flood fill over `src` (covering `region`). Returns the fill as a canvas of the same size, or null. */
export function floodFill(
  src: ImageData, region: Rect, seedX: number, seedY: number, color: string, tolerance: number, expand: number,
): HTMLCanvasElement | null {
  const m = floodMask(src, region, seedX, seedY, tolerance, expand);
  return m && maskCanvas(m, src.width, src.height, color);
}

/** The polygon (document coords) as a mask over `region`. */
export function polyMask(region: Rect, pts: number[]): Uint8Array {
  const c = makeCanvas(region.w, region.h), ctx = ctx2d(c, true);
  ctx.translate(-region.x, -region.y);
  ctx.fillStyle = '#000';
  ctx.fill(polyPath(pts));
  const d = ctx.getImageData(0, 0, region.w, region.h).data;
  const m = new Uint8Array(region.w * region.h);
  for (let p = 0; p < m.length; p++) if (d[p * 4 + 3] > 127) m[p] = 1;
  return m;
}

/** The lasso filled with colour. */
export function polyFill(region: Rect, pts: number[], color: string): HTMLCanvasElement {
  const c = makeCanvas(region.w, region.h), ctx = ctx2d(c);
  ctx.translate(-region.x, -region.y);
  ctx.fillStyle = color;
  ctx.fill(polyPath(pts));
  return c;
}

/**
 * Fills the parts of the lasso that lines close off. The lasso's surroundings (the colour most of its
 * edge sits on) are the open space; everything of that colour that can't be reached from the edge is inside the lines.
 */
export function enclosedFill(src: ImageData, region: Rect, pts: number[], color: string, tolerance: number, expand: number): HTMLCanvasElement | null {
  const m = enclosedMask(src, polyMask(region, pts), tolerance, expand);
  return m && maskCanvas(m, src.width, src.height, color);
}

/** The enclosed parts of `lasso` (a mask over `src`) as a mask. Pure, so it can run in a worker. */
export function enclosedMask(src: ImageData, lasso: Uint8Array, tolerance: number, expand: number): Uint8Array | null {
  const W = src.width, H = src.height, d = src.data;
  const edge: number[] = [];
  const hist = new Map<number, { n: number; p: number }>();
  for (let p = 0; p < lasso.length; p++) {
    if (!lasso[p]) continue;
    const x = p % W, y = (p - x) / W;
    if (x > 0 && lasso[p - 1] && x < W - 1 && lasso[p + 1] && y > 0 && lasso[p - W] && y < H - 1 && lasso[p + W]) continue;
    edge.push(p);
    const i = p * 4, a = d[i + 3];
    // Premultiplied and coarsened to 16 levels, so anti-aliasing doesn't split one colour into many.
    const key = a < 8 ? -1 : ((d[i] * a) >> 12) << 8 | ((d[i + 1] * a) >> 12) << 4 | ((d[i + 2] * a) >> 12) | (a >> 4) << 12;
    const h = hist.get(key);
    if (h) h.n++; else hist.set(key, { n: 1, p });
  }
  let ref: { n: number; p: number } | undefined;
  for (const h of hist.values()) if (!ref || h.n > ref.n) ref = h;
  if (!ref) return null;
  const match = matcher(d, ref.p * 4, tolerance);
  const open = flood(W, H, edge, match, lasso);
  const m = new Uint8Array(W * H);
  let any = false;
  for (let p = 0; p < m.length; p++) if (lasso[p] && !open[p] && match(p * 4)) { m[p] = 1; any = true; }
  if (!any) return null;
  const grown = grow(m, W, H, expand);
  for (let p = 0; p < grown.length; p++) if (!lasso[p]) grown[p] = 0;
  return grown;
}

function grow(m: Uint8Array, W: number, H: number, by: number): Uint8Array {
  for (let e = 0; e < by; e++) m = dilate(m, W, H);
  return m;
}

export function maskCanvas(m: Uint8Array, W: number, H: number, color: string): HTMLCanvasElement {
  const out = makeCanvas(W, H);
  const octx = ctx2d(out);
  const img = octx.createImageData(W, H);
  const [r, g, b] = hexToRgb(color);
  const o = img.data;
  for (let p = 0; p < m.length; p++) {
    if (!m[p]) continue;
    const i = p * 4;
    o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function dilate(m: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(m);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (m[p]) continue;
      if ((x > 0 && m[p - 1]) || (x < W - 1 && m[p + 1]) || (y > 0 && m[p - W]) || (y < H - 1 && m[p + W])) out[p] = 1;
    }
  }
  return out;
}
