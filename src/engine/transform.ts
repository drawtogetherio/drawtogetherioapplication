import { Rect, ctx2d, makeCanvas, polyPath, rectFromPoints, rectRoundOut, transformRect } from '../core/geom';
import { Selection } from '../core/model';
import { TiledSurface } from '../core/tiles';

export interface Floating { canvas: HTMLCanvasElement; x: number; y: number }

export function selectionBounds(sel: Selection): Rect {
  return rectRoundOut(rectFromPoints(sel.pts)!, 1);
}

/** Copy the selected pixels of a surface into a floating canvas. */
export function liftSelection(surface: TiledSurface, sel: Selection): Floating {
  const b = selectionBounds(sel);
  const c = makeCanvas(b.w, b.h);
  const ctx = ctx2d(c);
  ctx.translate(-b.x, -b.y);
  ctx.save();
  ctx.clip(polyPath(sel.pts));
  surface.drawTo(ctx, b);
  ctx.restore();
  return { canvas: c, x: b.x, y: b.y };
}

/** Erase the selected area from a surface. */
export function clearSelection(surface: TiledSurface, sel: Selection) {
  const path = polyPath(sel.pts);
  surface.draw(selectionBounds(sel), (ctx) => {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(path);
  }, false);
}

export function floatingBounds(f: Floating, m: DOMMatrixReadOnly): Rect {
  return rectRoundOut(transformRect(m, { x: f.x, y: f.y, w: f.canvas.width, h: f.canvas.height }), 2);
}

/** Paint a floating canvas back into a surface through a matrix. */
export function placeFloating(surface: TiledSurface, f: Floating, m: DOMMatrixReadOnly) {
  surface.draw(floatingBounds(f, m), (ctx) => {
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(f.canvas, f.x, f.y);
  });
}

export function transformPoly(pts: number[], m: DOMMatrixReadOnly): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const p = m.transformPoint({ x: pts[i], y: pts[i + 1] });
    out.push(p.x, p.y);
  }
  return out;
}
