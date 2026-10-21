import { DrawDoc } from '../core/document';
import type { Editor } from '../editor';
import { ExportFormat, exportDoc, exportRect } from '../io/export';
import { h } from './dom';
import { icon } from './icons';

export function modal(title: string, body: HTMLElement, actions: HTMLElement[], onClose?: () => void, closable = true) {
  const close = () => { overlay.remove(); onClose?.(); };
  const overlay = h('div.modal-overlay', {},
    h('div.modal', { role: 'dialog', 'aria-label': title },
      h('div.modal-head', {}, h('h2', {}, title), closable ? h('button.icon-btn', { title: 'Close', html: icon('x', 18), onclick: close }) : null),
      body,
      h('div.modal-actions', {}, ...actions),
    ),
  );
  if (closable) overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  return close;
}

const PRESETS = [
  { id: 'square', name: 'Square', w: 2048, h: 2048 },
  { id: 'hd', name: 'HD 1080p', w: 1920, h: 1080 },
  { id: '4k', name: '4K', w: 3840, h: 2160 },
  { id: 'a4', name: 'A4 · 300 dpi', w: 2480, h: 3508 },
  { id: 'letter', name: 'Letter · 300 dpi', w: 2550, h: 3300 },
  { id: 'comic', name: 'Comic page', w: 1988, h: 3056 },
];

export interface CanvasChoice { width: number; height: number; infinite: boolean; background: string | null; roomName: string }

/**
 * Pick a canvas size. In 'room' mode it also asks for a room name and hands back the settings
 * (the server creates the room); otherwise it creates a local document.
 */
export function newCanvasDialog(onCreate: (doc: DrawDoc) => void, closable = true, room?: { onCreate: (c: CanvasChoice) => Promise<void>; solo?: boolean }) {
  const preset = h('select', { id: 'canvas-preset', 'aria-label': 'Size' },
    h('option', { value: 'unlimited' }, 'Unlimited'),
    ...PRESETS.map((p) => h('option', { value: p.id }, p.name)),
    h('option', { value: 'custom' }, 'Custom'));
  const wIn = h('input', { type: 'number', id: 'canvas-w', min: 16, max: 16384, value: 2048, 'aria-label': 'Width' });
  const hIn = h('input', { type: 'number', id: 'canvas-h', min: 16, max: 16384, value: 2048, 'aria-label': 'Height' });
  const bg = h('select', { id: 'canvas-bg', 'aria-label': 'Background' },
    h('option', { value: '#ffffff' }, 'White'), h('option', { value: '#f4efe6' }, 'Warm paper'),
    h('option', { value: '#1e1e22' }, 'Dark'), h('option', { value: '' }, 'Transparent'));
  const shape = h('div.canvas-shape');
  const sizeNote = h('small.muted');

  const size = () => [Math.max(16, Math.min(16384, Math.round(+wIn.value || 2048))), Math.max(16, Math.min(16384, Math.round(+hIn.value || 2048)))];
  const update = () => {
    const infinite = preset.value === 'unlimited';
    wIn.disabled = hIn.disabled = infinite;
    const [w, hh] = size();
    // Fit the canvas shape inside a 200 × 150 box.
    const k = Math.min(200 / w, 150 / hh);
    shape.style.width = infinite ? '200px' : `${Math.max(8, w * k)}px`;
    shape.style.height = infinite ? '150px' : `${Math.max(8, hh * k)}px`;
    shape.style.background = bg.value || '';
    shape.classList.toggle('transparent', !bg.value);
    shape.classList.toggle('infinite', infinite);
    sizeNote.textContent = infinite ? 'Endless canvas' : `${w} × ${hh} px`;
  };
  preset.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === preset.value);
    if (p) { wIn.value = String(p.w); hIn.value = String(p.h); }
    update();
  });
  for (const inp of [wIn, hIn]) inp.addEventListener('input', () => { preset.value = 'custom'; update(); });
  bg.addEventListener('change', update);

  const err = h('p.error', { role: 'alert' });
  const solo = !!room?.solo;
  const roomName = h('input', { type: 'text', id: 'room-name', maxlength: 48, placeholder: solo ? 'Untitled sketch' : 'Sketch night', 'aria-label': 'Name' });
  const body = h('div.modal-body.new-canvas', {},
    h('div.new-canvas-fields', {},
      room ? h('label.field', {}, h('span.field-label', {}, 'Name'), roomName) : null,
      h('label.field', {}, h('span.field-label', {}, 'Size'), preset),
      h('div.row.size-row', {}, wIn, h('span.muted', {}, '×'), hIn, h('span.muted', {}, 'px')),
      h('label.field', {}, h('span.field-label', {}, 'Background'), bg),
    ),
    h('div.canvas-preview', {}, shape, sizeNote),
    err,
  );
  update();

  const create = h('button.btn.primary', {}, room && !solo ? 'Create room' : 'Create canvas');
  const close = modal(room && !solo ? 'New shared room' : 'New canvas', body, [create], undefined, closable);
  create.addEventListener('click', async () => {
    const infinite = preset.value === 'unlimited';
    const [w, hh] = size();
    if (!infinite && w * hh > 100_000_000) { err.textContent = 'That canvas is too large. Keep it under 100 megapixels.'; return; }
    if (room) {
      create.disabled = true;
      try {
        await room.onCreate({ width: w, height: hh, infinite, background: bg.value || null, roomName: roomName.value });
        close();
      } catch (e) { err.textContent = (e as Error).message; create.disabled = false; }
      return;
    }
    close();
    onCreate(DrawDoc.create({ width: w, height: hh, infinite, background: bg.value || null }));
  });
}

