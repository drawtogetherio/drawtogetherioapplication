import type { Rect } from '../core/geom';
import type { GradientStop } from '../core/model';
import type { TiledSurface } from '../core/tiles';
import { hexToRgb } from './brush';

export interface GradientSpec { kind: 'linear' | 'radial'; x0: number; y0: number; x1: number; y1: number; stops: GradientStop[]; region: Rect }

/** Paints the gradient over its whole region; the op's clip trims it when applied. */
export function renderGradient(target: TiledSurface, g: GradientSpec): Rect {
  const r = g.region;
  target.draw(r, (ctx) => {
    const len = Math.hypot(g.x1 - g.x0, g.y1 - g.y0) || 1;
    const grad = g.kind === 'linear' ? ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1) : ctx.createRadialGradient(g.x0, g.y0, 0, g.x0, g.y0, len);
    for (const s of g.stops) { const [cr, cg, cb] = hexToRgb(s.color); grad.addColorStop(s.at, `rgba(${cr},${cg},${cb},${s.alpha})`); }
    ctx.fillStyle = grad;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  });
  return r;
}
