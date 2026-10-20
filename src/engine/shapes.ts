import { Rect, rectFromPoints } from '../core/geom';
import { ShapeKind } from '../core/model';
import { TiledSurface } from '../core/tiles';

export interface ShapeSpec {
  shape: ShapeKind; x0: number; y0: number; x1: number; y1: number; width: number; fill: boolean; color: string;
}

export function shapePath(s: ShapeSpec): Path2D {
  const p = new Path2D();
  const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
  const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
  if (s.shape === 'line') { p.moveTo(s.x0, s.y0); p.lineTo(s.x1, s.y1); }
  else if (s.shape === 'rect') p.rect(x, y, w, h);
  else p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  return p;
}

export function shapeBounds(s: ShapeSpec): Rect {
  return rectFromPoints([s.x0, s.y0, s.x1, s.y1], s.width / 2 + 2)!;
}

export function renderShape(target: TiledSurface, s: ShapeSpec): Rect {
  const path = shapePath(s);
  const box = shapeBounds(s);
  target.draw(box, (ctx) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.fill && s.shape !== 'line') { ctx.fillStyle = s.color; ctx.fill(path); }
    if (s.width > 0) { ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.stroke(path); }
  });
  return box;
}