export function exportDialog(ed: Editor) {
  ed.commitPending();
  const r = exportRect(ed.doc);
  let format: ExportFormat = 'png';
  const name = h('input', { type: 'text', value: 'doodlehive-' + new Date().toISOString().slice(0, 10), 'aria-label': 'File name' });
  const transparent = h('input', { type: 'checkbox' });
  const quality = h('input', { type: 'range', min: 50, max: 100, value: 92, 'aria-label': 'JPG quality' });
  const qualityRow = h('label.row', {}, 'JPG quality', quality);
  const transRow = h('label.row.check', {}, transparent, 'Transparent background');
  const seg = h('div.segmented');
  const setFormat = (f: ExportFormat) => {
    format = f;
    for (const b of seg.children) b.classList.toggle('active', (b as HTMLElement).dataset.f === f);
    qualityRow.hidden = f !== 'jpg';
    transRow.hidden = f === 'jpg';
  };
  for (const [f, label] of [['png', 'PNG'], ['jpg', 'JPG'], ['psd', 'PSD (layers)']] as const) {
    seg.append(h('button', { 'data-f': f, onclick: () => setFormat(f) }, label));
  }
  transparent.checked = !ed.doc.settings.background;
  const size = r ? `${r.w} × ${r.h} px${ed.doc.settings.infinite ? ' (cropped to your artwork)' : ''}` : 'The canvas is empty.';
  const err = h('p.error', { role: 'alert' });
  const body = h('div.modal-body', {}, seg, h('p.muted', {}, size), h('label.row', {}, 'File name', name), qualityRow, transRow, err);
  setFormat('png');
  const go = h('button.btn.primary', { html: icon('download', 18) + '<span>Export</span>' });
  if (!r) go.setAttribute('disabled', '');
  const close = modal('Export', body, [go]);
  go.addEventListener('click', async () => {
    go.setAttribute('disabled', '');
    try {
      await exportDoc(ed.doc, { format, quality: +quality.value / 100, transparent: transparent.checked, name: name.value.trim() || 'drawing',
        folderName: (f) => (f.user && f.owner && ed.room?.member(f.owner)?.displayName) || f.name });
      close();
    } catch (ex) {
      const e = ex as { message?: string; code?: string };
      err.textContent = e.code === 'declined' ? 'Export cancelled.' : e.message || 'Export failed. Please try again.';
      go.removeAttribute('disabled');
    }
  });
}

/** In-app replacement for confirm(), which embedded hosts may block. */
export function confirmDialog(title: string, message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button.btn.primary', {}, okLabel);
    const cancel = h('button.btn', {}, 'Cancel');
    const close = modal(title, h('div.modal-body', {}, h('p', {}, message)), [cancel, ok], () => resolve(result));
    ok.addEventListener('click', () => { result = true; close(); });
    cancel.addEventListener('click', () => close());
  });
}

/** In-app replacement for prompt(). Resolves null when cancelled. */
export function textDialog(title: string, value: string, okLabel = 'Save'): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', { type: 'text', id: 'text-dialog-input', value, maxlength: 60, 'aria-label': title });
    const ok = h('button.btn.primary', {}, okLabel);
    const form = h('form.modal-body', {}, input);
    const close = modal(title, form, [ok], () => resolve(result));
    const submit = (e?: Event) => { e?.preventDefault(); result = input.value; close(); };
    form.addEventListener('submit', submit);
    ok.addEventListener('click', () => submit());
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
