import { BrushParams } from '../core/model';
import { Rect, ctx2d, lerp, makeCanvas, rectUnion } from '../core/geom';
import { TiledSurface } from '../core/tiles';

export interface BrushPreset { name: string; params: BrushParams }

const base: BrushParams = {
  size: 12, opacity: 1, flow: 1, hardness: 1, spacing: 0.08,
  pressureSize: 1, pressureFlow: 0, minSize: 0.05, smoothing: 0.35,
};

export const BRUSH_PRESETS: BrushPreset[] = [
  { name: 'Ink Pen', params: { ...base, size: 10, smoothing: 0.45 } },
  { name: 'Pencil', params: { ...base, size: 5, hardness: 0.75, flow: 0.8, pressureSize: 0.35, pressureFlow: 0.8, minSize: 0.3, smoothing: 0.15 } },
  { name: 'Round Brush', params: { ...base, size: 28, hardness: 0.85, pressureSize: 0.8, pressureFlow: 0.4, minSize: 0.15, smoothing: 0.3 } },
  { name: 'Soft Airbrush', params: { ...base, size: 120, hardness: 0, flow: 0.12, spacing: 0.05, pressureSize: 0, pressureFlow: 1, smoothing: 0.2 } },
  { name: 'Marker', params: { ...base, size: 24, opacity: 0.6, hardness: 0.95, pressureSize: 0, smoothing: 0.3 } },
];

export const ERASER_PRESETS: BrushPreset[] = [
  { name: 'Hard Eraser', params: { ...base, size: 30, pressureSize: 0.5, minSize: 0.3, smoothing: 0.2 } },
  { name: 'Soft Eraser', params: { ...base, size: 80, hardness: 0, flow: 0.25, spacing: 0.05, pressureSize: 0, pressureFlow: 1, smoothing: 0.2 } },
];

const stampCache = new Map<string, HTMLCanvasElement>();

/** A soft round dab image for a colour and hardness. */
function stampFor(color: string, hardness: number): HTMLCanvasElement {
  const key = color + '|' + hardness.toFixed(2);
  let c = stampCache.get(key);
  if (c) return c;
  const R = 128;
  c = makeCanvas(R * 2, R * 2);
  const ctx = ctx2d(c);
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

/**
 * Renders a stroke incrementally into a TiledSurface as a series of dabs. The same class replays
 * a recorded stroke Op, so local drawing and remote replay produce identical pixels.
 */
export class StrokeRenderer {
  private sx = 0; private sy = 0; private sp = 0; // smoothed input
  private lx = 0; private ly = 0; private lp = 0; // last dab position
  private rawX = 0; private rawY = 0; private rawP = 0;
  private started = false;
  private carry = 0; // distance travelled since the last dab
  private stamp: HTMLCanvasElement | null;

  constructor(private target: TiledSurface, private brush: BrushParams, private color: string) {
    this.stamp = brush.hardness >= 0.98 ? null : stampFor(color, brush.hardness);
  }

  add(x: number, y: number, p: number): Rect | null {
    this.rawX = x; this.rawY = y; this.rawP = p;
    if (!this.started) {
      this.started = true;
      this.sx = this.lx = x; this.sy = this.ly = y; this.sp = this.lp = p;
      return this.dab(x, y, p);
    }
    const k = 1 - this.brush.smoothing * 0.9;
    this.sx += (x - this.sx) * k;
    this.sy += (y - this.sy) * k;
    this.sp += (p - this.sp) * Math.min(1, k * 1.5);
    return this.segmentTo(this.sx, this.sy, this.sp);
  }

  /** Finish the stroke: catch the smoothed line up to the final input point. */
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

  private diameter(p: number) {
    const b = this.brush;
    return b.size * lerp(1, lerp(b.minSize, 1, p), b.pressureSize);
  }

  private dab(x: number, y: number, p: number): Rect | null {
    const b = this.brush;
    let d = this.diameter(p);
    let a = b.flow * lerp(1, p, b.pressureFlow);
    if (d < 1) { a *= d; d = 1; }
    if (a <= 0.001) return null;
    const r = d / 2;
    const box = { x: x - r - 1, y: y - r - 1, w: d + 2, h: d + 2 };
    const stamp = this.stamp;
    const color = this.color;
    this.target.draw(box, (ctx) => {
      ctx.globalAlpha = a;
      if (stamp) ctx.drawImage(stamp, x - r, y - r, d, d);
      else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    return box;
  }
}

/** Replay a recorded stroke into a surface. */
export function renderStroke(target: TiledSurface, brush: BrushParams, color: string, pts: number[]): Rect | null {
  const r = new StrokeRenderer(target, brush, color);
  let dirty: Rect | null = null;
  for (let i = 0; i + 2 < pts.length; i += 3) dirty = rectUnion(dirty, r.add(pts[i], pts[i + 1], pts[i + 2]));
  return rectUnion(dirty, r.end());
}
