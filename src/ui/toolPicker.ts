import type { BrushParams, ShapeKind } from '../core/model';
import { TiledSurface } from '../core/tiles';
import { BRUSH_LIBRARY, BrushCategory, BrushPreset, renderStroke, smudgeParams } from '../engine/brush';
import { brushCode, parseBrushCode } from '../shared/brush';
import { BUILTIN_CATEGORIES, CustomBrush, MAX_CATEGORIES, MAX_CUSTOM_BRUSHES, applyPressure, cleanName } from '../shared/prefs';
import type { App } from './app';
import { brushEditor, newCategory, removeBrush, shareable } from './brushEditor';
import { importBrushFile } from '../io/brushImport';
import { ensureAssets } from '../engine/brushAssets';
import { brushAssets } from '../shared/brushAssets';
import { confirmDialog, textDialog } from './dialogs';
import type { Editor, FillMode, SelectMode, ToolId } from '../editor';
import { ctx2d, makeCanvas, uid } from '../core/geom';
import { clear, dismissOnOutside, h } from './dom';
import { icon } from './icons';

export const SELECT_MODES: [SelectMode, string, string][] = [['rect', 'Rectangle', 'selRect'], ['lasso', 'Lasso', 'selLasso'], ['ellipse', 'Ellipse', 'selEllipse'], ['wand', 'Magic wand', 'wand'], ['range', 'Colour range', 'colorRange']];
export const FILL_MODES: [FillMode, string, string][] = [['bucket', 'Bucket', 'fill'], ['lasso', 'Fill lasso', 'lassoFill'], ['gradient', 'Gradient', 'gradient']];
export const SHAPE_KINDS: [ShapeKind, string, string][] = [
  ['line', 'Line', 'line'], ['arrow', 'Arrow', 'arrow'], ['rect', 'Rectangle', 'rect'], ['ellipse', 'Ellipse', 'ellipse'], ['polygon', 'Polygon', 'polygon'],
  ['star', 'Star', 'star'], ['bubble', 'Speech bubble', 'bubble'], ['polyline', 'Polyline', 'polyline'], ['curve', 'Curve', 'curve'], ['arc', 'Arc', 'arc'],
];

const previewCache = new Map<string, HTMLCanvasElement>();

/** A squiggle drawn with the real brush engine, light at the ends and full pressure in the middle. */
/** Preview strokes are drawn in the text colour so they read on either mode. */
const previewInk = () => (document.documentElement.dataset.mode === 'light' ? '#2a292a' : '#f2f2f6');

