import { BRUSH_FIELDS, BRUSH_GROUPS, brushCode } from '../shared/brush';
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
  const slider = (f: typeof BRUSH_FIELDS[number]) => new Slider({
    min: f.min, max: f.max, value: (params[f.key] as number | undefined) ?? (f.key === 'grainScale' ? 1 : 0), label: f.label,
    curve: f.key === 'size' ? 2.4 : f.key === 'grainScale' ? 1.6 : 1,
    format: (v) => f.pct ? Math.round(v * 100) + '%' : f.key === 'size' ? (v < 10 ? v.toFixed(1) : Math.round(v)) + ' px' : f.key === 'angle' ? Math.round(v) + '°' : '×' + v.toFixed(2),
    onInput: (v) => { (params as unknown as Record<string, number>)[f.key] = Math.round(v * 1000) / 1000; refresh(); },
  }).el;
  const follow = h('input', { type: 'checkbox', role: 'switch' });
  follow.checked = !!params.follow;
  follow.addEventListener('change', () => { params.follow = follow.checked || undefined; refresh(); });
  const NOTES: Partial<Record<typeof BRUSH_GROUPS[number], string>> = {
    Scatter: 'Dabs land off the path, at random sizes, strengths and angles.',
    Colour: 'Each dab shifts the colour a little.',
    'Wet mix': 'The brush picks up paint already on the layer and carries it along.',
    Tilt: 'Leaning the pen stretches the dab along the lean and thins the paint.',
  };
  // Stroke and pressure stay open; the rest fold away so the dialog stays short.
  const groups = BRUSH_GROUPS.map((g) => {
    const fields = BRUSH_FIELDS.filter((f) => f.group === g), on = fields.some((f) => params[f.key]);
    const sec = h('details.brush-group', { open: g === 'Stroke' || g === 'Pressure' || on || undefined }, h('summary', {}, g),
      NOTES[g] ? h('small.muted', {}, NOTES[g]) : null, ...fields.map(slider),
      g === 'Scatter' ? h('label.switch-row', {}, h('span', {}, 'Angle follows the stroke'), follow) : null);
    return sec;
  });
  const copy = h('button.btn.small', { type: 'button', onclick: () => app.copyText(code.value, 'Brush code copied') }, 'Copy');
  const body = h('div.modal-body.brush-edit', {},
    preview,
    h('div.row', {}, name, cat),
    h('div.pref-row', {}, h('span', {}, 'Tip'), shape),
    ...groups,
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
