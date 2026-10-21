import { BRUSH_FIELDS, brushCode } from '../shared/brush';
import { BUILTIN_CATEGORIES, CustomBrush, MAX_CATEGORIES, MAX_CUSTOM_BRUSHES, cleanName } from '../shared/prefs';
import type { App } from './app';
import { confirmDialog, modal, textDialog } from './dialogs';
import { h } from './dom';
import { Slider } from './slider';
import { brushPreview } from './toolPicker';

/** Edit a brush of your own. `brush` is changed in place; a brush not yet in the prefs is added on save. */
export function brushEditor(app: App, brush: CustomBrush, onDone: () => void) {
  const ed = app.ed, p = ed.prefs, params = brush.params, isNew = !p.customBrushes.includes(brush);
  const preview = h('div.brush-edit-preview');
  const code = h('input.cp-hex.brush-code', { type: 'text', readonly: 'true', 'aria-label': 'Brush code' });
  let raf = 0;
  const refresh = () => {
    code.value = brushCode(name.value.trim() || brush.name, params);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => preview.replaceChildren(brushPreview(params, 320, 80, '#f2f2f6')));
  };
  const name = h('input', { type: 'text', value: brush.name, maxlength: 30, 'aria-label': 'Brush name', oninput: refresh });
  const cat = h('select', { 'aria-label': 'Category' });
  const fillCats = () => {
    cat.replaceChildren(...[...BUILTIN_CATEGORIES, ...p.brushCategories].map((c) => h('option', { value: c }, c)), h('option', { value: '+' }, 'New category…'));
    cat.value = brush.cat;
  };
  fillCats();
  cat.addEventListener('change', async () => {
    if (cat.value !== '+') { brush.cat = cat.value; return; }
    const made = await newCategory(app);
    if (made) brush.cat = made;
    fillCats();
  });
  const shape = h('div.segmented');
  const renderShape = () => shape.replaceChildren(...(['round', 'square'] as const).map((s) =>
    h(`button${(params.shape ?? 'round') === s ? '.active' : ''}` as 'button', { type: 'button', onclick: () => { params.shape = s === 'square' ? 'square' : undefined; renderShape(); refresh(); } }, s === 'round' ? 'Round' : 'Square')));
  renderShape();
  const sliders = BRUSH_FIELDS.map((f) => new Slider({
    min: f.min, max: f.max, value: (params[f.key] as number | undefined) ?? (f.key === 'grainScale' ? 1 : 0), label: f.label,
    curve: f.key === 'size' ? 2.4 : f.key === 'grainScale' ? 1.6 : 1,
    format: (v) => f.pct ? Math.round(v * 100) + '%' : f.key === 'size' ? (v < 10 ? v.toFixed(1) : Math.round(v)) + ' px' : '×' + v.toFixed(2),
    onInput: (v) => { (params as unknown as Record<string, number>)[f.key] = Math.round(v * 1000) / 1000; refresh(); },
  }).el);
  const copy = h('button.btn.small', { type: 'button', onclick: () => app.copyText(code.value, 'Brush code copied') }, 'Copy');
  const body = h('div.modal-body.brush-edit', {},
    preview,
    h('div.row', {}, name, cat),
    h('div.pref-row', {}, h('span', {}, 'Tip'), shape),
    ...sliders,
    h('div.row', {}, code, copy),
    h('small.muted', {}, 'Friends paste the code into their library to get this brush.'),
  );
  const done = () => { ed.emit('prefs'); close(); onDone(); };
  const save = h('button.btn.primary', { type: 'button', onclick: () => {
    const n = cleanName(name.value, 30);
    if (!n) { name.focus(); return; }
    if (isNew) {
      if (p.customBrushes.length >= MAX_CUSTOM_BRUSHES) { app.toast(`You can keep up to ${MAX_CUSTOM_BRUSHES} brushes`); return; }
      p.customBrushes.push(brush);
    }
    brush.name = n;
    done();
  } }, 'Save');
  const del = isNew ? null : h('button.btn.danger', { type: 'button', onclick: async () => {
    if (!(await confirmDialog('Delete brush', `Delete “${brush.name}”?`, 'Delete'))) return;
    removeBrush(app, brush);
    done();
  } }, 'Delete');
  const close = modal(isNew ? 'New brush' : 'Edit brush', body, [del, h('button.btn', { type: 'button', onclick: () => close() }, 'Cancel'), save].filter((x): x is HTMLButtonElement => !!x));
  refresh();
}

export function removeBrush(app: App, brush: CustomBrush) {
  const p = app.ed.prefs;
  p.customBrushes.splice(p.customBrushes.indexOf(brush), 1);
  p.favoriteBrushes = p.favoriteBrushes.filter((id) => id !== brush.id);
}

/** Asks for a name and adds the category; null when cancelled, taken or full. */
export async function newCategory(app: App): Promise<string | null> {
  const p = app.ed.prefs;
  if (p.brushCategories.length >= MAX_CATEGORIES) { app.toast(`You can keep up to ${MAX_CATEGORIES} categories`); return null; }
  const name = cleanName(await textDialog('New category', '', 'Add'), 20);
  if (!name) return null;
  if (BUILTIN_CATEGORIES.includes(name) || p.brushCategories.includes(name)) { app.toast('That category already exists'); return null; }
  p.brushCategories.push(name);
  app.ed.emit('prefs');
  return name;
}
