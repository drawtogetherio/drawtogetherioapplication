import { Rect, ctx2d, makeCanvas } from '../core/geom';
import { hexToRgb } from './brush';

/** Flood fill over `src` (covering `region`). Returns the fill as a canvas of the same size, or null. */
export function floodFill(
  src: ImageData, region: Rect, seedX: number, seedY: number, color: string, tolerance: number, expand: number,
): HTMLCanvasElement | null {
  const W = src.width, H = src.height;
  const sx = Math.floor(seedX - region.x), sy = Math.floor(seedY - region.y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const d = src.data;
  const i0 = (sy * W + sx) * 4;
  const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
  const tol = tolerance * 255 * 4;
  const match = (i: number) => {
    // Premultiplied-ish comparison so transparent pixels of any colour count as equal.
    const a = d[i + 3];
    const dr = Math.abs((d[i] * a - r0 * a0) / 255), dg = Math.abs((d[i + 1] * a - g0 * a0) / 255);
    const db = Math.abs((d[i + 2] * a - b0 * a0) / 255), da = Math.abs(a - a0);
    return dr + dg + db + da <= tol;
  };

  const mask = new Uint8Array(W * H);
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    let x = x0;
    let p = y * W + x;
    while (x >= 0 && !mask[p] && match(p * 4)) { x--; p--; }
    x++; p++;
    let up = false, down = false;
    while (x < W && !mask[p] && match(p * 4)) {
      mask[p] = 1;
      if (y > 0) {
        const q = p - W;
        if (!mask[q] && match(q * 4)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
      }
      if (y < H - 1) {
        const q = p + W;
        if (!mask[q] && match(q * 4)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
      }
      x++; p++;
    }
  }

  let m: Uint8Array = mask;
  for (let e = 0; e < expand; e++) m = dilate(m, W, H);

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
