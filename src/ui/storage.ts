import { DrawDoc } from '../core/document';
import type { DocSettings, Op } from '../core/model';
import { ApiError, api } from '../net/api';
import { CloudCanvas, STORAGE_FULL, STORAGE_WARN_AT, StorageInfo, formatBytes, storageFits, storageShare } from '../shared/storage';
import { hiveCanvasBlob, safeFileName } from '../io/hivecanvas';
import { saveFile } from '../io/platform';
import { moveLapse, roomLapseKey } from '../io/lapse';
import { isNativeApp } from '../io/native';
import type { App } from './app';
import { confirmDialog, modal } from './dialogs';
import { clear, h } from './dom';
import { icon } from './icons';
import { LocalCopy } from './localCopy';

// Cloud storage: free accounts keep canvases on the server up to a cap (Admin → Site, 50 MB to start);
// premium has none. Canvases move off it to this device or to a .hivecanvas file to make room.

export type Offload = 'device' | 'file';
export type StorageLevel = 'near' | 'full' | null;

let last: StorageInfo | null = null;
const listeners = new Set<(s: StorageInfo) => void>();

/** The last reading, if any. */
export const storageNow = () => last;

/** Asks the server how much is used; everyone listening (home banner, save badge) hears the answer. */
export async function loadStorage(): Promise<StorageInfo | null> {
  try { last = await api.storage(); } catch { return last; }
  for (const f of listeners) f(last);
  return last;
}
export function onStorage(f: (s: StorageInfo) => void) { listeners.add(f); return () => listeners.delete(f); }

export const isStorageFull = (e: unknown) => e instanceof ApiError && e.status === 413 && e.field === STORAGE_FULL;

/** An admin can set the free allowance to 0: free accounts then keep canvases on their devices, as before. */
export const cloudOff = (s: StorageInfo | null) => s?.cap === 0;
/** Whether a new canvas would go to the cloud (unknown counts as yes: the server has the last word). */
export const cloudHasRoom = (s: StorageInfo | null) => !s || s.cap == null || (s.cap > 0 && storageShare(s) < 1);

/** Free accounts only: nearly full from 80 %, then full. */
export function storageLevel(s: StorageInfo | null): StorageLevel {
  if (!s || s.cap == null || cloudOff(s)) return null;
  const f = storageShare(s);
  return f >= 1 ? 'full' : f >= STORAGE_WARN_AT ? 'near' : null;
}

export function storageWarningText(s: StorageInfo): string {
  const lvl = storageLevel(s), of = `${formatBytes(s.used)} of ${formatBytes(s.cap ?? 0)}`;
  return lvl === 'full'
    ? `Your cloud storage is full (${of}). New canvases stay on this device until you make room.`
    : `Your cloud storage is nearly full: ${of} used.`;
}

