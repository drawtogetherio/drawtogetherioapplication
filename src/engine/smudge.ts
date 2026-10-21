import { BrushParams, Op } from '../core/model';
import { Rect, polyPath, rectUnion } from '../core/geom';
import { TiledSurface, TileSnapshot } from '../core/tiles';
import { DabPath } from './brush';

type SmudgeOp = Extract<Op, { t: 'smudge' }>;

const readCtx = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

/**
 * Each dab lays down the paint carried from the previous one, then picks up some of what is now
 * under it. Pixels mix premultiplied, so edges and transparency smear along with colour.
 */
export class SmudgeRenderer extends DabPath {
  private readonly D: number;
  private held: Float32Array | null = null;
  private readonly scratch: HTMLCanvasElement;
  private readonly clip: Path2D | null;
  private readonly clipCanvas: HTMLCanvasElement | null;

  constructor(private surface: TiledSurface, brush: BrushParams, clip?: number[], private before?: TileSnapshot) {
    super(brush);
    this.D = Math.ceil(brush.size) + 2;
    this.scratch = square(this.D);
    this.clip = clip ? polyPath(clip) : null;
    this.clipCanvas = clip ? square(this.D) : null;
  }

  protected dab(x: number, y: number, p: number): Rect | null {
    const D = this.D, r = this.diameter(p) / 2, s = this.strength(p);
    const bx = Math.round(x - D / 2), by = Math.round(y - D / 2);
    const box = { x: bx, y: by, w: D, h: D };
    if (this.before) this.surface.snapshot(this.surface.keysIn(box), this.before);
    const ctx = readCtx(this.scratch);
    ctx.clearRect(0, 0, D, D);
    ctx.save();
    ctx.translate(-bx, -by);
    this.surface.drawTo(ctx, box);
    ctx.restore();
    const img = ctx.getImageData(0, 0, D, D);
    const d = img.data;
    const held = this.held;
    if (!held) { this.held = premultiplied(d); return null; }
    if (s <= 0.001 || r < 0.5) return null;
    const clipA = this.clipAlpha(bx, by);
    const h = Math.min(this.brush.hardness, 0.99), cx = x - bx, cy = y - by;
    let any = false;
    for (let j = 0, i = 0; j < D; j++) {
      for (let k = 0; k < D; k++, i += 4) {
        const dist = Math.hypot(k + 0.5 - cx, j + 0.5 - cy) / r;
        if (dist >= 1) continue;
        let a = s * (dist <= h ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (dist - h)) / (1 - h)));
        if (clipA) a *= clipA[i + 3] / 255;
        if (a <= 0) continue;
        const ua = d[i + 3];
        const ur = d[i] * ua, ug = d[i + 1] * ua, ub = d[i + 2] * ua;
        const nr = ur + (held[i] - ur) * a, ng = ug + (held[i + 1] - ug) * a, nb = ub + (held[i + 2] - ub) * a;
        const na = ua + (held[i + 3] - ua) * a;
        if (na > 0.5) { d[i] = nr / na; d[i + 1] = ng / na; d[i + 2] = nb / na; any = true; }
        d[i + 3] = na;
        held[i] += (nr - held[i]) * (1 - s); held[i + 1] += (ng - held[i + 1]) * (1 - s);
        held[i + 2] += (nb - held[i + 2]) * (1 - s); held[i + 3] += (na - held[i + 3]) * (1 - s);
      }
    }
    ctx.putImageData(img, 0, 0);
    this.surface.draw(box, (c) => { c.clearRect(bx, by, D, D); c.drawImage(this.scratch, bx, by); }, any);
    return box;
  }

  private clipAlpha(bx: number, by: number): Uint8ClampedArray | null {
    if (!this.clip || !this.clipCanvas) return null;
    const D = this.D, c = readCtx(this.clipCanvas);
    c.clearRect(0, 0, D, D);
    c.save();
    c.translate(-bx, -by);
    c.fillStyle = '#fff';
    c.fill(this.clip);
    c.restore();
    return c.getImageData(0, 0, D, D).data;
  }
}

function square(n: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return c;
}

function premultiplied(d: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    out[i] = d[i] * a; out[i + 1] = d[i + 1] * a; out[i + 2] = d[i + 2] * a; out[i + 3] = a;
  }
  return out;
}

export function renderSmudge(surface: TiledSurface, op: SmudgeOp): Rect | null {
  const r = new SmudgeRenderer(surface, op.brush, op.clip?.pts);
  let dirty: Rect | null = null;
  for (let i = 0; i + 2 < op.pts.length; i += 3) dirty = rectUnion(dirty, r.add(op.pts[i], op.pts[i + 1], op.pts[i + 2]));
  return rectUnion(dirty, r.end());
}

/** Every tile a smudge can reach, known before any pixel moves. */
export function smudgeKeys(surface: TiledSurface, op: SmudgeOp): string[] {
  const pad = op.brush.size / 2 + 2;
  let r: Rect | null = null;
  for (let i = 0; i + 2 < op.pts.length; i += 3) r = rectUnion(r, { x: op.pts[i] - pad, y: op.pts[i + 1] - pad, w: pad * 2, h: pad * 2 });
  return r ? surface.keysIn(r) : [];
}
