import type { Selection } from '../core/model';

/**
 * The outline of a pixel mask as polygons along pixel edges: the outer ring in `pts`, holes in `holes`.
 * Rings are simplified so staircases become straight runs; `maxPts` caps the total.
 */
export function maskToSelection(m: Uint8Array, W: number, H: number, ox: number, oy: number, maxPts = 8000): Selection | null {
  const V = W + 1;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1;
  // Directed edges keep the filled side on the right, so every ring runs clockwise around what it encloses.
  const next = new Map<number, number[]>();
  const add = (a: number, b: number) => { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    if (!at(x, y - 1)) add(y * V + x, y * V + x + 1);
    if (!at(x + 1, y)) add(y * V + x + 1, (y + 1) * V + x + 1);
    if (!at(x, y + 1)) add((y + 1) * V + x + 1, (y + 1) * V + x);
    if (!at(x - 1, y)) add((y + 1) * V + x, y * V + x);
  }
  const rings: number[][] = [];
  while (next.size) {
    const start = next.keys().next().value as number;
    const ring: number[] = [];
    let cur = start, prev = -1;
    do {
      ring.push(cur % V + ox, Math.floor(cur / V) + oy);
      const outs = next.get(cur);
      if (!outs?.length) break;
      let k = 0;
      if (outs.length > 1 && prev >= 0) {
        // Two pixels touch at a corner: turn right so each ring stays around its own pixels.
        const dx = cur % V - prev % V, dy = Math.floor(cur / V) - Math.floor(prev / V);
        const want = cur + (-dy) + dx * V;
        k = Math.max(0, outs.indexOf(want));
      }
      const nxt = outs.splice(k, 1)[0];
      if (!outs.length) next.delete(cur);
      prev = cur; cur = nxt;
    } while (cur !== start);
    if (ring.length >= 6) rings.push(ring);
  }
  if (!rings.length) return null;
  let eps = 0.5;
  for (;;) {
    const simple = rings.map((r) => simplify(straight(r), eps)).filter((r) => r.length >= 6);
    const total = simple.reduce((n, r) => n + r.length, 0);
    if (total <= maxPts || eps > 16) {
      if (!simple.length) return null;
      let outer = 0;
      for (let i = 1; i < simple.length; i++) if (Math.abs(area(simple[i])) > Math.abs(area(simple[outer]))) outer = i;
      const holes = simple.filter((_, i) => i !== outer);
      return { pts: simple[outer], holes: holes.length ? holes : undefined };
    }
    eps *= 2;
  }
}

function area(r: number[]) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return a / 2;
}

/** Drops points in the middle of straight runs. */
function straight(r: number[]): number[] {
  const out: number[] = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const px = r[((i + n - 1) % n) * 2], py = r[((i + n - 1) % n) * 2 + 1];
    const x = r[i * 2], y = r[i * 2 + 1], nx = r[((i + 1) % n) * 2], ny = r[((i + 1) % n) * 2 + 1];
    if ((x - px) * (ny - y) !== (y - py) * (nx - x)) out.push(x, y);
  }
  return out;
}

/** Ramer–Douglas–Peucker on a closed ring. */
function simplify(r: number[], eps: number): number[] {
  const n = r.length / 2;
  if (n < 4) return r;
  const keep = new Uint8Array(n);
  // Start from the two points furthest apart so the split is stable.
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const d = (r[i * 2] - r[0]) ** 2 + (r[i * 2 + 1] - r[1]) ** 2;
    if (d > best) { best = d; b = i; }
  }
  keep[a] = keep[b] = 1;
  const stack: [number, number][] = [[a, b], [b, a]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const x0 = r[i0 * 2], y0 = r[i0 * 2 + 1], x1 = r[i1 * 2], y1 = r[i1 * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    let far = -1, fd = eps;
    for (let i = (i0 + 1) % n; i !== i1; i = (i + 1) % n) {
      const d = Math.abs((x1 - x0) * (y0 - r[i * 2 + 1]) - (x0 - r[i * 2]) * (y1 - y0)) / len;
      if (d > fd) { fd = d; far = i; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([i0, far], [far, i1]);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[i * 2], r[i * 2 + 1]);
  return out;
}
