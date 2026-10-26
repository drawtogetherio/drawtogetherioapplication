import { BRUSH_FIELDS, BRUSH_GROUPS, brushCode } from '../shared/brush';
import { brushAssets, isAssetId } from '../shared/brushAssets';
import { assetImage, importAssetImage, uploadAssets } from '../engine/brushAssets';
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
  // One hidden file input serves every image picker; `onFile` says which setting the picture is for.
  const file = h('input.asset-file', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Brush image file' });
  let onFile: ((id: string) => void) | null = null;
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    const id = await importAssetImage(f);
    if (!id) { app.toast('That image can’t be used: try a PNG or JPG'); return; }
    onFile?.(id);
    refresh();
  });
  const pick = (fn: (id: string) => void) => { onFile = fn; file.click(); };
  const thumb = (id: string | undefined) => {
    const img = id ? assetImage(id) : null;
    if (!img) return null;
    const c = h('canvas.asset-thumb', { width: 28, height: 28, title: 'Current image' }), g = c.getContext('2d')!;
    g.fillStyle = '#000'; g.fillRect(0, 0, 28, 28);
    const f = 28 / Math.max(img.width, img.height);
    g.drawImage(img, (28 - img.width * f) / 2, (28 - img.height * f) / 2, img.width * f, img.height * f);
    return c;
  };
  const shape = h('div.segmented');
  const tipThumb = h('span.asset-slot');
  const renderShape = () => {
    const cur = isAssetId(params.shape) ? 'image' : params.shape ?? 'round';
    shape.replaceChildren(...(['round', 'square', 'image'] as const).map((s) =>
      h(`button${cur === s ? '.active' : ''}` as 'button', { type: 'button', onclick: () => {
        if (s === 'image') { pick((id) => { params.shape = id; renderShape(); }); return; }
        params.shape = s === 'square' ? 'square' : undefined; renderShape(); refresh();
      } }, s === 'round' ? 'Round' : s === 'square' ? 'Square' : 'Image…')));
    tipThumb.replaceChildren(thumb(isAssetId(params.shape) ? params.shape : undefined) ?? '');
  };
  renderShape();
  /** A row to choose or drop an image for `key` (dual tip or texture). */
  const imageRow = (key: 'dual' | 'texture', label: string) => {
    const row = h('div.row.asset-row');
    const render = () => row.replaceChildren(thumb(params[key]) ?? '',
      h('button.btn.small', { type: 'button', onclick: () => pick((id) => { params[key] = id; render(); }) }, params[key] ? 'Change image…' : label),
      params[key] ? h('button.btn.small', { type: 'button', onclick: () => { delete params[key]; render(); refresh(); } }, 'Remove') : '');
    render();
    return row;
  };
  const slider = (f: typeof BRUSH_FIELDS[number]) => new Slider({
    min: f.min, max: f.max, value: (params[f.key] as number | undefined) ?? (f.key === 'grainScale' ? 1 : 0), label: f.label,
    curve: f.key === 'size' ? 2.4 : f.key === 'grainScale' ? 1.6 : 1,
    format: (v) => f.pct ? Math.round(v * 100) + '%' : f.key === 'size' ? (v < 10 ? v.toFixed(1) : Math.round(v)) + ' px' : f.key === 'angle' ? Math.round(v) + '°' : '×' + v.toFixed(2),
    onInput: (v) => { (params as unknown as Record<string, number>)[f.key] = Math.round(v * 1000) / 1000; refresh(); },
  }).el;
  const flag = (key: 'follow' | 'grainMove', label: string) => {
    const box = h('input', { type: 'checkbox', role: 'switch' });
    box.checked = !!params[key];
    box.addEventListener('change', () => { params[key] = box.checked || undefined; refresh(); });
    return h('label.switch-row', {}, h('span', {}, label), box);
  };
  const NOTES: Partial<Record<typeof BRUSH_GROUPS[number], string>> = {
    Texture: 'Grain breaks the dab up with the built-in paper, or with an image of your own.',
    'Dual tip': 'A second image cut into every dab.',
    Scatter: 'Dabs land off the path, at random sizes, strengths and angles.',
    Colour: 'Each dab shifts the colour a little.',
    'Wet mix': 'The brush picks up paint already on the layer and carries it along.',
    Tilt: 'Leaning the pen stretches the dab along the lean and thins the paint.',
  };
  // Stroke and pressure stay open; the rest fold away so the dialog stays short.
  const groups = BRUSH_GROUPS.map((g) => {
    const fields = BRUSH_FIELDS.filter((f) => f.group === g), on = fields.some((f) => params[f.key]) || (g === 'Dual tip' && params.dual) || (g === 'Texture' && params.texture);
    const sec = h('details.brush-group', { open: g === 'Stroke' || g === 'Pressure' || on || undefined }, h('summary', {}, g),
      NOTES[g] ? h('small.muted', {}, NOTES[g]) : null,
      g === 'Dual tip' ? imageRow('dual', 'Choose image…') : null,
      ...fields.map(slider),
      g === 'Texture' ? imageRow('texture', 'Texture image…') : null,
      g === 'Texture' ? flag('grainMove', 'Texture moves with the dab') : null,
      g === 'Scatter' ? flag('follow', 'Angle follows the stroke') : null);
    return sec;
  });
  const copy = h('button.btn.small', { type: 'button', onclick: () => app.copyText(code.value, 'Brush code copied') }, 'Copy');
  const codeRow = h('div.row', {}, code, copy), codeHint = h('small.muted', {}, 'Friends paste the code into their library to get this brush.');
  const share = h('button.btn.small', { type: 'button', onclick: async () => { if (await shareable(app, brush)) showCode(); } }, 'Get a share code…');
  const shareRow = h('div.row', {}, share, h('small.muted', {}, 'Imported from another app.'));
  const showCode = () => { const ok = !brush.imported; codeRow.hidden = codeHint.hidden = !ok; shareRow.hidden = ok; };
  showCode();
  const body = h('div.modal-body.brush-edit', {},
    preview,
    h('div.row', {}, name, cat),
    h('div.pref-row', {}, h('span', {}, 'Tip'), h('span.row', {}, tipThumb, shape)),
    ...groups,
    file,
    codeRow, codeHint, shareRow,
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
    if (!brush.imported) void uploadAssets(brushAssets(params)); // so a friend with the code can fetch them; imported images only go up when drawn in a room
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

/** Whether this brush's code may be handed out; an imported brush asks its owner to confirm the rights first, once. */
export async function shareable(app: App, brush: CustomBrush | undefined): Promise<boolean> {
  if (!brush?.imported) return true;
  if (!(await confirmDialog('Share this brush?', 'It was imported from another app. Only share it if you made it or its licence lets you pass it on.', 'I have the rights'))) return false;
  delete brush.imported;
  app.ed.emit('prefs');
  return true;
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
