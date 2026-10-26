import { Rect, ctx2d, makeCanvas, rectFromPoints, rectRoundOut, selPath } from '../core/geom';
import type { Selection } from '../core/model';
import { maskToSelection } from '../engine/contour';

/** A selection rasterised over `r`: white where selected, its edge softened by the selection's feather. */
export interface SelMask { canvas: HTMLCanvasElement; x: number; y: number }

export const MAX_FEATHER = 64;

/** How far a feathered edge reaches past the outline. */
export const featherPad = (sel: Selection | undefined) => (sel?.feather ? Math.ceil(sel.feather * 1.5) + 1 : 0);

export function selMask(sel: Selection, r: Rect): SelMask {
  const c = makeCanvas(r.w, r.h), ctx = ctx2d(c, true);
  ctx.translate(-r.x, -r.y);
  ctx.fillStyle = '#fff';
  ctx.fill(selPath(sel), 'evenodd');
  if (sel.feather) {
    const img = ctx.getImageData(0, 0, r.w, r.h);
    blurAlpha(img.data, r.w, r.h, sel.feather);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(img, 0, 0);
  }
  return { canvas: c, x: r.x, y: r.y };
}

/** Three integer box blurs of the alpha channel (close to a gaussian, identical everywhere). */
function blurAlpha(d: Uint8ClampedArray, w: number, h: number, feather: number) {
  const a = new Uint16Array(w * h), tmp = new Uint16Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  const r = Math.max(1, Math.round(feather / 2)), span = r * 2 + 1;
  const pass = (src: Uint16Array, dst: Uint16Array, W: number, H: number, stride: number, step: number) => {
    for (let y = 0; y < H; y++) {
      let sum = 0;
      const row = y * stride;
      for (let k = -r; k <= r; k++) sum += src[row + Math.min(W - 1, Math.max(0, k)) * step];
      for (let x = 0; x < W; x++) {
        dst[row + x * step] = Math.round(sum / span);
        sum += src[row + Math.min(W - 1, x + r + 1) * step] - src[row + Math.max(0, x - r) * step];
      }
    }
  };
  for (let n = 0; n < 3; n++) { pass(a, tmp, w, h, w, 1); pass(tmp, a, h, w, 1, w); }
  for (let i = 0; i < a.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = a[i]; }
}

/** `img` (whose top-left sits at x, y in the document) kept only where the mask is, by its softness. */
export function maskImage(img: CanvasImageSource, w: number, h: number, mask: SelMask, x: number, y: number): HTMLCanvasElement {
  const c = makeCanvas(w, h), ctx = ctx2d(c);
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask.canvas, mask.x - x, mask.y - y);
  return c;
}

/** The part of `img` the mask does not cover. */
export function unmaskImage(img: CanvasImageSource, w: number, h: number, mask: SelMask, x: number, y: number): HTMLCanvasElement {
  const c = makeCanvas(w, h), ctx = ctx2d(c);
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(mask.canvas, mask.x - x, mask.y - y);
  return c;
}

/** Everything in `area` except the selection (its holes count as selected again). */
export function invertSel(sel: Selection, area: Rect): Selection {
  const ring = [area.x, area.y, area.x + area.w, area.y, area.x + area.w, area.y + area.h, area.x, area.y + area.h];
  // Inverting an inverted selection: the first hole was the original outline.
  if (sel.holes?.length && sel.pts.length === 8 && sel.pts.every((v, i) => v === ring[i])) return { pts: sel.holes[0], holes: sel.holes.length > 1 ? sel.holes.slice(1) : undefined, feather: sel.feather };
  return { pts: ring, holes: [sel.pts, ...(sel.holes ?? [])], feather: sel.feather };
}

/** The selection grown (px > 0) or shrunk (px < 0) by a distance, with round corners. */
export function growSel(sel: Selection, px: number): Selection | null {
  const pad = Math.abs(px) + 2, r = rectRoundOut(rectFromPoints(sel.pts, pad)!, 0);
  const W = r.w, H = r.h, m = selMask({ pts: sel.pts, holes: sel.holes }, r);
  const d = ctx2d(m.canvas, true).getImageData(0, 0, W, H).data;
  const inside = new Uint8Array(W * H);
  for (let i = 0; i < inside.length; i++) inside[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  // Distance to the nearest pixel of the other kind: grow from the outside, shrink from the inside.
  const dist = edt(inside, W, H, px > 0 ? 1 : 0), out = new Uint8Array(W * H), lim = px * px;
  for (let i = 0; i < out.length; i++) out[i] = px > 0 ? (inside[i] || dist[i] <= lim ? 1 : 0) : (inside[i] && dist[i] > lim ? 1 : 0);
  const grown = maskToSelection(out, W, H, r.x, r.y);
  return grown && { ...grown, feather: sel.feather };
}

/** Squared distance from each pixel to the nearest pixel whose value is `target` (Felzenszwalb–Huttenlocher). */
function edt(m: Uint8Array, W: number, H: number, target: number): Float64Array {
  const INF = 1e12, f = new Float64Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = m[i] === target ? 0 : INF;
  const n = Math.max(W, H), v = new Int32Array(n), z = new Float64Array(n + 1), g = new Float64Array(n), out = new Float64Array(n);
  const dt1 = (len: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + g[v[k]]; }
  };
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) g[y] = f[y * W + x]; dt1(H); for (let y = 0; y < H; y++) f[y * W + x] = out[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) g[x] = f[y * W + x]; dt1(W); for (let x = 0; x < W; x++) f[y * W + x] = out[x]; }
  return f;
}

/** Every pixel of `img` (covering `region`) near the colour at the sample point, wherever it sits. */
export function colourRangeSel(img: ImageData, region: Rect, sx: number, sy: number, tolerance: number): Selection | null {
  const W = img.width, H = img.height, d = img.data, x0 = Math.floor(sx - region.x), y0 = Math.floor(sy - region.y);
  if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return null;
  const i0 = (y0 * W + x0) * 4, r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3], tol = tolerance * 255 * 4;
  const m = new Uint8Array(W * H);
  for (let p = 0; p < m.length; p++) {
    const i = p * 4, a = d[i + 3];
    const diff = Math.abs((d[i] * a - r0 * a0) / 255) + Math.abs((d[i + 1] * a - g0 * a0) / 255) + Math.abs((d[i + 2] * a - b0 * a0) / 255) + Math.abs(a - a0);
    if (diff <= tol) m[p] = 1;
  }
  return maskToSelection(m, W, H, region.x, region.y);
}

/** The painted pixels of a surface image (covering `region`). */
export function contentSel(img: ImageData, region: Rect): Selection | null {
  const m = new Uint8Array(img.width * img.height);
  for (let p = 0; p < m.length; p++) if (img.data[p * 4 + 3] > 0) m[p] = 1;
  return maskToSelection(m, img.width, img.height, region.x, region.y);
}
