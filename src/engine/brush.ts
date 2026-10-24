import { BrushParams } from '../core/model';
import { Rect, ctx2d, lerp, makeCanvas, rectUnion } from '../core/geom';
import { TiledSurface } from '../core/tiles';

export interface BrushPreset { id: string; name: string; params: BrushParams }
export interface BrushCategory { name: string; brushes: BrushPreset[] }

const base: BrushParams = {
  size: 12, opacity: 1, flow: 1, hardness: 1, spacing: 0.08,
  pressureSize: 1, pressureFlow: 0, minSize: 0.05, smoothing: 0.35,
};

/** One library for brush, eraser and smudge; the tool decides what the dabs do. */
export const BRUSH_LIBRARY: BrushCategory[] = [
  { name: 'General', brushes: [
    { id: 'round', name: 'Round Brush', params: { ...base, size: 28, hardness: 0.85, pressureSize: 0.8, pressureFlow: 0.4, minSize: 0.15, smoothing: 0.3 } },
    { id: 'airbrush', name: 'Soft Airbrush', params: { ...base, size: 120, hardness: 0, flow: 0.12, spacing: 0.05, pressureSize: 0, pressureFlow: 1, smoothing: 0.2 } },
    { id: 'cube', name: 'Cube Brush', params: { ...base, size: 24, shape: 'square', spacing: 0.9, pressureSize: 0.6, minSize: 0.3, smoothing: 0.2 } },
    { id: 'flat', name: 'Flat Brush', params: { ...base, size: 30, shape: 'square', hardness: 0.8, flow: 0.9, spacing: 0.06, pressureSize: 0.3, pressureFlow: 0.5, minSize: 0.6, smoothing: 0.3, grain: 0.35, grainScale: 2 } },
  ] },
  { name: 'Pencil', brushes: [
    { id: 'graphite', name: 'Graphite Pencil', params: { ...base, size: 5, hardness: 0.55, flow: 0.55, spacing: 0.06, pressureSize: 0.4, pressureFlow: 0.9, minSize: 0.3, smoothing: 0.15, grain: 0.75, grainScale: 1 } },
    { id: 'pencil', name: 'HB Pencil', params: { ...base, size: 5, hardness: 0.75, flow: 0.8, pressureSize: 0.35, pressureFlow: 0.8, minSize: 0.3, smoothing: 0.15 } },
    { id: 'crayon', name: 'Crayon', params: { ...base, size: 16, hardness: 0.7, flow: 0.85, spacing: 0.07, pressureSize: 0.25, pressureFlow: 0.7, minSize: 0.5, smoothing: 0.2, grain: 0.9, grainScale: 2.5 } },
    { id: 'charcoal', name: 'Charcoal', params: { ...base, size: 22, hardness: 0.4, flow: 0.5, spacing: 0.08, pressureSize: 0.5, pressureFlow: 0.9, minSize: 0.3, smoothing: 0.1, grain: 0.6, grainScale: 1.6 } },
  ] },
  { name: 'Pen', brushes: [
    { id: 'ink', name: 'Ink Pen', params: { ...base, size: 10, smoothing: 0.45 } },
    { id: 'felt', name: 'Felt Tip Pen', params: { ...base, size: 8, hardness: 0.9, flow: 0.95, pressureSize: 0.2, minSize: 0.7, smoothing: 0.35 } },
    { id: 'marker', name: 'Marker', params: { ...base, size: 24, opacity: 0.6, hardness: 0.95, pressureSize: 0, smoothing: 0.3 } },
    { id: 'chisel', name: 'Chisel Marker', params: { ...base, size: 26, shape: 'square', opacity: 0.7, hardness: 1, spacing: 0.05, pressureSize: 0, smoothing: 0.35 } },
  ] },
  { name: 'Eraser', brushes: [
    { id: 'hard-eraser', name: 'Hard Eraser', params: { ...base, size: 30, pressureSize: 0.5, minSize: 0.3, smoothing: 0.2 } },
    { id: 'soft-eraser', name: 'Soft Eraser', params: { ...base, size: 80, hardness: 0, flow: 0.25, spacing: 0.05, pressureSize: 0, pressureFlow: 1, smoothing: 0.2 } },
  ] },
];

export const BRUSH_PRESETS: BrushPreset[] = BRUSH_LIBRARY.flatMap((c) => c.brushes);
export const brushById = (id: string) => BRUSH_PRESETS.find((b) => b.id === id) ?? BRUSH_PRESETS[0];

/** What each tool starts with; the smudge tool reads flow as its strength. */
export const DEFAULT_BRUSH = 'ink', DEFAULT_ERASER = 'hard-eraser', DEFAULT_SMUDGE = 'round';
export const SMUDGE_PARAMS: BrushParams = { ...base, size: 40, flow: 0.7, hardness: 0.5, spacing: 0.12, pressureSize: 0.5, pressureFlow: 0.5, minSize: 0.3, smoothing: 0.3 };

