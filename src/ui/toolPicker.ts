import type { BrushParams, ShapeKind } from '../core/model';
import { TiledSurface } from '../core/tiles';
import { BRUSH_LIBRARY, categoryOf, renderStroke, smudgeParams } from '../engine/brush';
import type { Editor, SelectMode, ToolId } from '../editor';
import { ctx2d, makeCanvas } from '../core/geom';
import { clear, h } from './dom';
import { icon } from './icons';

export const SELECT_MODES: [SelectMode, string, string][] = [['rect', 'Rectangle', 'selRect'], ['lasso', 'Lasso', 'selLasso'], ['ellipse', 'Ellipse', 'selEllipse']];
export const SHAPE_KINDS: [ShapeKind, string, string][] = [['line', 'Line', 'line'], ['rect', 'Rectangle', 'rect'], ['ellipse', 'Ellipse', 'ellipse']];

const previewCache = new Map<string, HTMLCanvasElement>();

/** A squiggle drawn with the real brush engine, light at the ends and full pressure in the middle. */
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

export type BrushTool = Extract<ToolId, 'brush' | 'eraser' | 'smudge'>;

export function currentPreset(ed: Editor, tool: BrushTool) {
  const st = ed.settings;
  return tool === 'eraser' ? st.eraserPreset : tool === 'smudge' ? st.smudgePreset : st.brushPreset;
}

/** Brush, eraser and smudge share one library, in categories; the last tab you looked at stays open. */
export function brushLibrary(ed: Editor, tool: BrushTool, onPick: () => void): HTMLElement {
  const st = ed.settings, current = currentPreset(ed, tool);
  let tab = categoryOf(current);
  const tabs = h('div.brush-tabs', { role: 'tablist' });
  const list = h('div.brush-list', { role: 'listbox', 'aria-label': 'Brushes' });
  const render = () => {
    clear(tabs);
    BRUSH_LIBRARY.forEach((c, i) => tabs.append(h(`button.brush-tab${i === tab ? '.active' : ''}` as 'button', {
      role: 'tab', 'aria-selected': String(i === tab), onclick: () => { tab = i; render(); },
    }, c.name)));
    clear(list);
    for (const pr of BRUSH_LIBRARY[tab].brushes) {
      list.append(h(`button.brush-row${pr.id === current ? '.active' : ''}` as 'button', {
        role: 'option', 'aria-selected': String(pr.id === current), title: pr.name,
        onclick: () => {
          const params = { ...pr.params };
          if (tool === 'eraser') { st.eraserPreset = pr.id; st.eraser = params; }
          else if (tool === 'smudge') { st.smudgePreset = pr.id; st.smudge = smudgeParams(params); }
          else { st.brushPreset = pr.id; st.brush = params; }
          ed.setTool(tool);
          ed.emit('brush');
          onPick();
        },
      }, h('span.brush-name', {}, pr.name), brushPreview(pr.params)));
    }
  };
  render();
  const title = tool === 'eraser' ? 'Eraser' : tool === 'smudge' ? 'Smudge' : 'Brush';
  return h('div.panel.brush-library', {}, h('div.panel-head', {}, h('span.panel-title', {}, title + ' Library')), tabs, list);
}

/** The brush at its real size (shrunk past 120 px) with the current opacity, shown while a sidebar slider moves. */
export function sizePreview(params: BrushParams, color: string): HTMLCanvasElement {
  const W = 220, H = 150, dpr = Math.min(2, window.devicePixelRatio || 1);
  const k = Math.min(1, 120 / params.size);
  const size = params.size * k * dpr;
  const p: BrushParams = { ...params, size, smoothing: 0 };
  const pts: number[] = [];
  const n = 70, pad = size / 2 + 8 * dpr;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(pad + (W * dpr - pad * 2) * t, (H * dpr) / 2 + Math.sin(t * Math.PI * 2) * Math.max(0, (H * dpr) / 2 - pad) * 0.6, Math.max(0.15, Math.sin(Math.PI * t)));
  }
  const surface = new TiledSurface();
  renderStroke(surface, p, color, pts);
  const c = makeCanvas(W * dpr, H * dpr);
  c.style.width = W + 'px'; c.style.height = H + 'px';
  const ctx = ctx2d(c);
  ctx.globalAlpha = params.opacity;
  surface.drawTo(ctx);
  return c;
}

export function iconChoices<T extends string>(items: [T, string, string][], value: T, pick: (v: T) => void): HTMLElement {
  const el = h('div.panel.icon-choices', { role: 'listbox' });
  for (const [v, label, ic] of items) {
    el.append(h(`button.icon-btn${v === value ? '.active' : ''}` as 'button', {
      role: 'option', 'aria-selected': String(v === value), title: label, 'aria-label': label, html: icon(ic, 22), onclick: () => pick(v),
    }));
  }
  return el;
}