/** A bar and a line of text: how much of the allowance is used. */
export function usageMeter(s: StorageInfo): HTMLElement {
  const f = Math.min(1, storageShare(s)), lvl = storageLevel(s);
  const bar = h('span.storage-fill');
  bar.style.width = `${s.cap == null ? 0 : Math.max(f > 0 ? 2 : 0, f * 100)}%`;
  return h(`div.storage-meter${lvl ? '.' + lvl : ''}` as 'div', {},
    s.cap == null ? null : h('span.storage-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(f * 100)), 'aria-label': 'Cloud storage used' }, bar),
    h('span.storage-text', {}, s.cap == null
      ? `${formatBytes(s.used)} in the cloud · no cap with premium`
      : `${formatBytes(s.used)} of ${formatBytes(s.cap)} used`),
  );
}

/** Replays a canvas's ops, yielding now and then so the page stays responsive. */
async function replay(settings: DocSettings, ops: Op[], doc = new DrawDoc({ ...settings })) {
  let t = performance.now();
  for (const op of ops) {
    doc.apply(op, { ...await doc.prepared(op), record: false });
    if (performance.now() - t > 30) { await new Promise((r) => setTimeout(r)); t = performance.now(); }
  }
  return doc;
}

/**
 * Brings a cloud canvas off the server. To the device it is kept here (IndexedDB in a browser, files in
 * the apps) and leaves the cloud at once. As a file it downloads; the caller removes it from the cloud
 * once the person says the file saved (`removeFromCloud`), since a browser can't tell us.
 */
export async function offload(app: App, c: CloudCanvas, to: Offload): Promise<void> {
  const me = app.ed.me!;
  const { name, settings, share, ops } = await api.roomContents(c.id);
  const plain = { width: settings.width, height: settings.height, infinite: settings.infinite, background: settings.background };
  if (to === 'device') {
    const copy = await LocalCopy.create(me.id, name, plain, { ...share, visibility: 'private' });
    const doc = await copy.toDoc(ops);
    await copy.replaceWith(doc.compactLog());
    copy.thumb(doc);
    await copy.close();
    await moveLapse(roomLapseKey(c.id), copy.meta.id).catch(() => {});
    await removeFromCloud(c.id);
    return;
  }
  const doc = await replay(settings, ops);
  await saveFile(await hiveCanvasBlob(doc, name), `${safeFileName(name)}.hivecanvas`);
}

export async function removeFromCloud(id: string) {
  await api.deleteRoom(id);
}

const OFFLOAD_LABEL: Record<Offload, string> = { device: 'Move to this device', file: 'Save as file' };
const deviceNote = () => isNativeApp ? 'Kept in the app on this device.' : 'In a browser, a device copy lives in its cache, which it may clear. A file is safer.';

function canvasRow(c: CloudCanvas, open: boolean, ...end: (HTMLElement | null)[]) {
  const thumb = h('span.storage-thumb', {}, c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy' }) : h('span', { html: icon('brush', 16) }));
  const tags = [formatBytes(c.bytes), c.visibility !== 'private' ? 'Shared' : '', open ? 'Open now' : ''].filter(Boolean).join(' · ');
  return h('div.storage-row', { 'data-id': c.id }, thumb, h('span.storage-name', {}, h('strong', {}, c.name), h('small.muted', {}, tags)), ...end);
}

/** People in a shared canvas lose it when it leaves the cloud. */
async function okToMove(c: CloudCanvas) {
  return c.visibility === 'private' || confirmDialog('Move a shared canvas?', `“${c.name}” is shared. Once it leaves the cloud, people you shared it with can’t open it.`, 'Move');
}

/** Preferences → Storage: how full the cloud is and the biggest canvases there, each with a way off it. */
export function storagePage(app: App): HTMLElement[] {
  const head = h('div.pref-stack', {}, h('span.muted', {}, 'Loading…'));
  const list = h('div.storage-list');
  const render = async () => {
    const s = await loadStorage();
    if (!s) { head.replaceChildren(h('span.muted', {}, 'Connect to see your cloud storage.')); clear(list); return; }
    const patreon = app.session.server?.patreon;
    head.replaceChildren(...[usageMeter(s),
      h('small.muted', {}, s.cap == null
        ? 'Canvases in the cloud open on every device you log in from.'
        : cloudOff(s) ? 'Free accounts keep canvases on this device. Ones already in the cloud are listed here.'
        : `Free accounts get ${formatBytes(s.cap)} of cloud storage. Canvases there open on every device you log in from. Move big ones to this device or save them as files to make room.`),
      s.cap != null && patreon ? h('a.about-link', { href: patreon, target: '_blank', rel: 'noopener noreferrer' }, 'Premium has no cap') : null].filter((x) => !!x));
    clear(list);
    if (!s.canvases.length) { list.append(h('p.muted', {}, 'Nothing in the cloud yet.')); return; }
    list.append(h('h3.sub', {}, 'Biggest canvases'));
    for (const c of s.canvases) {
      const open = app.ed.room?.id === c.id;
      const status = h('small.storage-status.muted');
      const btn = (to: Offload) => h('button.icon-btn', {
        type: 'button', title: open ? 'Close this canvas first' : OFFLOAD_LABEL[to], 'aria-label': `${OFFLOAD_LABEL[to]}: ${c.name}`, disabled: open,
        html: icon(to === 'device' ? 'device' : 'download', 18), onclick: () => go(to),
      });
      const actions = h('span.storage-actions', {}, btn('device'), btn('file'));
      const row = canvasRow(c, open, status, actions);
      const go = async (to: Offload) => {
        if (!(await okToMove(c))) return;
        actions.hidden = true;
        status.textContent = to === 'device' ? 'Moving…' : 'Saving…';
        try {
          await offload(app, c, to);
          if (to === 'device') { app.toast(`${c.name} is on this device now`); render(); return; }
          status.textContent = '';
          row.append(h('span.storage-confirm', {},
            h('small', {}, 'File saved?'),
            h('button.btn.small.primary', { type: 'button', onclick: async () => { await removeFromCloud(c.id).catch((e) => app.toast((e as Error).message)); render(); } }, 'Remove from cloud'),
            h('button.btn.small', { type: 'button', onclick: () => render() }, 'Keep')));
        } catch (e) { app.toast((e as Error).message || 'That canvas couldn’t be moved.'); actions.hidden = false; status.textContent = ''; }
      };
      list.append(row);
    }
    list.append(h('small.muted', {}, deviceNote()));
  };
  render();
  return [head, list];
}

/**
 * A cloud save didn't fit. Lists the cloud canvases to pick some to move off, to this device or as files,
 * then tries again. 'device' keeps the new canvas on this device instead; null cancels.
 */
export function freeUpDialog(app: App, what: string, need = 0): Promise<'retry' | 'device' | null> {
  return new Promise((resolve) => {
    let result: 'retry' | 'device' | null = null, to: Offload = 'device';
    const picked = new Set<string>();
    const body = h('div.modal-body.storage-free'), list = h('div.storage-list.pick'), sum = h('small.muted');
    const go = h('button.btn.primary', { type: 'button', disabled: true }, 'Move and save');
    const keep = h('button.btn', { type: 'button' }, 'Keep it on this device');
    const close = modal('Your cloud storage is full', body, [keep, go], () => resolve(result));
    keep.addEventListener('click', () => { result = 'device'; close(); });
    let info: StorageInfo | null = null;
    const update = () => {
      if (!info) return;
      const freed = info.canvases.filter((c) => picked.has(c.id)).reduce((n, c) => n + c.bytes, 0);
      const enough = storageFits({ used: info.used - freed, cap: info.cap }, need + 1024);
      sum.textContent = picked.size ? `${formatBytes(freed)} picked${enough ? '' : ', not quite enough yet'}` : 'Pick canvases to move off the cloud.';
      go.disabled = !picked.size;
    };
    const seg = h('div.segmented');
    const renderSeg = () => {
      seg.replaceChildren(...(['device', 'file'] as Offload[]).map((v) => h(`button${v === to ? '.active' : ''}` as 'button', { type: 'button', onclick: () => { to = v; renderSeg(); } }, OFFLOAD_LABEL[v])));
      note.textContent = to === 'device' ? deviceNote() : 'Each one downloads as a .hivecanvas you can open again later.';
    };
    const note = h('small.muted');
    renderSeg();
    body.append(h('span.muted', {}, 'Loading…'));
    loadStorage().then((s) => {
      info = s;
      if (!s) { body.replaceChildren(h('p', {}, 'Couldn’t reach your cloud storage. Try again in a moment.')); return; }
      clear(list);
      for (const c of s.canvases) {
        const open = app.ed.room?.id === c.id;
        const box = h('input', { type: 'checkbox', 'aria-label': `Move ${c.name}`, disabled: open });
        box.addEventListener('change', () => { if (box.checked) picked.add(c.id); else picked.delete(c.id); update(); });
        list.append(h('label', {}, canvasRow(c, open, box)));
      }
      body.replaceChildren(usageMeter(s), h('p', {}, `To save ${what} to the cloud, move some canvases off it. They’re listed biggest first.`),
        list, sum, h('div.pref-row', {}, h('span', {}, 'Move them'), seg), note);
      update();
    });
    go.addEventListener('click', async () => {
      if (!info) return;
      const chosen = info.canvases.filter((c) => picked.has(c.id));
      if (chosen.some((c) => c.visibility !== 'private') && !(await confirmDialog('Move shared canvases?', 'Some of these are shared. Once they leave the cloud, people you shared them with can’t open them.', 'Move'))) return;
      go.disabled = keep.disabled = true;
      let done = 0;
      try {
        for (const c of chosen) {
          go.textContent = `${to === 'device' ? 'Moving' : 'Saving'} ${++done} of ${chosen.length}…`;
          await offload(app, c, to);
        }
      } catch (e) {
        app.toast((e as Error).message || 'That canvas couldn’t be moved.');
        go.textContent = 'Move and save'; go.disabled = keep.disabled = false;
        return;
      }
      if (to === 'device') { result = 'retry'; close(); return; }
      // A download can't be checked from here, so the cloud copies stay until the person says the files saved.
      const remove = h('button.btn.primary', { type: 'button' }, 'Remove from cloud and save');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { for (const c of chosen) await removeFromCloud(c.id); result = 'retry'; close(); }
        catch (e) { app.toast((e as Error).message); remove.disabled = false; }
      });
      body.replaceChildren(h('p', {}, `${chosen.length === 1 ? 'Your file is' : `Your ${chosen.length} files are`} downloading. Check ${chosen.length === 1 ? 'it' : 'they'} saved, then remove ${chosen.length === 1 ? 'it' : 'them'} from the cloud.`),
        ...chosen.map((c) => h('div.storage-row', {}, h('span', { html: icon('file', 16) }), h('span.storage-name', {}, `${safeFileName(c.name)}.hivecanvas`))));
      body.parentElement!.querySelector('.modal-actions')!.replaceChildren(keep, remove);
      keep.disabled = false;
    });
  });
}
