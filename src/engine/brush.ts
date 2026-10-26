import { BrushParams } from '../core/model';
import { Rect, ctx2d, lerp, makeCanvas, rectUnion } from '../core/geom';
import { TILE, TiledSurface } from '../core/tiles';

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

/** An op id as a seed, so every client scatters a stroke the same way. */
export function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

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

const paperCache = new Map<string, HTMLCanvasElement>();

/** Opaque grey paper: white where paint takes, darker where grain is deep. Scaled by `scale`. */
function paper(strength: number, scale: number): HTMLCanvasElement {
  const key = strength.toFixed(2) + '|' + scale.toFixed(2);
  let c = paperCache.get(key);
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
    d[i] = d[i + 1] = d[i + 2] = Math.round(255 * (1 - strength * (1 - v)));
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  paperCache.set(key, c);
  return c;
}

/** Stamp sizes are bucketed so a pressure stroke doesn't build one per pixel of diameter. */
function stampSize(d: number) {
  return d <= 32 ? Math.ceil(d) : d <= 128 ? Math.ceil(d / 4) * 4 : d <= 256 ? Math.ceil(d / 16) * 16 : 256;
}

/** A white square dab with the falloff in its alpha, at (about) its own size. */
function stampFor(hardness: number, S: number): HTMLCanvasElement {
  const key = hardness.toFixed(2) + '|' + S;
  let c = stampCache.get(key);
  if (c) return c;
  const R = S / 2;
  c = makeCanvas(S, S);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = Math.round(profile(Math.max(Math.abs(x + 0.5 - R), Math.abs(y + 0.5 - R)) / R, hardness) * 255);
  }
  ctx.putImageData(img, 0, 0);
  if (stampCache.size > 128) stampCache.clear();
  stampCache.set(key, c);
  return c;
}

/** Coverage at distance t (0..1) from a dab's centre: solid to the hardness, then a cosine falloff. */
function profile(t: number, hardness: number) {
  const h = Math.min(hardness, 0.99);
  return t <= h ? 1 : t >= 1 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (t - h)) / (1 - h));
}

const grey = (v: number) => `rgb(${Math.round(v * 255)},${Math.round(v * 255)},${Math.round(v * 255)})`;

/** Stops from the centre (u = 0) to the edge (u = 1) at coverage `level`, placed by `at(u)`. */
function softStops(g: CanvasGradient, hardness: number, level: number, at: (u: number) => number[]) {
  for (let i = 0; i <= 12; i++) {
    const u = i / 12, c = grey(level * profile(u, hardness));
    for (const pos of at(u)) g.addColorStop(pos, c);
  }
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
  /** The pen's lean at the latest sample, in degrees. */
  protected tiltX = 0; protected tiltY = 0;

  constructor(protected brush: BrushParams) {}

  protected abstract dab(x: number, y: number, p: number): Rect | null;

  add(x: number, y: number, p: number, tiltX = 0, tiltY = 0): Rect | null {
    this.tiltX = tiltX; this.tiltY = tiltY;
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

let gctx: CanvasRenderingContext2D | null = null;
/** A context to make patterns and gradients with. */
const gradients = () => gctx ?? (gctx = ctx2d(makeCanvas(1, 1)));

interface Edge { lx: number; ly: number; rx: number; ry: number }
/** A hairline dab: centre, radius, coverage, and its two edge vertices once the next dab is known. */
interface Node extends Edge { x: number; y: number; r: number; a: number }

/** Dabs narrower than this are drawn as a ribbon, since a disc that small is mostly anti-aliasing. */
const THIN = 2.5;
/** Narrower ribbons fade instead, since a thinner polygon would just vanish. */
const MIN_WIDTH = 0.6;

/** How a dab is placed: rotation, and how far it is stretched along `lean`. */
interface Pose { angle: number; stretch: number; lean: number }
type RGB = [number, number, number];

export interface StrokeOptions {
  /** Seeds scatter, jitter and colour dynamics; the op id when drawing, so a replay matches. */
  seed?: string;
  /** The pixels the stroke lands on, for wet mixing. */
  under?: TiledSurface;
}

const rgbToHsv = ([r, g, b]: RGB): RGB => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
};
const hsvToRgb = ([h, s, v]: RGB): RGB => {
  const f = (n: number) => { const k = (n + h / 60) % 6; return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255); };
  return [f(5), f(3), f(1)];
};

