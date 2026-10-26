import { circleThrough, type ShapeSpec } from './shapes';

/** Reads a line, ellipse, arc or polygon out of a freehand stroke, or null when it is none of those. */
export function recognizeShape(stroke: number[], width: number, color: string): ShapeSpec | null {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i + 2 < stroke.length; i += 3) { xs.push(stroke[i]); ys.push(stroke[i + 1]); }
  const n = xs.length;
  if (n < 4) return null;
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (diag < 8) return null;
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const base = { width, color, fill: false, x0, y0, x1, y1 };
  const chord = Math.hypot(xs[n - 1] - xs[0], ys[n - 1] - ys[0]);
  const closed = chord < len * 0.15;

  // A line: nothing strays far from the chord, and the path is barely longer than it.
  if (!closed && chord > len * 0.85 && maxOffset(xs, ys, 0, n - 1) < chord * 0.06) return { ...base, shape: 'line', x0: xs[0], y0: ys[0], x1: xs[n - 1], y1: ys[n - 1] };

  if (closed) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let dev = 0;
    for (let i = 0; i < n; i++) dev += Math.abs(Math.hypot((xs[i] - cx) / (w / 2 || 1), (ys[i] - cy) / (h / 2 || 1)) - 1);
    if (dev / n < 0.1) return { ...base, shape: 'ellipse' };
    const v = simplify(xs, ys, diag * 0.05, true);
    if (v.length >= 3 && v.length <= 12) return { ...base, shape: 'polyline', pts: [...v.flat(), v[0][0], v[0][1]] };
    return null;
  }

  // An arc: the stroke hugs the circle through its ends and middle.
  let mid = 0, acc = 0;
  for (let i = 1; i < n && acc < len / 2; i++) { acc += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); mid = i; }
  const c = circleThrough(xs[0], ys[0], xs[mid], ys[mid], xs[n - 1], ys[n - 1]);
  if (c && c.r < diag * 4) {
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(Math.hypot(xs[i] - c.x, ys[i] - c.y) - c.r));
    if (worst < c.r * 0.08) return { ...base, shape: 'arc', pts: [xs[0], ys[0], xs[mid], ys[mid], xs[n - 1], ys[n - 1]] };
  }
  const v = simplify(xs, ys, diag * 0.05, false);
  if (v.length >= 3 && v.length <= 8) return { ...base, shape: 'polyline', pts: v.flat() };
  return null;
}

/** The furthest any point between a and b sits from the segment a→b. */
function maxOffset(xs: number[], ys: number[], a: number, b: number): number {
  const dx = xs[b] - xs[a], dy = ys[b] - ys[a], l = Math.hypot(dx, dy) || 1;
  let worst = 0;
  for (let i = a + 1; i < b; i++) worst = Math.max(worst, Math.abs((xs[i] - xs[a]) * dy - (ys[i] - ys[a]) * dx) / l);
  return worst;
}

/** Douglas–Peucker corners of the path; a closed path is split at its farthest point first. */
function simplify(xs: number[], ys: number[], eps: number, closed: boolean): [number, number][] {
  const out: [number, number][] = [];
  const rec = (a: number, b: number) => {
    const dx = xs[b] - xs[a], dy = ys[b] - ys[a], l = Math.hypot(dx, dy) || 1;
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = l === 1 && !dx && !dy ? Math.hypot(xs[i] - xs[a], ys[i] - ys[a]) : Math.abs((xs[i] - xs[a]) * dy - (ys[i] - ys[a]) * dx) / l;
      if (d > worst) { worst = d; at = i; }
    }
    if (at < 0 || worst < eps) { out.push([xs[b], ys[b]]); return; }
    rec(a, at); rec(at, b);
  };
  out.push([xs[0], ys[0]]);
  const end = xs.length - 1;
  if (closed) {
    let far = 1, best = 0;
    for (let i = 1; i < end; i++) { const d = Math.hypot(xs[i] - xs[0], ys[i] - ys[0]); if (d > best) { best = d; far = i; } }
    rec(0, far); rec(far, end);
    out.pop();
  } else rec(0, end);
  return out.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
}