/** A brush picked for smudging keeps its feel but gets a smudge-friendly strength. */
export function smudgeParams(p: BrushParams): BrushParams {
  return { ...p, flow: 0.7, opacity: 1, pressureFlow: Math.min(0.5, p.pressureFlow) };
}

const stampCache = new Map<string, HTMLCanvasElement>();

// ---- Grain: a fixed, seeded value-noise sheet; the same on every device so strokes replay exactly ----

export const GRAIN = 256;
let grainData: Float32Array | null = null;

function seeded(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 0..1 per texel: two octaves of interpolated noise, tileable. */
export function grainSheet(): Float32Array {
  if (grainData) return grainData;
  const rnd = seeded(7);
  const out = new Float32Array(GRAIN * GRAIN);
  const octave = (cell: number, weight: number) => {
    const n = GRAIN / cell, lat = new Float32Array(n * n);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < GRAIN; y++) for (let x = 0; x < GRAIN; x++) {
      const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const at = (i: number, j: number) => lat[((j % n) + n) % n * n + ((i % n) + n) % n];
      const v = lerp(lerp(at(x0, y0), at(x0 + 1, y0), sx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), sx), sy);
      out[y * GRAIN + x] += v * weight;
    }
  };
  octave(2, 0.5); octave(4, 0.3); octave(8, 0.2); // cells must divide the sheet
  return grainData = out;
}

const grainMaskCache = new Map<string, HTMLCanvasElement>();

/** Alpha mask: 1 where paper takes paint, less where grain is deep. Scaled by `scale`. */
function grainMask(strength: number, scale: number): HTMLCanvasElement {
  const key = strength.toFixed(2) + '|' + scale.toFixed(2);
  let c = grainMaskCache.get(key);
  if (c) return c;
  const sheet = grainSheet(), S = Math.max(1, Math.round(GRAIN * scale));
  c = makeCanvas(S, S);
  const ctx = ctx2d(c, true);
  const img = ctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = sheet[Math.floor(y / scale) * GRAIN + Math.floor(x / scale)];
    // Contrast grows with strength, so a light grain only speckles and a heavy one breaks the dab up.
    const v = Math.min(1, Math.max(0, 0.5 + (n - 0.5) * (1 + strength * 3)));
    const i = (y * S + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = Math.round(255 * (1 - strength * (1 - v)));
  }
  ctx.putImageData(img, 0, 0);
  grainMaskCache.set(key, c);
  return c;
}

function stampFor(color: string, hardness: number, square = false): HTMLCanvasElement {
  const key = color + '|' + hardness.toFixed(2) + (square ? '|sq' : '');
  let c = stampCache.get(key);
  if (c) return c;
  const R = 128;
  c = makeCanvas(R * 2, R * 2);
  const ctx = ctx2d(c);
  if (square) {
    // Same cosine falloff as the round stamp, measured to the nearest edge.
    const [r, gg, b] = hexToRgb(color), h = Math.min(hardness, 0.99);
    const img = ctx.createImageData(R * 2, R * 2), d = img.data;
    for (let y = 0; y < R * 2; y++) for (let x = 0; x < R * 2; x++) {
      const t = Math.max(Math.abs(x + 0.5 - R), Math.abs(y + 0.5 - R)) / R;
      const a = t <= h ? 1 : t >= 1 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (t - h)) / (1 - h));
      const i = (y * R * 2 + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    stampCache.set(key, c);
    return c;
  }
  const g = ctx.createRadialGradient(R, R, 0, R, R, R);
  const h = Math.min(hardness, 0.99);
  const [r, gg, b] = hexToRgb(color);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const pos = h + (1 - h) * t;
    const a = 0.5 + 0.5 * Math.cos(Math.PI * t); // smooth cosine falloff
    g.addColorStop(pos, `rgba(${r},${gg},${b},${a})`);
  }
  if (h > 0) g.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, R * 2, R * 2);
  if (stampCache.size > 64) stampCache.clear();
  stampCache.set(key, c);
  return c;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Walks a stroke's samples and places dabs at the brush spacing. Local drawing and replay share it, so pixels match. */
export abstract class DabPath {
  private sx = 0; private sy = 0; private sp = 0; // smoothed input
  private lx = 0; private ly = 0; private lp = 0; // last dab position
  private rawX = 0; private rawY = 0; private rawP = 0;
  private p1 = -1; private p2 = -1; // the two raw pressures before this one
  private started = false;
  private carry = 0; // distance travelled since the last dab

  constructor(protected brush: BrushParams) {}

  protected abstract dab(x: number, y: number, p: number): Rect | null;