/**
 * Paint is laid down as coverage (grey levels) in a scratch surface, where round dabs combine by
 * maximum ('lighten'), so a pixel holds the brush's coverage however many dabs land on it: no
 * build-up pattern, no banding at light pressure. Hairlines are a ribbon of quads added once per
 * pixel instead, since discs that small are all anti-aliasing. Square dabs still stamp over each other.
 * `sync` turns the coverage into coloured pixels in the stroke buffer; it runs after each input event.
 * A brush with colour dynamics or wet mixing also keeps each dab's colour in a tint surface.
 */
export class StrokeRenderer extends DabPath {
  private readonly cov = new TiledSurface();
  private readonly tint: TiledSurface | null;
  private readonly rgb: RGB;
  private col: RGB;
  private readonly square: boolean;
  private readonly soft: boolean;
  private readonly rnd: () => number;
  private readonly under?: TiledSurface;
  private paper: CanvasPattern | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private nodes: Node[] = [];
  private dirty: Rect | null = null;
  private queued = false;
  private px = NaN; private py = NaN; // the previous dab, for the stroke direction

  constructor(private target: TiledSurface, brush: BrushParams, color: string, opts: StrokeOptions = {}) {
    super(brush);
    this.rgb = this.col = hexToRgb(color);
    this.square = brush.shape === 'square';
    this.soft = brush.hardness < 0.98;
    this.rnd = seeded(hashSeed(opts.seed ?? ''));
    this.under = opts.under;
    this.tint = brush.wet || brush.hueJitter || brush.satJitter || brush.brightJitter ? new TiledSurface() : null;
    if (brush.grain) {
      const scale = Math.max(0.25, Math.min(8, brush.grainScale ?? 1));
      this.paper = gradients().createPattern(paper(Math.min(1, brush.grain), scale), 'repeat');
    }
  }

  end(): Rect | null {
    const r = rectUnion(super.end(), this.flush());
    this.sync();
    return r;
  }

  protected dab(x: number, y: number, p: number): Rect | null {
    const b = this.brush, rnd = this.rnd;
    let d = this.diameter(p), a = Math.min(1, this.strength(p));
    const pose: Pose = { angle: ((b.angle ?? 0) * Math.PI) / 180, stretch: 1, lean: 0 };
    if (b.follow && !Number.isNaN(this.px)) pose.angle += Math.atan2(y - this.py, x - this.px);
    this.px = x; this.py = y;
    if (b.sizeJitter) d *= 1 - b.sizeJitter * rnd();
    if (b.flowJitter) a *= 1 - b.flowJitter * rnd();
    if (b.angleJitter) pose.angle += (rnd() - 0.5) * b.angleJitter * Math.PI * 2;
    if (b.scatter) { const r = rnd() * b.scatter * d, t = rnd() * Math.PI * 2; x += Math.cos(t) * r; y += Math.sin(t) * r; }
    if (b.tilt) {
      const lean = Math.min(1, Math.hypot(this.tiltX, this.tiltY) / 60);
      pose.stretch = 1 + b.tilt * lean * 2;
      pose.lean = Math.atan2(this.tiltY, this.tiltX);
      a *= 1 - b.tilt * lean * 0.6;
    }
    if (this.tint) this.col = this.dabColor(x, y);
    if (this.square) return this.stamp(x, y, d, a, pose);
    // The darkness the old pile of overlapping dabs settled at, so every brush keeps its feel.
    const n = Math.max(1, Math.min(1 / b.spacing, d / 0.4));
    const level = 1 - Math.pow(1 - a, n);
    if (d >= THIN) { const r = rectUnion(this.flush(), this.disc(x, y, d, level, pose)); return r; }
    const fade = Math.min(1, d / MIN_WIDTH);
    const nodes = this.nodes;
    nodes.push({ x, y, r: Math.max(d, MIN_WIDTH) / 2, a: level * fade, lx: 0, ly: 0, rx: 0, ry: 0 });
    if (nodes.length < 3) {
      if (nodes.length < 2) return null;
      this.joint(nodes[0], null, nodes[1]);
      return this.cap(nodes[0], nodes[1]);
    }
    const [A, B, C] = nodes;
    this.joint(B, A, C);
    nodes.shift();
    return this.quad(A, B);
  }

