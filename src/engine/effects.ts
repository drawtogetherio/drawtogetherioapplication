import type { EffectId, Op } from '../core/model';

// Layer effects, baked into pixels once. Everything here is plain arithmetic in a fixed order, so
// every device gets the same bytes and the op replays exactly. `amount` is 0..1.

export type EffectOp = Extract<Op, { t: 'effect' }>;

export const EFFECT_INFO: Record<EffectId, { name: string; amount: string; angle?: boolean }> = {
  blur: { name: 'Gaussian blur', amount: 'Radius' },
  motion: { name: 'Motion blur', amount: 'Length', angle: true },
  mosaic: { name: 'Mosaic', amount: 'Cell size' },
  chroma: { name: 'Chromatic aberration', amount: 'Offset' },
  glitch: { name: 'Glitch', amount: 'Intensity' },
  sharpen: { name: 'Sharpen', amount: 'Strength' },
  noise: { name: 'Noise', amount: 'Amount' },
};

const blurRadius = (a: number) => Math.round(a * 40);
const motionLen = (a: number) => Math.round(a * 40);
const cellSize = (a: number) => 2 + Math.round(a * 60);
const chromaOffset = (a: number) => Math.round(a * 20);

/** How far pixels can travel, so the processed region grows by this much on every side. */
export function effectReach(op: EffectOp): number {
  switch (op.effect) {
    case 'blur': return blurRadius(op.amount) * 3;
    case 'motion': return motionLen(op.amount);
    case 'mosaic': return cellSize(op.amount);
    case 'chroma': return chromaOffset(op.amount);
    case 'glitch': return Math.round(op.amount * 60);
    case 'sharpen': return 2;
    case 'noise': return 0;
  }
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seeded(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Pixels as premultiplied floats, blurred and shifted without dark fringes. */
function toPre(d: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a; out[i + 1] = d[i + 1] * a; out[i + 2] = d[i + 2] * a; out[i + 3] = d[i + 3];
  }
  return out;
}

function fromPre(p: Float32Array, d: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i += 4) {
    const a = p[i + 3];
    if (a < 0.5) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
    const k = 255 / a;
    d[i] = p[i] * k; d[i + 1] = p[i + 1] * k; d[i + 2] = p[i + 2] * k; d[i + 3] = a;
  }
}

/** One box-blur pass along x or y with a running sum; three passes make a Gaussian. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const n = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4, lineStep = horizontal ? w * 4 : 4;
  const inv = 1 / (r * 2 + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[base + Math.min(n - 1, Math.max(0, i)) * step + c];
      for (let i = 0; i < n; i++) {
        dst[base + i * step + c] = sum * inv;
        sum += src[base + Math.min(n - 1, i + r + 1) * step + c] - src[base + Math.max(0, i - r) * step + c];
      }
    }
  }
}

function gaussian(p: Float32Array, w: number, h: number, r: number) {
  if (r < 1) return p;
  let a = p, b = new Float32Array(p.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, r, true); boxPass(b, a, w, h, r, false);
  }
  return a;
}

function motion(p: Float32Array, w: number, h: number, len: number, angle: number): Float32Array {
  if (len < 1) return p;
  const out = new Float32Array(p.length), dx = Math.cos(angle), dy = Math.sin(angle), n = len * 2 + 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let t = -len; t <= len; t++) {
      const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t))), sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)));
      const i = (sy * w + sx) * 4;
      r += p[i]; g += p[i + 1]; b += p[i + 2]; a += p[i + 3];
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
  return out;
}

function mosaic(p: Float32Array, w: number, h: number, cell: number, ox: number, oy: number) {
  const x0 = Math.floor(ox / cell) * cell - ox, y0 = Math.floor(oy / cell) * cell - oy;
  for (let cy = y0; cy < h; cy += cell) for (let cx = x0; cx < w; cx += cell) {
    const xa = Math.max(0, cx), ya = Math.max(0, cy), xb = Math.min(w, cx + cell), yb = Math.min(h, cy + cell);
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { const i = (y * w + x) * 4; r += p[i]; g += p[i + 1]; b += p[i + 2]; a += p[i + 3]; n++; }
    if (!n) continue;
    r /= n; g /= n; b /= n; a /= n;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { const i = (y * w + x) * 4; p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = a; }
  }
}

/** Red moves left and blue right; alpha is the widest of the three so the edges keep their colour fringe. */
function chroma(p: Float32Array, w: number, h: number, off: number): Float32Array {
  if (off < 1) return p;
  const out = new Float32Array(p.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const l = (y * w + Math.min(w - 1, x + off)) * 4, r = (y * w + Math.max(0, x - off)) * 4;
    out[i] = p[l]; out[i + 1] = p[i + 1]; out[i + 2] = p[r];
    out[i + 3] = Math.max(p[l + 3], p[i + 3], p[r + 3]);
  }
  return out;
}

function glitch(p: Float32Array, w: number, h: number, amount: number, rnd: () => number): Float32Array {
  const out = new Float32Array(p);
  const bands = Math.round(4 + amount * 30), shift = Math.round(amount * 60);
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor(rnd() * h), hh = 1 + Math.floor(rnd() * Math.max(1, h * 0.08)), dx = Math.round((rnd() * 2 - 1) * shift);
    const channel = rnd() < 0.4 ? Math.floor(rnd() * 3) : -1;
    for (let y = y0; y < Math.min(h, y0 + hh); y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx)), si = (y * w + sx) * 4, di = (y * w + x) * 4;
      if (channel < 0) { out[di] = p[si]; out[di + 1] = p[si + 1]; out[di + 2] = p[si + 2]; out[di + 3] = p[si + 3]; }
      else { out[di + channel] = p[si + channel]; out[di + 3] = Math.max(out[di + 3], p[si + 3]); }
    }
  }
  return out;
}

function sharpen(p: Float32Array, w: number, h: number, amount: number) {
  const soft = gaussian(new Float32Array(p), w, h, 1), k = amount * 2;
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    for (let c = 0; c < 3; c++) p[i + c] = Math.min(a, Math.max(0, p[i + c] + (p[i + c] - soft[i + c]) * k));
  }
  return p;
}

function noise(p: Float32Array, amount: number, rnd: () => number) {
  const k = amount * 80;
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3];
    if (a <= 0) continue;
    const n = (rnd() * 2 - 1) * k * (a / 255);
    for (let c = 0; c < 3; c++) p[i + c] = Math.min(a, Math.max(0, p[i + c] + n));
  }
  return p;
}

/** Applies `op` to `img`, whose top-left is at (ox, oy) on the canvas. */
export function applyEffect(img: ImageData, op: EffectOp, ox: number, oy: number) {
  const w = img.width, h = img.height, rnd = seeded(hash(op.id));
  let p = toPre(img.data);
  switch (op.effect) {
    case 'blur': p = gaussian(p, w, h, blurRadius(op.amount)); break;
    case 'motion': p = motion(p, w, h, motionLen(op.amount), op.angle ?? 0); break;
    case 'mosaic': mosaic(p, w, h, cellSize(op.amount), ox, oy); break;
    case 'chroma': p = chroma(p, w, h, chromaOffset(op.amount)); break;
    case 'glitch': p = glitch(p, w, h, op.amount, rnd); break;
    case 'sharpen': sharpen(p, w, h, op.amount); break;
    case 'noise': noise(p, op.amount, rnd); break;
  }
  fromPre(p, img.data);
}
