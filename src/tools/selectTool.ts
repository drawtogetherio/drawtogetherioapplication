import { Point, Rect, dist, pointInPoly, polyPath, rectFromPoints, uid } from '../core/geom';
import { Selection } from '../core/model';
import { Floating, liftSelection, transformPoly } from '../engine/transform';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

interface Xform {
  layerId: string;
  sel: Selection; // original selection, before transforming
  float: Floating;
  b: Rect; // local bounds of the selection
  T: Point; rot: number; sx: number; sy: number; // M = translate(T) rotate(rot) scale(sx,sy) translate(-centre)
}

type Drag =
  | { kind: 'select'; x0: number; y0: number; pts: number[] }
  | { kind: 'move'; p0: Point; T0: Point }
  | { kind: 'rotate'; a0: number; rot0: number }
  | { kind: 'scale'; anchor: Point; handle: Point; A: Point; sx0: number; sy0: number; ax: boolean; ay: boolean };

const HANDLE_HIT = 22;

/** Rectangle / ellipse / lasso selection with move, rotate and scale handles. */
export class SelectTool implements Tool {
  xf: Xform | null = null;
  private drag: Drag | null = null;
  private antsTimer = 0;
  private antsOffset = 0;

  constructor(private ed: Editor) { this.startAnts(); }

  deactivate() { this.commit(); }
  busy() { return !!this.drag || !!this.xf; }

  private startAnts() {
    if (this.antsTimer) return;
    this.antsTimer = window.setInterval(() => {
      if (!this.ed.selection) return;
      this.antsOffset = (this.antsOffset + 1) % 16;
      this.ed.view.requestRender();
    }, 120);
  }

  matrix(x: Xform = this.xf!): DOMMatrix {
    const cx = x.b.x + x.b.w / 2, cy = x.b.y + x.b.h / 2;
    return new DOMMatrix().translateSelf(x.T.x, x.T.y).rotateSelf((x.rot * 180) / Math.PI).scaleSelf(x.sx, x.sy).translateSelf(-cx, -cy);
  }

  /** Current outline in document coords (transformed while a transform is active). */
  outline(): number[] | null {
    if (this.xf) return transformPoly(this.xf.sel.pts, this.matrix());
    return this.ed.selection?.pts ?? null;
  }

