import { type Adjustment, type EffectId, type Op, isAdjustment } from '../core/model';
import { curveAt } from '../shared/curve';
import { hexToRgb, seeded } from './brush';

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
  hsb: { name: 'Hue / saturation / brightness', amount: 'Mix' },
  balance: { name: 'Colour balance', amount: 'Mix' },
  curves: { name: 'Curves', amount: 'Mix' },
  levels: { name: 'Levels', amount: 'Mix' },
  invert: { name: 'Invert', amount: 'Mix' },
  gradientMap: { name: 'Gradient map', amount: 'Mix' },
};

/** Default settings of each adjustment: its params (sliders / curve points) and colours. */
export const ADJUST_DEFAULTS: Record<string, { params?: number[]; colors?: string[] }> = {
  hsb: { params: [0, 0, 0] },
  balance: { params: [0, 0, 0] },
  curves: { params: [0, 0, 1, 1] },
  levels: { params: [0, 1, 1, 0, 1] },
  invert: {},
  gradientMap: { colors: ['#1b1b4a', '#ff9a3c'] },
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
    default: return 0;
  }
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** A 256-entry lookup for one channel, from a 0..1 → 0..1 function. */
function lut(fn: (x: number) => number): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = clamp(Math.round(fn(i / 255) * 255));
  return t;
}

/**
 * Recolours straight (not premultiplied) RGBA in place. `amount` mixes the result with the original;
 * `weight`, when given, scales it per pixel (an adjustment layer's mask).
 */
export function adjustPixels(d: Uint8ClampedArray, adj: Adjustment, weight?: Uint8ClampedArray) {
  const p = adj.params ?? ADJUST_DEFAULTS[adj.effect].params ?? [], cols = (adj.colors ?? ADJUST_DEFAULTS[adj.effect].colors ?? []).map(hexToRgb);
  let f: (r: number, g: number, b: number, o: Float64Array) => void;
  switch (adj.effect) {
    case 'hsb': {
      const hue = (p[0] ?? 0) * 180, sat = 1 + (p[1] ?? 0), bri = (p[2] ?? 0) * 255;
      f = (r, g, b, o) => {
        const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, c = max - min;
        let h = 0;
        if (c) { h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4; h = (h * 60 + 360 + hue) % 360; }
        const s0 = c ? c / (255 - Math.abs(2 * l - 255)) : 0, s = Math.min(1, s0 * sat);
        const c2 = (255 - Math.abs(2 * l - 255)) * s, x = c2 * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c2 / 2;
        const k = Math.floor(h / 60);
        const [rr, gg, bb] = k === 0 ? [c2, x, 0] : k === 1 ? [x, c2, 0] : k === 2 ? [0, c2, x] : k === 3 ? [0, x, c2] : k === 4 ? [x, 0, c2] : [c2, 0, x];
        o[0] = rr + m + bri; o[1] = gg + m + bri; o[2] = bb + m + bri;
      };
      break;
    }
    case 'balance': {
      // Midtone-weighted shifts: strongest at 50% grey, fading towards black and white.
      const sh = [(p[0] ?? 0) * 110, (p[1] ?? 0) * 110, (p[2] ?? 0) * 110];
      f = (r, g, b, o) => {
        const l = (r + g + b) / 3, w = 1 - Math.abs(l - 128) / 128;
        o[0] = r + sh[0] * w; o[1] = g + sh[1] * w; o[2] = b + sh[2] * w;
      };
      break;
    }
    case 'curves': {
      const t = lut((x) => curveAt(p.length >= 4 ? p : [0, 0, 1, 1], x));
      f = (r, g, b, o) => { o[0] = t[r]; o[1] = t[g]; o[2] = t[b]; };
      break;
    }
    case 'levels': {
      const [ib = 0, iw = 1, gamma = 1, ob = 0, ow = 1] = p;
      const t = lut((x) => { const v = Math.max(0, Math.min(1, (x - ib) / Math.max(0.001, iw - ib))); return ob + Math.pow(v, 1 / Math.max(0.1, gamma)) * (ow - ob); });
      f = (r, g, b, o) => { o[0] = t[r]; o[1] = t[g]; o[2] = t[b]; };
      break;
    }
    case 'invert':
      f = (r, g, b, o) => { o[0] = 255 - r; o[1] = 255 - g; o[2] = 255 - b; };
      break;
    case 'gradientMap': {
      const n = Math.max(2, cols.length);
      f = (r, g, b, o) => {
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 * (n - 1), i = Math.min(n - 2, Math.floor(l)), t = l - i;
        const a = cols[i] ?? cols[0], c = cols[i + 1] ?? cols[cols.length - 1];
        o[0] = a[0] + (c[0] - a[0]) * t; o[1] = a[1] + (c[1] - a[1]) * t; o[2] = a[2] + (c[2] - a[2]) * t;
      };
      break;
    }
    default: return;
  }
  const o = new Float64Array(3);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    if (!d[i + 3]) continue;
    const k = adj.amount * (weight ? weight[j] / 255 : 1);
    if (!k) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    f(r, g, b, o);
    d[i] = clamp(Math.round(r + (o[0] - r) * k)); d[i + 1] = clamp(Math.round(g + (o[1] - g) * k)); d[i + 2] = clamp(Math.round(b + (o[2] - b) * k));
  }
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
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
  if (isAdjustment(op.effect)) { adjustPixels(img.data, op); return; }
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
