import type { Editor } from '../editor';
import { Point } from '../core/geom';
import { h } from './dom';
import { Slider } from './slider';
import type { App } from './app';

export type SymmetryMode = 'off' | 'vertical' | 'horizontal' | 'quadrant' | 'radial';
export type GridMode = 'off' | 'square' | 'iso';
export interface GuideSettings {
  symmetry: { mode: SymmetryMode; segments: number; cx: number | null; cy: number | null };
  grid: { mode: GridMode; size: number; snap: boolean; rulers: boolean };
}
export const DEFAULT_GUIDES: GuideSettings = { symmetry: { mode: 'off', segments: 6, cx: null, cy: null }, grid: { mode: 'off', size: 64, snap: false, rulers: false } };

const RULER = 18, COS30 = Math.cos(Math.PI / 6), SIN30 = 0.5;

/** The symmetry centre: as placed, else the canvas middle (the origin on unlimited canvases). */
export function symmetryCentre(ed: Editor): Point {
  const s = ed.settings.guides.symmetry, d = ed.doc.settings;
  return { x: s.cx ?? (d.infinite ? 0 : d.width / 2), y: s.cy ?? (d.infinite ? 0 : d.height / 2) };
}

/** Maps that take a stroke to each of its copies (the identity left out). */
export function symmetryMaps(ed: Editor): DOMMatrix[] {
  const s = ed.settings.guides.symmetry;
  if (s.mode === 'off') return [];
  const { x, y } = symmetryCentre(ed), at = (m: DOMMatrix) => new DOMMatrix().translateSelf(x, y).multiplySelf(m).translateSelf(-x, -y);
  const flipX = new DOMMatrix([-1, 0, 0, 1, 0, 0]), flipY = new DOMMatrix([1, 0, 0, -1, 0, 0]);
  if (s.mode === 'vertical') return [at(flipX)];
  if (s.mode === 'horizontal') return [at(flipY)];
  if (s.mode === 'quadrant') return [at(flipX), at(flipY), at(flipX.multiply(flipY))];
  const n = Math.max(2, Math.min(16, Math.round(s.segments))), out: DOMMatrix[] = [];
  for (let k = 1; k < n; k++) out.push(at(new DOMMatrix().rotateSelf((360 * k) / n)));
  return out;
}

/** Points through a map, three numbers (x, y, pressure) per sample, rounded like the tool rounds them. */
export function mapPts(m: DOMMatrix, pts: number[]): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const p = m.transformPoint({ x: pts[i], y: pts[i + 1] });
    out[i] = Math.round(p.x * 100) / 100; out[i + 1] = Math.round(p.y * 100) / 100; out[i + 2] = pts[i + 2];
  }
  return out;
}

/** The nearest grid point when snapping is on; isometric grids snap to their lattice. */
export function snap(ed: Editor, x: number, y: number): Point {
  const g = ed.settings.guides.grid;
  if (!g.snap || g.mode === 'off') return { x, y };
  const s = Math.max(2, g.size);
  if (g.mode === 'square') return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
  // Lattice basis: e1 = (s·cos30, s·sin30), e2 = (s·cos30, −s·sin30).
  const a = Math.round((x / (s * COS30) + y / (s * SIN30)) / 2), b = Math.round((x / (s * COS30) - y / (s * SIN30)) / 2);
  return { x: (a + b) * s * COS30, y: (a - b) * s * SIN30 };
}

