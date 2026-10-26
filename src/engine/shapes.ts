import { Rect, rectFromPoints } from '../core/geom';
import { ShapeKind } from '../core/model';
import { TiledSurface } from '../core/tiles';

export interface ShapeSpec {
  shape: ShapeKind; x0: number; y0: number; x1: number; y1: number; width: number; fill: boolean; color: string;
  sides?: number; pts?: number[];
}

/** True when the shape has no inside to fill. */
export const openShape = (s: ShapeSpec) => s.shape === 'line' || s.shape === 'arrow' || s.shape === 'arc' || (s.shape === 'polyline' && !closed(s.pts ?? []))
  || (s.shape === 'curve' && !closed(s.pts ?? []));
const closed = (pts: number[]) => pts.length >= 6 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1];

/** The circle through three points, or null when they sit on a line. */
export function circleThrough(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x, y, r: Math.hypot(ax - x, ay - y) };
}

export function shapePath(s: ShapeSpec): Path2D {
  const p = new Path2D();
  const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
  const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0), cx = x + w / 2, cy = y + h / 2;
  const pts = s.pts ?? [];
  const ring = (n: number, inner = 0) => {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2, px = cx + Math.cos(a) * w / 2, py = cy + Math.sin(a) * h / 2;
      i ? p.lineTo(px, py) : p.moveTo(px, py);
      if (inner) { const b = a + Math.PI / n; p.lineTo(cx + Math.cos(b) * w / 2 * inner, cy + Math.sin(b) * h / 2 * inner); }
    }
    p.closePath();
  };
  switch (s.shape) {
    case 'line': p.moveTo(s.x0, s.y0); p.lineTo(s.x1, s.y1); break;
    case 'rect': p.rect(x, y, w, h); break;
    case 'ellipse': p.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'polygon': ring(Math.max(3, s.sides ?? 6)); break;
    case 'star': ring(Math.max(3, s.sides ?? 5), 0.45); break;
    case 'arrow': {
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = Math.hypot(dx, dy) || 1, head = Math.min(len * 0.5, Math.max(14, s.width * 4));
      const ux = dx / len, uy = dy / len;
      p.moveTo(s.x0, s.y0); p.lineTo(s.x1, s.y1);
      p.moveTo(s.x1 - (ux - uy * 0.6) * head, s.y1 - (uy + ux * 0.6) * head); p.lineTo(s.x1, s.y1); p.lineTo(s.x1 - (ux + uy * 0.6) * head, s.y1 - (uy - ux * 0.6) * head);
      break;
    }
    case 'bubble': {
      // A rounded box on the top four fifths; the tail points at the bottom-left corner.
      const bh = h * 0.8, r = Math.min(w, bh) * 0.2, tx = x + w * 0.25, ty = y + bh;
      p.moveTo(x + r, y); p.lineTo(x + w - r, y); p.arcTo(x + w, y, x + w, y + r, r); p.lineTo(x + w, ty - r); p.arcTo(x + w, ty, x + w - r, ty, r);
      p.lineTo(tx + w * 0.15, ty); p.lineTo(x + w * 0.05, y + h); p.lineTo(tx, ty); p.lineTo(x + r, ty); p.arcTo(x, ty, x, ty - r, r); p.lineTo(x, y + r); p.arcTo(x, y, x + r, y, r);
      p.closePath();
      break;
    }
    case 'polyline':
      for (let i = 0; i + 1 < pts.length; i += 2) i ? p.lineTo(pts[i], pts[i + 1]) : p.moveTo(pts[i], pts[i + 1]);
      if (closed(pts)) p.closePath();
      break;
    case 'curve': {
      // A Catmull-Rom spline through the points, as cubic Béziers.
      const n = pts.length / 2, at = (i: number) => [pts[Math.max(0, Math.min(n - 1, i)) * 2], pts[Math.max(0, Math.min(n - 1, i)) * 2 + 1]];
      if (n) p.moveTo(pts[0], pts[1]);
      for (let i = 0; i + 1 < n; i++) {
        const [p0x, p0y] = at(i - 1), [p1x, p1y] = at(i), [p2x, p2y] = at(i + 1), [p3x, p3y] = at(i + 2);
        p.bezierCurveTo(p1x + (p2x - p0x) / 6, p1y + (p2y - p0y) / 6, p2x - (p3x - p1x) / 6, p2y - (p3y - p1y) / 6, p2x, p2y);
      }
      if (closed(pts)) p.closePath();
      break;
    }
    case 'arc': {
      if (pts.length < 6) break;
      const c = circleThrough(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]);
      if (!c) { p.moveTo(pts[0], pts[1]); p.lineTo(pts[4], pts[5]); break; }
      const a0 = Math.atan2(pts[1] - c.y, pts[0] - c.x), am = Math.atan2(pts[3] - c.y, pts[2] - c.x), a1 = Math.atan2(pts[5] - c.y, pts[4] - c.x);
      // Go the way round that passes through the middle point.
      const ccw = ((am - a0 + Math.PI * 4) % (Math.PI * 2)) > ((a1 - a0 + Math.PI * 4) % (Math.PI * 2));
      p.arc(c.x, c.y, c.r, a0, a1, ccw);
      break;
    }
  }
  return p;
}

export function shapeBounds(s: ShapeSpec): Rect {
  const pad = s.width / 2 + 2;
  if (s.shape === 'arc' && s.pts && s.pts.length >= 6) {
    const c = circleThrough(s.pts[0], s.pts[1], s.pts[2], s.pts[3], s.pts[4], s.pts[5]);
    if (c) return rectFromPoints([c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r], pad)!;
  }
  if (s.pts?.length) return rectFromPoints(s.pts, pad + (s.shape === 'curve' ? s.width + 8 : 0))!;
  return rectFromPoints([s.x0, s.y0, s.x1, s.y1], pad + (s.shape === 'arrow' ? Math.max(14, s.width * 4) : 0))!;
}

/** The shape seen through a symmetry map, or null for a box shape the map would turn. */
export function mapShape(m: DOMMatrix, s: ShapeSpec): ShapeSpec | null {
  const r = (v: number) => Math.round(v * 100) / 100;
  const tp = (x: number, y: number) => { const q = m.transformPoint({ x, y }); return [r(q.x), r(q.y)]; };
  if (s.pts) { const pts: number[] = []; for (let i = 0; i + 1 < s.pts.length; i += 2) pts.push(...tp(s.pts[i], s.pts[i + 1])); return { ...s, pts }; }
  const line = s.shape === 'line' || s.shape === 'arrow';
  if (!line && (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9)) return null;
  const [x0, y0] = tp(s.x0, s.y0), [x1, y1] = tp(s.x1, s.y1);
  return { ...s, x0, y0, x1, y1 };
}

export function renderShape(target: TiledSurface, s: ShapeSpec): Rect {
  const path = shapePath(s);
  const box = shapeBounds(s);
  target.draw(box, (ctx) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.fill && !openShape(s)) { ctx.fillStyle = s.color; ctx.fill(path); }
    if (s.width > 0) { ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.stroke(path); }
  });
  return box;
}
