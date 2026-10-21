// Pen pressure mapping: a simple exponent, or a curve through draggable points.

export const DEFAULT_CURVE = [0, 0, 1, 1];
export const MAX_CURVE_POINTS = 8;

/** Flat x,y pairs in 0..1, x strictly rising from 0 to 1. */
export function validCurve(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length < 4 || v.length > MAX_CURVE_POINTS * 2 || v.length % 2) return false;
  if (v.some((n) => typeof n !== 'number' || !(n >= 0 && n <= 1))) return false;
  if (v[0] !== 0 || v[v.length - 2] !== 1) return false;
  for (let i = 2; i < v.length; i += 2) if (v[i] <= v[i - 2]) return false;
  return true;
}

/** Monotone cubic (Fritsch–Carlson) through the points, so the curve never overshoots. */
export function curveAt(pts: number[], x: number): number {
  const n = pts.length / 2;
  const xs = (i: number) => pts[i * 2], ys = (i: number) => pts[i * 2 + 1];
  if (x <= 0) return ys(0);
  if (x >= 1) return ys(n - 1);
  const d: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys(i + 1) - ys(i)) / (xs(i + 1) - xs(i)));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let i = 0;
  while (i < n - 2 && x > xs(i + 1)) i++;
  const h = xs(i + 1) - xs(i), t = (x - xs(i)) / h, t2 = t * t, t3 = t2 * t;
  const y = (2 * t3 - 3 * t2 + 1) * ys(i) + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys(i + 1) + (t3 - t2) * h * m[i + 1];
  return Math.max(0, Math.min(1, y));
}
