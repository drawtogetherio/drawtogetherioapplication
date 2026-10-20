import type { BrushParams, ShapeKind } from '../core/model';
import { TiledSurface } from '../core/tiles';
import { BRUSH_PRESETS, BrushPreset, ERASER_PRESETS, renderStroke } from '../engine/brush';
import type { Editor, SelectMode } from '../editor';
import { ctx2d, makeCanvas } from '../core/geom';
import { h } from './dom';
import { icon } from './icons';

export const SELECT_MODES: [SelectMode, string, string][] = [['rect', 'Rectangle', 'selRect'], ['lasso', 'Lasso', 'selLasso'], ['ellipse', 'Ellipse', 'selEllipse']];
export const SHAPE_KINDS: [ShapeKind, string, string][] = [['line', 'Line', 'line'], ['rect', 'Rectangle', 'rect'], ['ellipse', 'Ellipse', 'ellipse']];

const previewCache = new Map<string, HTMLCanvasElement>();

/**
 * A pressure squiggle drawn with the real brush engine: light at both ends, full pressure in the middle,
 * so size and opacity response are visible at a glance.
 */
export function brushPreview(params: BrushParams, w = 220, hh = 52, color = '#f2f2f6'): HTMLCanvasElement {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const key = JSON.stringify(params) + w + 'x' + hh + color + dpr;
  const cached = previewCache.get(key);
  if (cached) return cloneCanvas(cached, w, hh);
  const W = Math.round(w * dpr), H = Math.round(hh * dpr);
  // Big brushes are scaled down so the whole stroke fits; small ones stay true to size.
  const size = Math.min(params.size, H * 0.42) * dpr;
  const p: BrushParams = { ...params, size, smoothing: 0, opacity: params.opacity };
  const pts: number[] = [];
  const pad = size / 2 + 6 * dpr, n = 90;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = pad + (W - pad * 2) * t;
    const y = H / 2 + Math.sin(t * Math.PI * 2.2) * (H / 2 - pad * 0.55 - 4 * dpr) * 0.8;
    pts.push(x, y, Math.max(0.05, Math.sin(Math.PI * t)));
  }
  const surface = new TiledSurface();
  renderStroke(surface, p, color, pts);
  const c = makeCanvas(W, H);
  const ctx = ctx2d(c);
  ctx.globalAlpha = params.opacity;
  surface.drawTo(ctx);
  previewCache.set(key, c);
  return cloneCanvas(c, w, hh);
}

function cloneCanvas(src: HTMLCanvasElement, w: number, hh: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.style.width = w + 'px'; c.style.height = hh + 'px';
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

/** Procreate-style brush library: each preset with its name and a live stroke preview. */
export function brushLibrary(ed: Editor, erase: boolean, onPick: () => void): HTMLElement {
  const st = ed.settings;
  const presets: BrushPreset[] = erase ? ERASER_PRESETS : BRUSH_PRESETS;
  const current = erase ? st.eraserPreset : st.brushPreset;
  const list = h('div.brush-list', { role: 'listbox', 'aria-label': erase ? 'Erasers' : 'Brushes' });
  presets.forEach((pr, i) => {
    const row = h(`button.brush-row${i === current ? '.active' : ''}` as 'button', {
      role: 'option', 'aria-selected': String(i === current), title: pr.name,
      onclick: () => {
        if (erase) { st.eraserPreset = i; st.eraser = { ...pr.params }; } else { st.brushPreset = i; st.brush = { ...pr.params }; }
        ed.setTool(erase ? 'eraser' : 'brush');
        ed.emit('brush');
        onPick();
      },
    }, h('span.brush-name', {}, pr.name), brushPreview(pr.params));
    list.append(row);
  });
  return h('div.panel.brush-library', {}, h('div.panel-head', {}, h('span.panel-title', {}, erase ? 'Eraser' : 'Brush Library')), list);
}

/** Small drop-down with just icons, used for selection modes and shape kinds. */
export function iconChoices<T extends string>(items: [T, string, string][], value: T, pick: (v: T) => void): HTMLElement {
  const el = h('div.panel.icon-choices', { role: 'listbox' });
  for (const [v, label, ic] of items) {
    el.append(h(`button.icon-btn${v === value ? '.active' : ''}` as 'button', {
      role: 'option', 'aria-selected': String(v === value), title: label, 'aria-label': label, html: icon(ic, 22), onclick: () => pick(v),
    }));
  }
  return el;
}