export function drawGuides(ctx: CanvasRenderingContext2D, M: DOMMatrix, ed: Editor) {
  const { grid, symmetry } = ed.settings.guides, vp = ed.view.viewport, d = ed.doc.settings;
  const inv = M.inverse();
  const corners = [[0, 0], [vp.w, 0], [vp.w, vp.h], [0, vp.h]].map(([x, y]) => inv.transformPoint({ x, y }));
  const x0 = Math.min(...corners.map((p) => p.x)), x1 = Math.max(...corners.map((p) => p.x));
  const y0 = Math.min(...corners.map((p) => p.y)), y1 = Math.max(...corners.map((p) => p.y));
  ctx.save();
  if (grid.mode !== 'off') {
    const s = Math.max(2, grid.size), px = s * vp.zoom;
    // Thin out lines closer than 8 screen px.
    const step = s * Math.max(1, 2 ** Math.ceil(Math.log2(8 / px)));
    ctx.save();
    // The context is already scaled for the device pixel ratio; the clip composes with it.
    if (!d.infinite) { const T = ctx.getTransform(); ctx.setTransform(T.multiply(M)); ctx.beginPath(); ctx.rect(0, 0, d.width, d.height); ctx.clip(); ctx.setTransform(T); }
    ctx.strokeStyle = 'rgba(80,140,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const line = (ax: number, ay: number, bx: number, by: number) => { const a = M.transformPoint({ x: ax, y: ay }), b = M.transformPoint({ x: bx, y: by }); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); };
    if (grid.mode === 'square') {
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) line(x, y0, x, y1);
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) line(x0, y, x1, y);
    } else {
      const h = step * SIN30 * 2, span = (x1 - x0) * Math.tan(Math.PI / 6);
      for (let x = Math.floor(x0 / (step * COS30)) * step * COS30; x <= x1; x += step * COS30) line(x, y0, x, y1);
      for (let y = Math.floor((y0 - span) / h) * h; y <= y1 + span; y += h) { line(x0, y, x1, y + (x1 - x0) * Math.tan(Math.PI / 6)); line(x0, y, x1, y - (x1 - x0) * Math.tan(Math.PI / 6)); }
    }
    ctx.stroke();
    ctx.restore();
  }
  if (symmetry.mode !== 'off') {
    const c = symmetryCentre(ed), p = M.transformPoint(c), R = Math.hypot(vp.w, vp.h);
    ctx.strokeStyle = 'rgba(255,120,60,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    const axis = (angle: number) => { ctx.moveTo(p.x - Math.cos(angle) * R, p.y - Math.sin(angle) * R); ctx.lineTo(p.x + Math.cos(angle) * R, p.y + Math.sin(angle) * R); };
    const base = vp.rot;
    if (symmetry.mode === 'vertical' || symmetry.mode === 'quadrant') axis(base + Math.PI / 2);
    if (symmetry.mode === 'horizontal' || symmetry.mode === 'quadrant') axis(base);
    if (symmetry.mode === 'radial') { const n = Math.max(2, symmetry.segments); for (let k = 0; k < n; k++) { const a = base + Math.PI / 2 + (Math.PI * 2 * k) / n; ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(a) * R, p.y + Math.sin(a) * R); } }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,120,60,0.9)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  }
  if (grid.rulers && Math.abs(vp.rot) < 1e-6) drawRulers(ctx, M, vp.w, vp.h, vp.zoom);
  ctx.restore();
}