  private handles(): { pos: Point; local: Point; kind: 'corner' | 'edge' | 'rotate' }[] {
    const sel = this.ed.selection;
    if (!sel) return [];
    const b = this.xf ? this.xf.b : rectFromPoints(sel.pts)!;
    const m = this.xf ? this.matrix() : new DOMMatrix();
    const out: { pos: Point; local: Point; kind: 'corner' | 'edge' | 'rotate' }[] = [];
    const xs = [b.x, b.x + b.w / 2, b.x + b.w], ys = [b.y, b.y + b.h / 2, b.y + b.h];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      if (i === 1 && j === 1) continue;
      const local = { x: xs[i], y: ys[j] };
      out.push({ pos: m.transformPoint(local), local, kind: i !== 1 && j !== 1 ? 'corner' : 'edge' });
    }
    // Rotation handle sits above the top edge, a fixed screen distance away.
    const top = m.transformPoint({ x: b.x + b.w / 2, y: b.y });
    const ctr = m.transformPoint({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const z = this.ed.view.viewport.zoom;
    const len = Math.hypot(top.x - ctr.x, top.y - ctr.y) || 1;
    out.push({
      pos: { x: top.x + ((top.x - ctr.x) / len) * (32 / z), y: top.y + ((top.y - ctr.y) / len) * (32 / z) },
      local: { x: b.x + b.w / 2, y: b.y - 1 }, kind: 'rotate',
    });
    return out;
  }

  /** Lift the selected pixels into a floating transform (lazily, on first drag). */
  private ensureXform(): Xform | null {
    if (this.xf) return this.xf;
    const sel = this.ed.selection;
    if (!sel) return null;
    const layer = this.ed.layer;
    if (!layer.props.visible) { this.ed.toast('This layer is hidden'); return null; }
    const b = rectFromPoints(sel.pts)!;
    this.xf = {
      layerId: layer.props.id, sel, float: liftSelection(layer.surface, sel), b,
      T: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, rot: 0, sx: 1, sy: 1,
    };
    this.updateLive();
    this.ed.emit('tool');
    return this.xf;
  }

  private updateLive() {
    const x = this.xf!;
    this.ed.view.live = {
      layerId: x.layerId, hole: polyPath(x.sel.pts),
      floating: { canvas: x.float.canvas, x: x.float.x, y: x.float.y, m: this.matrix() },
    };
    this.ed.view.invalidate(null);
  }

  down(p: PointerInfo) {
    const sel = this.ed.selection;
    if (sel) {
      const z = this.ed.view.viewport.zoom;
      const hit = this.handles().find((h) => dist(h.pos.x, h.pos.y, p.x, p.y) * z < HANDLE_HIT);
      if (hit) {
        const x = this.ensureXform();
        if (!x) return;
        const m = this.matrix();
        if (hit.kind === 'rotate') {
          this.drag = { kind: 'rotate', a0: Math.atan2(p.y - x.T.y, p.x - x.T.x), rot0: x.rot };
        } else {
          const b = x.b;
          const anchorLocal = { x: b.x + b.x + b.w - hit.local.x, y: b.y + b.y + b.h - hit.local.y };
          this.drag = {
            kind: 'scale', anchor: anchorLocal, handle: hit.local, A: m.transformPoint(anchorLocal),
            sx0: x.sx, sy0: x.sy, ax: hit.local.x !== b.x + b.w / 2, ay: hit.local.y !== b.y + b.h / 2,
          };
        }
        return;
      }
      const outline = this.outline()!;
      if (pointInPoly(outline, p.x, p.y)) {
        const x = this.ensureXform();
        if (!x) return;
        this.drag = { kind: 'move', p0: { x: p.x, y: p.y }, T0: { ...x.T } };
        return;
      }
    }
    // Start a new selection.
    this.commit();
    this.drag = { kind: 'select', x0: p.x, y0: p.y, pts: [p.x, p.y] };
  }

  move(p: PointerInfo) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'select') {
      if (this.ed.settings.selectMode === 'lasso') {
        const n = d.pts.length;
        if (dist(d.pts[n - 2], d.pts[n - 1], p.x, p.y) * this.ed.view.viewport.zoom > 2) d.pts.push(p.x, p.y);
      } else d.pts = [d.x0, d.y0, p.x, p.y];
      if (p.shift && this.ed.settings.selectMode !== 'lasso') {
        const dx = p.x - d.x0, dy = p.y - d.y0, m = Math.max(Math.abs(dx), Math.abs(dy));
        d.pts = [d.x0, d.y0, d.x0 + Math.sign(dx || 1) * m, d.y0 + Math.sign(dy || 1) * m];
      }
      this.ed.view.requestRender();
      return;
    }
    const x = this.xf!;
    if (d.kind === 'move') {
      x.T = { x: d.T0.x + p.x - d.p0.x, y: d.T0.y + p.y - d.p0.y };
    } else if (d.kind === 'rotate') {
      let r = d.rot0 + Math.atan2(p.y - x.T.y, p.x - x.T.x) - d.a0;
      if (p.shift) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
      x.rot = r;
    } else {
      const cos = Math.cos(-x.rot), sin = Math.sin(-x.rot);
      const vx = p.x - d.A.x, vy = p.y - d.A.y;
      const lx = vx * cos - vy * sin, ly = vx * sin + vy * cos; // pointer in the rotated frame
      const dlx = d.handle.x - d.anchor.x, dly = d.handle.y - d.anchor.y;
      let sx = d.sx0, sy = d.sy0;
      if (d.ax && d.ay && !p.shift) {
        // Corner: uniform scale (hold Shift for free scaling).
        const wx = dlx * d.sx0, wy = dly * d.sy0;
        const f = (lx * wx + ly * wy) / (wx * wx + wy * wy || 1);
        sx = d.sx0 * f; sy = d.sy0 * f;
      } else {
        if (d.ax && dlx) sx = lx / dlx;
        if (d.ay && dly) sy = ly / dly;
      }
      const min = 0.01;
      x.sx = Math.abs(sx) < min ? Math.sign(sx || 1) * min : sx;
      x.sy = Math.abs(sy) < min ? Math.sign(sy || 1) * min : sy;
      // Keep the anchor fixed: T = A - R*S*(anchor - centre)
      const cx = x.b.x + x.b.w / 2, cy = x.b.y + x.b.h / 2;
      const ox = (d.anchor.x - cx) * x.sx, oy = (d.anchor.y - cy) * x.sy;
      const c2 = Math.cos(x.rot), s2 = Math.sin(x.rot);
      x.T = { x: d.A.x - (ox * c2 - oy * s2), y: d.A.y - (ox * s2 + oy * c2) };
    }
    this.updateLive();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'select') {
      const sel = this.buildSelection(d.pts);
      this.ed.selection = sel;
      this.ed.emit('selection');
      this.ed.view.requestRender();
    }
  }

  private buildSelection(pts: number[]): Selection | null {
    const mode = this.ed.settings.selectMode;
    const z = this.ed.view.viewport.zoom;
    if (mode === 'lasso') {
      const r = rectFromPoints(pts);
      return pts.length >= 6 && r && r.w * z > 3 && r.h * z > 3 ? { pts } : null;
    }
    const [x0, y0, x1, y1] = pts;
    if (pts.length < 4 || Math.abs(x1 - x0) * z < 3 || Math.abs(y1 - y0) * z < 3) return null;
    const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (mode === 'rect') {
      const X = Math.round(x), Y = Math.round(y), R = Math.round(x + w), B = Math.round(y + h);
      return { pts: [X, Y, R, Y, R, B, X, B] };
    }
    const out: number[] = [];
    const n = Math.max(24, Math.min(180, Math.round((w + h) / 6)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(x + w / 2 + Math.cos(a) * w / 2, y + h / 2 + Math.sin(a) * h / 2);
    }
    return { pts: out };
  }

  /** Apply the pending transform as an op. */
  commit() {
    const x = this.xf;
    if (!x) return;
    this.xf = null;
    this.drag = null;
    this.ed.view.live = null;
    const m = this.matrix(x);
    if (!m.isIdentity && !isNearIdentity(m)) {
      this.ed.apply({ t: 'transform', id: uid(), layer: x.layerId, sel: x.sel, m: [m.a, m.b, m.c, m.d, m.e, m.f] });
      this.ed.selection = { pts: transformPoly(x.sel.pts, m) };
    }
    this.ed.view.invalidate(null);
    this.ed.emit('tool');
  }

  cancel() {
    if (this.drag?.kind === 'select') { this.drag = null; this.ed.view.requestRender(); return; }
    this.drag = null;
    if (!this.xf) return;
    this.xf = null;
    this.ed.view.live = null;
    this.ed.view.invalidate(null);
    this.ed.emit('tool');
  }

  flip(horizontal: boolean) {
    const x = this.ensureXform();
    if (!x) return;
    if (horizontal) x.sx *= -1; else x.sy *= -1;
    this.updateLive();
  }

  selectAll() {
    this.commit();
    const ed = this.ed;
    const r = ed.doc.settings.infinite ? ed.layer.surface.contentBounds() ?? ed.workArea() : ed.workArea();
    ed.selection = { pts: [r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h] };
    ed.emit('selection');
    ed.view.requestRender();
  }

  deselect() {
    this.commit();
    this.ed.selection = null;
    this.ed.emit('selection');
    this.ed.view.requestRender();
  }

  overlay(ctx: CanvasRenderingContext2D, M: DOMMatrix) {
    const d = this.drag;
    if (d?.kind === 'select') {
      const sel = this.buildSelection(d.pts);
      const pts = sel?.pts ?? (this.ed.settings.selectMode === 'lasso' ? d.pts : null);
      if (pts) drawAnts(ctx, M, pts, this.antsOffset, this.ed.settings.selectMode === 'lasso' && !sel);
    }
    if (!this.ed.selection) return;
    if (d?.kind !== 'select') {
      const o = this.outline();
      if (o) drawAnts(ctx, M, o, this.antsOffset, false);
    }
    if (d?.kind === 'select' || this.ed.toolId !== 'select') return;
    const hs = this.handles();
    const rotate = hs.find((h) => h.kind === 'rotate')!;
    const topMid = hs[1];
    const a = M.transformPoint(topMid.pos), b = M.transformPoint(rotate.pos);
    ctx.strokeStyle = 'rgba(80,140,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const h of hs) {
      const s = M.transformPoint(h.pos);
      ctx.beginPath();
      ctx.arc(s.x, s.y, h.kind === 'edge' ? 5 : 7, 0, Math.PI * 2);
      ctx.fillStyle = h.kind === 'rotate' ? '#4f8cff' : '#fff';
      ctx.fill();
      ctx.strokeStyle = h.kind === 'rotate' ? '#fff' : '#4f8cff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function isNearIdentity(m: DOMMatrix) {
  return Math.abs(m.a - 1) < 1e-6 && Math.abs(m.d - 1) < 1e-6 && Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6 && Math.abs(m.e) < 1e-3 && Math.abs(m.f) < 1e-3;
}

function drawAnts(ctx: CanvasRenderingContext2D, M: DOMMatrix, pts: number[], offset: number, open: boolean) {
  ctx.beginPath();
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const p = M.transformPoint({ x: pts[i], y: pts[i + 1] });
    i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
  }
  if (!open) ctx.closePath();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.setLineDash([5, 5]);
  ctx.lineDashOffset = -offset;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.setLineDash([]);
}
