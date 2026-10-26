import { Rect, ctx2d, makeCanvas, rectFromPoints, rectRoundOut, selPath, transformRect } from '../core/geom';
import { Selection } from '../core/model';
import { TiledSurface } from '../core/tiles';
import { featherPad, selMask } from './selection';

export interface Floating { canvas: HTMLCanvasElement; x: number; y: number }

export function selectionBounds(sel: Selection): Rect {
  return rectRoundOut(rectFromPoints(sel.pts)!, 1 + featherPad(sel));
}

export function liftSelection(surface: TiledSurface, sel: Selection): Floating {
  const b = selectionBounds(sel);
  const c = makeCanvas(b.w, b.h);
  const ctx = ctx2d(c);
  ctx.translate(-b.x, -b.y);
  ctx.save();
  if (sel.feather) { surface.drawTo(ctx, b); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selMask(sel, b).canvas, b.x, b.y); }
  else { ctx.clip(selPath(sel), 'evenodd'); surface.drawTo(ctx, b); }
  ctx.restore();
  return { canvas: c, x: b.x, y: b.y };
}

export function clearSelection(surface: TiledSurface, sel: Selection) {
  const path = selPath(sel), b = selectionBounds(sel);
  surface.draw(b, (ctx) => {
    ctx.globalCompositeOperation = 'destination-out';
    if (sel.feather) ctx.drawImage(selMask(sel, b).canvas, b.x, b.y);
    else { ctx.fillStyle = '#000'; ctx.fill(path, 'evenodd'); }
  }, false);
}

export function floatingBounds(f: Floating, m: DOMMatrixReadOnly): Rect {
  return rectRoundOut(transformRect(m, { x: f.x, y: f.y, w: f.canvas.width, h: f.canvas.height }), 2);
}

export function placeFloating(surface: TiledSurface, f: Floating, m: DOMMatrixReadOnly) {
  surface.draw(floatingBounds(f, m), (ctx) => {
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(f.canvas, f.x, f.y);
  });
}

export function transformSel(sel: Selection, m: DOMMatrixReadOnly): Selection {
  return { pts: transformPoly(sel.pts, m), holes: sel.holes?.map((h) => transformPoly(h, m)), feather: sel.feather };
}

export function transformPoly(pts: number[], m: DOMMatrixReadOnly): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const p = m.transformPoint({ x: pts[i], y: pts[i + 1] });
    out.push(p.x, p.y);
  }
  return out;
}