export function brushPreview(params: BrushParams, w = 220, hh = 52, color = previewInk()): HTMLCanvasElement {
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

/** Brush, eraser and smudge share one library: the brushes you starred, the built-in categories, then your own. */
export function brushLibrary(app: App, tool: BrushTool, onPick: () => void): HTMLElement {
  const ed = app.ed, st = ed.settings, current = currentPreset(ed, tool), p = ed.prefs, favs = p.favoriteBrushes;
  const cats = (): (BrushCategory & { user?: boolean })[] => [
    { name: 'Favourites', brushes: favs.map((id) => ed.preset(id)).filter((b) => favs.includes(b.id)) },
    ...BRUSH_LIBRARY.map((c) => ({ name: c.name, brushes: [...c.brushes, ...p.customBrushes.filter((b) => b.cat === c.name)] })),
    ...p.brushCategories.map((name) => ({ name, brushes: p.customBrushes.filter((b) => b.cat === name), user: true })),
  ];
  let tab = Math.max(0, cats().findIndex((c) => c.brushes.some((b) => b.id === current)));
  const tabs = h('div.brush-tabs', { role: 'tablist' });
  const list = h('div.brush-list', { role: 'listbox', 'aria-label': 'Brushes' });
  const head = h('span.head-actions');
  const menu = h('div.panel.brush-menu', { hidden: true });
  const pick = (pr: BrushPreset) => {
    const params = { ...pr.params };
    void ensureAssets(brushAssets(params));
    if (tool !== 'smudge') applyPressure(ed.prefs, params);
    if (tool === 'eraser') { st.eraserPreset = pr.id; st.eraser = params; }
    else if (tool === 'smudge') { st.smudgePreset = pr.id; st.smudge = smudgeParams(params); }
    else { st.brushPreset = pr.id; st.brush = params; }
    ed.setTool(tool);
    ed.emit('brush');
    onPick();
  };
  const star = (id: string) => {
    const i = favs.indexOf(id);
    if (i < 0) favs.push(id); else favs.splice(i, 1);
    ed.emit('prefs');
    render();
  };
  const custom = (b: BrushPreset) => p.customBrushes.find((c) => c.id === b.id);
  const edit = (b: CustomBrush) => brushEditor(app, b, () => { tab = Math.max(0, cats().findIndex((c) => c.name === b.cat)); render(); });
  const clone = (b: BrushPreset) => {
    const c = cats()[tab];
    edit({ id: uid('c'), name: b.name + ' copy', cat: c.user || BUILTIN_CATEGORIES.includes(c.name) ? c.name : 'General', params: { ...b.params }, ...(custom(b)?.imported ? { imported: true as const } : {}) });
  };
  const more = (b: BrushPreset, at: HTMLElement) => {
    const mine = custom(b);
    const item = (ic: string, text: string, fn: () => void) => h('button.menu-item', { type: 'button', html: icon(ic, 16) + `<span>${text}</span>`, onclick: () => { menu.hidden = true; fn(); } });
    menu.replaceChildren(
      item('copy', 'Clone', () => clone(b)),
      mine ? item('rename', 'Edit', () => edit(mine)) : '',
      item('link', 'Copy code', async () => { if (await shareable(app, mine)) app.copyText(brushCode(b.name, b.params), 'Brush code copied'); }),
      mine ? item('trash', 'Delete', async () => { if (await confirmDialog('Delete brush', `Delete “${b.name}”?`, 'Delete')) { removeBrush(app, mine); ed.emit('prefs'); render(); } }) : '',
    );
    menu.style.top = `${at.offsetTop + at.offsetHeight}px`;
    menu.hidden = false;
  };
  const file: HTMLInputElement = h('input.import-file', { type: 'file', accept: '.abr,.brush,.brushset', hidden: true, 'aria-label': 'Brush file', onchange: async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    app.toast('Reading brushes…');
    const got = await importBrushFile(f).catch(() => null);
    if (!got?.length) { app.toast(got ? 'No brushes in that file' : 'That brush file can’t be read'); return; }
    // A set of brushes gets its own category, named after the file, when there's room.
    const stem = cleanName(f.name.replace(/\.[^.]+$/, ''), 20);
    let catName = 'General';
    if (got.length > 1 && stem && !BUILTIN_CATEGORIES.includes(stem)) {
      if (!p.brushCategories.includes(stem) && p.brushCategories.length < MAX_CATEGORIES) p.brushCategories.push(stem);
      if (p.brushCategories.includes(stem)) catName = stem;
    }
    const room = Math.max(0, MAX_CUSTOM_BRUSHES - p.customBrushes.length), added = got.slice(0, room);
    for (const b of added) p.customBrushes.push({ id: uid('c'), name: b.name, cat: catName, params: b.params, imported: true });
    ed.emit('prefs');
    app.toast(added.length < got.length ? `Added ${added.length} of ${got.length} brushes; the library holds ${MAX_CUSTOM_BRUSHES}` : `Added ${added.length} brush${added.length === 1 ? '' : 'es'}`);
    tab = Math.max(0, cats().findIndex((c) => c.name === catName));
    render();
  } });
  const render = () => {
    const all = cats();
    tab = Math.min(tab, all.length - 1);
    clear(tabs);
    all.forEach((c, i) => tabs.append(h(`button.brush-tab${i === tab ? '.active' : ''}` as 'button', {
      role: 'tab', 'aria-selected': String(i === tab), html: i === 0 ? icon('star', 14) : c.name, 'aria-label': c.name, title: c.name, onclick: () => { tab = i; render(); },
    })));
    const cat = all[tab];
    head.replaceChildren(
      act('plus', 'New brush from the current settings', () => clone({ id: '', name: ed.preset(current).name, params: tool === 'eraser' ? st.eraser : tool === 'smudge' ? st.smudge : st.brush })),
      act('link', 'Add a brush from a code', async () => {
        const got = parseBrushCode((await textDialog('Brush code', '', 'Add')) ?? '');
        if (!got) { app.toast('That isn’t a brush code'); return; }
        if (!(await ensureAssets(brushAssets(got.params)))) app.toast('This brush’s images aren’t available here; it draws with a round tip');
        edit({ id: uid('c'), name: got.name, cat: cat.user ? cat.name : 'General', params: got.params });
      }),
      act('download', 'Import brushes (.abr, .brush, .brushset)', () => file.click()),
      act('folderPlus', 'New category', async () => { const name = await newCategory(app); if (name) { tab = all.length; render(); } }),
      cat.user ? act('trash', 'Delete category', async () => {
        if (!(await confirmDialog('Delete category', `Delete “${cat.name}”? Its brushes move to General.`, 'Delete'))) return;
        for (const b of p.customBrushes) if (b.cat === cat.name) b.cat = 'General';
        p.brushCategories.splice(p.brushCategories.indexOf(cat.name), 1);
        ed.emit('prefs');
        tab = 1;
        render();
      }) : '',
    );
    clear(list);
    if (!cat.brushes.length) list.append(h('p.muted.small', {}, tab === 0 ? 'Star a brush to keep it here.' : 'No brushes yet. Clone one from its ⋯ menu.'));
    for (const pr of cat.brushes) {
      const on = favs.includes(pr.id);
      const dots: HTMLButtonElement = h('button.icon-btn.brush-more', { type: 'button', title: 'More', 'aria-label': `More for ${pr.name}`, html: icon('more', 16), onclick: () => more(pr, dots.parentElement!) });
      list.append(h(`div.brush-row${pr.id === current ? '.active' : ''}` as 'div', { role: 'option', 'aria-selected': String(pr.id === current) },
        h('button.brush-pick', { type: 'button', title: pr.name, onclick: () => pick(pr) }, h('span.brush-name', {}, pr.name), brushPreview(pr.params)),
        h(`button.icon-btn.brush-star${on ? '.on' : ''}` as 'button', { type: 'button', title: on ? 'Unstar' : 'Star', 'aria-label': `${on ? 'Unstar' : 'Star'} ${pr.name}`, 'aria-pressed': String(on), html: icon('star', 16), onclick: () => star(pr.id) }),
        dots));
    }
  };
  render();
  const title = tool === 'eraser' ? 'Eraser' : tool === 'smudge' ? 'Smudge' : 'Brush';
  const el = h('div.panel.brush-library', {}, h('div.panel-head', {}, h('span.panel-title', {}, title + ' Library'), head), tabs, list, menu, file);
  dismissOnOutside(menu, [], () => { menu.hidden = true; });
  return el;
}

const act = (ic: string, title: string, fn: () => void) => h('button.icon-btn.small', { type: 'button', title, 'aria-label': title, html: icon(ic, 16), onclick: fn });

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