/** Document pixels along the top and left edges, only when the view is upright. */
function drawRulers(ctx: CanvasRenderingContext2D, M: DOMMatrix, w: number, h: number, zoom: number) {
  const inv = M.inverse();
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const step = steps.find((s) => s * zoom >= 60) ?? 10000, minor = step / 5;
  ctx.fillStyle = 'rgba(30,30,30,0.85)';
  ctx.fillRect(0, 0, w, RULER); ctx.fillRect(0, 0, RULER, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const dx0 = inv.transformPoint({ x: 0, y: 0 }).x, dx1 = inv.transformPoint({ x: w, y: 0 }).x;
  for (let v = Math.floor(Math.min(dx0, dx1) / minor) * minor; v <= Math.max(dx0, dx1); v += minor) {
    const sx = M.transformPoint({ x: v, y: 0 }).x, major = Math.round(v / step) * step === Math.round(v);
    ctx.moveTo(Math.round(sx) + 0.5, major ? 4 : 12); ctx.lineTo(Math.round(sx) + 0.5, RULER);
    if (major) ctx.fillText(String(v), sx + 3, 10);
  }
  const dy0 = inv.transformPoint({ x: 0, y: 0 }).y, dy1 = inv.transformPoint({ x: 0, y: h }).y;
  for (let v = Math.floor(Math.min(dy0, dy1) / minor) * minor; v <= Math.max(dy0, dy1); v += minor) {
    const sy = M.transformPoint({ x: 0, y: v }).y, major = Math.round(v / step) * step === Math.round(v);
    ctx.moveTo(major ? 4 : 12, Math.round(sy) + 0.5); ctx.lineTo(RULER, Math.round(sy) + 0.5);
    if (major) { ctx.save(); ctx.translate(10, sy - 3); ctx.rotate(-Math.PI / 2); ctx.fillText(String(v), 0, 0); ctx.restore(); }
  }
  ctx.stroke();
}

/** The Guides popover: symmetry, grid and rulers, the reference image. */
export function guidesPanel(app: App): HTMLElement {
  const ed = app.ed, g = ed.settings.guides;
  const refresh = () => { ed.view.invalidate(null); render(); };
  const seg = <T extends string>(items: [T, string][], get: () => T, set: (v: T) => void) => {
    const s = h('div.segmented');
    for (const [v, text] of items) s.append(h(`button${v === get() ? '.active' : ''}` as 'button', { type: 'button', onclick: () => { set(v); refresh(); } }, text));
    return s;
  };
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h('input', { type: 'checkbox', role: 'switch' });
    box.checked = get();
    box.addEventListener('change', () => { set(box.checked); refresh(); });
    return h('label.switch-row', {}, h('span', {}, label), box);
  };
  const body = h('div.guides-body');
  const render = () => {
    const rows: (HTMLElement | null)[] = [
      h('div.pref-sub', {}, 'Symmetry'),
      seg([['off', 'Off'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal'], ['quadrant', 'Quadrant'], ['radial', 'Radial']], () => g.symmetry.mode, (v) => { g.symmetry.mode = v; }),
      g.symmetry.mode === 'radial' ? new Slider({ min: 2, max: 16, value: g.symmetry.segments, label: 'Segments', format: (v) => String(Math.round(v)), onInput: (v) => { g.symmetry.segments = Math.round(v); ed.view.invalidate(null); }, step: 1 }).el : null,
      g.symmetry.mode !== 'off' ? h('div.row', {},
        h('button.btn.small', { type: 'button', onclick: () => { const c = ed.view.viewport; g.symmetry.cx = Math.round(c.cx); g.symmetry.cy = Math.round(c.cy); refresh(); } }, 'Centre on view'),
        h('button.btn.small', { type: 'button', onclick: () => { g.symmetry.cx = g.symmetry.cy = null; refresh(); } }, 'Reset centre')) : null,
      h('div.pref-sub', {}, 'Grid'),
      seg([['off', 'Off'], ['square', 'Square'], ['iso', 'Isometric']], () => g.grid.mode, (v) => { g.grid.mode = v; }),
      g.grid.mode !== 'off' ? new Slider({ min: 4, max: 512, value: g.grid.size, label: 'Size', format: (v) => Math.round(v) + 'px', onInput: (v) => { g.grid.size = Math.round(v); ed.view.invalidate(null); }, step: 1 }).el : null,
      g.grid.mode !== 'off' ? toggle('Snap shapes and selections to it', () => g.grid.snap, (v) => { g.grid.snap = v; }) : null,
      toggle('Rulers', () => g.grid.rulers, (v) => { g.grid.rulers = v; }),
      h('div.pref-sub', {}, 'Reference'),
      h('button.btn.small', { type: 'button', onclick: () => app.reference.open() }, 'Open reference image…'),
    ];
    body.replaceChildren(...rows.filter((r): r is HTMLElement => !!r));
  };
  render();
  return h('div.panel.guides-panel', {}, h('div.panel-head', {}, h('span.panel-title', {}, 'Guides')), body);
}
