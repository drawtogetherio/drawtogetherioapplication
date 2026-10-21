
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export function rectEmpty(r: Rect | null | undefined): boolean {
  return !r || r.w <= 0 || r.h <= 0;
}

export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (rectEmpty(a)) return b && !rectEmpty(b) ? { ...b } : null;
  if (rectEmpty(b)) return { ...a! };
  const x = Math.min(a!.x, b!.x), y = Math.min(a!.y, b!.y);
  const r = Math.max(a!.x + a!.w, b!.x + b!.w), btm = Math.max(a!.y + a!.h, b!.y + b!.h);
  return { x, y, w: r - x, h: btm - y };
}

export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

export function rectRoundOut(r: Rect, pad = 0): Rect {
  const x = Math.floor(r.x - pad), y = Math.floor(r.y - pad);
  return { x, y, w: Math.ceil(r.x + r.w + pad) - x, h: Math.ceil(r.y + r.h + pad) - y };
}

export function rectFromPoints(pts: ArrayLike<number>, pad = 0): Rect | null {
  if (pts.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

export function rectContains(r: Rect, x: number, y: number) {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function transformRect(m: DOMMatrixReadOnly, r: Rect): Rect {
  const pts = [
    m.transformPoint({ x: r.x, y: r.y }), m.transformPoint({ x: r.x + r.w, y: r.y }),
    m.transformPoint({ x: r.x, y: r.y + r.h }), m.transformPoint({ x: r.x + r.w, y: r.y + r.h }),
  ];
  return rectFromPoints(pts.flatMap((p) => [p.x, p.y]))!;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

export function pointInPoly(pts: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyPath(pts: number[]): Path2D {
  const p = new Path2D();
  for (let i = 0; i + 1 < pts.length; i += 2) i === 0 ? p.moveTo(pts[i], pts[i + 1]) : p.lineTo(pts[i], pts[i + 1]);
  p.closePath();
  return p;
}

let idCounter = 0;
export function uid(prefix = ''): string {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return prefix + rnd[0].toString(36) + rnd[1].toString(36) + (idCounter++).toString(36);
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, readback = false): CanvasRenderingContext2D {
  return c.getContext('2d', readback ? { willReadFrequently: true } : undefined)!;
}