  /** This dab's colour: what the brush carries after picking up from the layer, then jittered. */
  private dabColor(x: number, y: number): RGB {
    const b = this.brush;
    let c = this.col;
    if (b.wet && this.under) {
      // Pick up what is under the dab, while the brush slowly recharges with its own colour.
      const u = this.sample(x, y), k = u ? b.wet * u[3] : 0, r = (1 - b.wet) * 0.1, o = this.rgb;
      this.col = c = c.map((v, i) => { const m = v + ((u ? u[i] : v) - v) * k; return m + (o[i] - m) * r; }) as RGB;
    }
    if (!b.hueJitter && !b.satJitter && !b.brightJitter) return c;
    const hsv = rgbToHsv(c), rnd = this.rnd;
    if (b.hueJitter) hsv[0] = (hsv[0] + (rnd() - 0.5) * 2 * b.hueJitter * 360 + 720) % 360;
    if (b.satJitter) hsv[1] = Math.max(0, Math.min(1, hsv[1] + (rnd() - 0.5) * 2 * b.satJitter));
    if (b.brightJitter) hsv[2] = Math.max(0, Math.min(1, hsv[2] + (rnd() - 0.5) * 2 * b.brightJitter));
    return hsvToRgb(hsv);
  }

  /** The layer's colour and alpha under a point, before this stroke. */
  private sample(x: number, y: number): [number, number, number, number] | null {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE), t = this.under!.get(tx, ty);
    if (!t) return [0, 0, 0, 0];
    const px = Math.floor(x - tx * TILE), py = Math.floor(y - ty * TILE);
    if (px < 0 || py < 0 || px >= TILE || py >= TILE) return null;
    const d = t.getContext('2d', { willReadFrequently: true })!.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }

  private fill(c: CanvasRenderingContext2D, level: number) {
    const [r, g, b] = this.col;
    c.fillStyle = c.canvas === this.tintCanvas ? `rgb(${r},${g},${b})` : grey(level);
  }
  private tintCanvas: HTMLCanvasElement | null = null;

  /** A round dab at full coverage `level`, kept by maximum; a tilted pen stretches it along the lean. */
  private disc(x: number, y: number, d: number, level: number, pose: Pose): Rect | null {
    const r = d / 2, R = r * pose.stretch;
    return this.paint({ x: x - R - 1, y: y - R - 1, w: R * 2 + 2, h: R * 2 + 2 }, 'lighten', (c) => {
      c.save();
      c.translate(x, y); c.rotate(pose.lean); c.scale(pose.stretch, 1);
      c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2);
      if (c.canvas === this.tintCanvas || !this.soft) this.fill(c, level);
      else { const g = c.createRadialGradient(0, 0, 0, 0, 0, r); softStops(g, this.brush.hardness, level, (u) => [u]); c.fillStyle = g; }
      c.fill();
      c.restore();
    }, level);
  }

  /** The pending ribbon: its last quad and end cap, or a dot for a tap. */
  private flush(): Rect | null {
    const nodes = this.nodes;
    if (!nodes.length) return null;
    this.nodes = [];
    if (nodes.length === 1) {
      const N = nodes[0];
      return this.paint({ x: N.x - N.r - 1, y: N.y - N.r - 1, w: N.r * 2 + 2, h: N.r * 2 + 2 }, 'lighter', (c) => {
        this.fill(c, N.a); c.beginPath(); c.arc(N.x, N.y, N.r, 0, Math.PI * 2); c.fill();
      }, N.a);
    }
    const [A, B] = nodes;
    this.joint(B, A, null);
    return rectUnion(this.quad(A, B), this.cap(B, A));
  }

  /** Edge vertices at N along the joint's bisector, pushed out so the quads either side meet exactly. */
  private joint(N: Node, prev: Node | null, next: Node | null) {
    const dir = (a: Node, b: Node) => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return [(b.x - a.x) / l, (b.y - a.y) / l]; };
    const [ix, iy] = prev ? dir(prev, N) : dir(N, next!), [ox, oy] = next ? dir(N, next) : [ix, iy];
    let ux = ix + ox, uy = iy + oy;
    const l = Math.hypot(ux, uy);
    if (l < 1e-6) { ux = ix; uy = iy; } else { ux /= l; uy /= l; }
    const m = N.r / Math.max(0.5, ux * ix + uy * iy);
    N.lx = N.x - uy * m; N.ly = N.y + ux * m;
    N.rx = N.x + uy * m; N.ry = N.y - ux * m;
  }

  private quad(A: Node, B: Node): Rect | null {
    const a = (A.a + B.a) / 2;
    const xs = [A.lx, B.lx, B.rx, A.rx], ys = [A.ly, B.ly, B.ry, A.ry];
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return this.paint({ x: x0 - 1, y: y0 - 1, w: Math.max(...xs) - x0 + 2, h: Math.max(...ys) - y0 + 2 }, 'lighter', (c) => {
      this.fill(c, a);
      c.beginPath(); c.moveTo(A.lx, A.ly); c.lineTo(B.lx, B.ly); c.lineTo(B.rx, B.ry); c.lineTo(A.rx, A.ry); c.closePath(); c.fill();
    }, a);
  }

  /** Half a disc on N, facing away from `from`. */
  private cap(N: Node, from: Node): Rect | null {
    const t = Math.atan2(N.y - from.y, N.x - from.x), r = N.r;
    return this.paint({ x: N.x - r - 1, y: N.y - r - 1, w: r * 2 + 2, h: r * 2 + 2 }, 'lighter', (c) => {
      this.fill(c, N.a); c.beginPath(); c.arc(N.x, N.y, r, t - Math.PI / 2, t + Math.PI / 2); c.closePath(); c.fill();
    }, N.a);
  }

  /** Square dabs stamp over each other as they always did; the stamp's alpha is the coverage. */
  private stamp(x: number, y: number, d: number, a: number, pose: Pose): Rect | null {
    if (d < 1) { a *= d; d = 1; }
    const r = d / 2, R = r * pose.stretch * Math.SQRT2, box = { x: x - R - 1, y: y - R - 1, w: R * 2 + 2, h: R * 2 + 2 };
    if (a <= 0.001) return null;
    const stamp = stampFor(this.brush.hardness, stampSize(d));
    const place = (c: CanvasRenderingContext2D) => { c.translate(x, y); c.rotate(pose.lean); c.scale(pose.stretch, 1); c.rotate(pose.angle - pose.lean); };
    if (this.paper) {
      const sc = this.scratchFor(box), c = ctx2d(sc), S = sc.width, ox = Math.floor(box.x), oy = Math.floor(box.y);
      c.save();
      c.clearRect(0, 0, S, S);
      c.translate(-ox, -oy);
      c.fillStyle = this.paper; c.fillRect(ox, oy, S, S);
      c.globalCompositeOperation = 'destination-in';
      place(c);
      c.drawImage(stamp, -r, -r, d, d);
      c.restore();
      this.cov.draw(box, (ctx) => { ctx.globalAlpha = a; ctx.drawImage(sc, 0, 0, S, S, ox, oy, S, S); });
    } else this.cov.draw(box, (ctx) => { ctx.save(); ctx.globalAlpha = a; place(ctx); ctx.drawImage(stamp, -r, -r, d, d); ctx.restore(); });
    if (this.tint) this.tint.draw(box, (ctx) => { ctx.save(); place(ctx); this.tintCanvas = ctx.canvas; this.fill(ctx, 1); this.tintCanvas = null; ctx.fillRect(-r, -r, d, d); ctx.restore(); });
    return this.touched(box);
  }

  private scratchFor(box: Rect) {
    const S = Math.ceil(Math.max(box.w, box.h)) + 1;
    return this.scratch && this.scratch.width >= S ? this.scratch : (this.scratch = makeCanvas(S, S));
  }

  /** Draws `shape` into the coverage with `op`; with grain, the shape is cut by the paper first. */
  private paint(box: Rect, op: GlobalCompositeOperation, shape: (c: CanvasRenderingContext2D) => void, level: number): Rect | null {
    if (level <= 0.002) return null;
    if (this.paper) {
      const sc = this.scratchFor(box), c = ctx2d(sc), S = sc.width, ox = Math.floor(box.x), oy = Math.floor(box.y);
      c.save();
      c.clearRect(0, 0, S, S);
      c.translate(-ox, -oy);
      shape(c);
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = this.paper; c.fillRect(ox, oy, S, S);
      c.globalCompositeOperation = 'destination-in';
      shape(c); // keeps only the shape: 'multiply' painted the paper over the whole square
      c.restore();
      this.cov.draw(box, (ctx) => { ctx.globalCompositeOperation = op; ctx.drawImage(sc, 0, 0, S, S, ox, oy, S, S); });
    } else this.cov.draw(box, (ctx) => { ctx.globalCompositeOperation = op; shape(ctx); });
    // The tint keeps the newest colour: a plain fill, the shape sees which canvas it is on.
    if (this.tint) this.tint.draw(box, (ctx) => { this.tintCanvas = ctx.canvas; shape(ctx); this.tintCanvas = null; });
    return this.touched(box);
  }

  private touched(box: Rect): Rect {
    this.dirty = rectUnion(this.dirty, box);
    if (!this.queued) { this.queued = true; queueMicrotask(() => this.sync()); }
    return box;
  }

  /** Copies the coverage touched since the last call into the stroke buffer as coloured pixels. */
  sync() {
    this.queued = false;
    const d = this.dirty;
    this.dirty = null;
    if (!d) return;
    const [cr, cg, cb] = this.rgb;
    const x0 = Math.floor(d.x), y0 = Math.floor(d.y), x1 = Math.ceil(d.x + d.w), y1 = Math.ceil(d.y + d.h);
    for (let ty = Math.floor(y0 / TILE); ty * TILE < y1; ty++) for (let tx = Math.floor(x0 / TILE); tx * TILE < x1; tx++) {
      const src = this.cov.get(tx, ty);
      if (!src) continue;
      const lx = Math.max(x0, tx * TILE) - tx * TILE, ly = Math.max(y0, ty * TILE) - ty * TILE;
      const w = Math.min(x1, tx * TILE + TILE) - tx * TILE - lx, h = Math.min(y1, ty * TILE + TILE) - ty * TILE - ly;
      if (w <= 0 || h <= 0) continue;
      const img = ctx2d(src).getImageData(lx, ly, w, h), px = img.data;
      const tint = this.tint?.get(tx, ty), tp = tint ? ctx2d(tint).getImageData(lx, ly, w, h).data : null;
      for (let i = 0; i < px.length; i += 4) {
        // Coverage is the premultiplied red channel: level × alpha.
        const v = Math.round((px[i] * px[i + 3]) / 255);
        if (tp && tp[i + 3]) { px[i] = tp[i]; px[i + 1] = tp[i + 1]; px[i + 2] = tp[i + 2]; }
        else { px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; }
        px[i + 3] = v;
      }
      ctx2d(this.target.ensure(tx, ty)).putImageData(img, lx, ly);
      this.target.mark(TiledSurface.key(tx, ty), { x: lx, y: ly, w, h });
    }
  }
}

export function renderStroke(target: TiledSurface, brush: BrushParams, color: string, pts: number[], opts: StrokeOptions & { tilt?: number[] } = {}): Rect | null {
  const r = new StrokeRenderer(target, brush, color, opts);
  const t = opts.tilt;
  let dirty: Rect | null = null;
  for (let i = 0, j = 0; i + 2 < pts.length; i += 3, j += 2) dirty = rectUnion(dirty, r.add(pts[i], pts[i + 1], pts[i + 2], t?.[j] ?? 0, t?.[j + 1] ?? 0));
  return rectUnion(dirty, r.end());
}