  add(x: number, y: number, p: number): Rect | null {
    // Pens jitter at light pressure and some drivers slip in a stray sample; a median of three drops single spikes.
    const pm = this.p2 < 0 ? p : Math.max(Math.min(this.p2, this.p1), Math.min(Math.max(this.p2, this.p1), p));
    this.p2 = this.p1; this.p1 = p; p = pm;
    this.rawX = x; this.rawY = y; this.rawP = p;
    if (!this.started) {
      this.started = true;
      this.sx = this.lx = x; this.sy = this.ly = y; this.sp = this.lp = p;
      return this.dab(x, y, p);
    }
    const k = 1 - this.brush.smoothing * 0.9;
    this.sx += (x - this.sx) * k;
    this.sy += (y - this.sy) * k;
    this.sp += (p - this.sp) * Math.min(0.5, k * 1.5);
    return this.segmentTo(this.sx, this.sy, this.sp);
  }

  end(): Rect | null {
    if (!this.started) return null;
    return this.segmentTo(this.rawX, this.rawY, this.rawP);
  }

  private segmentTo(x: number, y: number, p: number): Rect | null {
    const dx = x - this.lx, dy = y - this.ly;
    const len = Math.hypot(dx, dy);
    let dirty: Rect | null = null;
    if (len < 1e-3) return null;
    // d = position of the previous dab along this segment (negative: it was on an earlier one)
    let d = -this.carry;
    for (;;) {
      const pAt = lerp(this.lp, p, Math.max(0, Math.min(1, d / len)));
      const step = Math.max(0.4, this.diameter(pAt) * this.brush.spacing);
      if (d + step > len) { this.carry = len - d; break; }
      d += step;
      const t = d / len;
      dirty = rectUnion(dirty, this.dab(this.lx + dx * t, this.ly + dy * t, lerp(this.lp, p, t)));
    }
    this.lx = x; this.ly = y; this.lp = p;
    return dirty;
  }

  protected diameter(p: number) {
    const b = this.brush;
    return b.size * lerp(1, lerp(b.minSize, 1, p), b.pressureSize);
  }

  protected strength(p: number) { return this.brush.flow * lerp(1, p, this.brush.pressureFlow); }
}

export class StrokeRenderer extends DabPath {
  private stamp: HTMLCanvasElement | null;
  private readonly square: boolean;
  private grain: CanvasPattern | null = null;
  private scratch: HTMLCanvasElement | null = null;

  constructor(private target: TiledSurface, brush: BrushParams, private color: string) {
    super(brush);
    this.square = brush.shape === 'square';
    this.stamp = brush.hardness >= 0.98 && !this.square ? null : stampFor(color, brush.hardness, this.square);
    if (brush.grain) {
      const scale = Math.max(0.25, Math.min(8, brush.grainScale ?? 1));
      this.grain = ctx2d(makeCanvas(1, 1)).createPattern(grainMask(Math.min(1, brush.grain), scale), 'repeat');
    }
  }

  private paint(ctx: CanvasRenderingContext2D, x: number, y: number, d: number) {
    const r = d / 2;
    if (this.stamp) ctx.drawImage(this.stamp, x - r, y - r, d, d);
    else {
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  protected dab(x: number, y: number, p: number): Rect | null {
    let d = this.diameter(p);
    let a = this.strength(p);
    if (d < 1) { a *= d; d = 1; }
    if (a <= 0.001) return null;
    const r = d / 2;
    const box = { x: x - r - 1, y: y - r - 1, w: d + 2, h: d + 2 };
    if (this.grain) {
      // The dab is cut by the grain sheet in canvas coordinates, so neighbouring dabs share the same paper.
      const S = Math.ceil(d) + 2, ox = Math.floor(x - r) - 1, oy = Math.floor(y - r) - 1;
      const sc = this.scratch && this.scratch.width >= S ? this.scratch : (this.scratch = makeCanvas(S, S));
      const c = ctx2d(sc);
      c.clearRect(0, 0, S, S);
      c.save();
      c.translate(-ox, -oy);
      this.paint(c, x, y, d);
      c.globalCompositeOperation = 'destination-in';
      c.fillStyle = this.grain;
      c.fillRect(ox, oy, S, S);
      c.restore();
      this.target.draw(box, (ctx) => { ctx.globalAlpha = a; ctx.drawImage(sc, 0, 0, S, S, ox, oy, S, S); });
      return box;
    }
    this.target.draw(box, (ctx) => { ctx.globalAlpha = a; this.paint(ctx, x, y, d); });
    return box;
  }
}

export function renderStroke(target: TiledSurface, brush: BrushParams, color: string, pts: number[]): Rect | null {
  const r = new StrokeRenderer(target, brush, color);
  let dirty: Rect | null = null;
  for (let i = 0; i + 2 < pts.length; i += 3) dirty = rectUnion(dirty, r.add(pts[i], pts[i + 1], pts[i + 2]));
  return rectUnion(dirty, r.end());
}
