import { DrawDoc } from '../core/document';
import { ctx2d, uid } from '../core/geom';
import type { Op } from '../core/model';
import { OP_LABEL } from './opLabels';
import { TILE, TiledSurface } from '../core/tiles';
import type { Editor } from '../editor';
import { api } from '../net/api';
import type { RoomClient } from '../net/roomClient';
import type { PublicProfile } from '../shared/profile';
import type { LogEntry } from '../shared/protocol';
import { confirmDialog, modal } from './dialogs';
import { clear, h } from './dom';
import { avatarEl, nameText } from './people';

/** Edits that change pixels: the ones a host can take out of the canvas. */
const PIXELS = new Set<string>(['stroke', 'smudge', 'effect', 'shape', 'fill', 'fillPoly', 'gradient', 'transform', 'tiles', 'layer.clear', 'layer.mask.apply']);
const PAGE = 150;

/** Hosts: who did what, by person, with a Remove for any edit that touched pixels. */
export async function editLogDialog(ed: Editor) {
  const room = ed.room;
  if (!room) return;
  let log: Awaited<ReturnType<typeof api.roomLog>>;
  try { log = await api.roomLog(room.id); } catch (e) { ed.toast((e as Error).message); return; }
  const people = new Map<string, PublicProfile>(log.people.map((p) => [p.id, p]));
  for (const m of room.members) people.set(m.id, m);
  const who = (id: string) => people.get(id);
  const entries = log.entries.slice().reverse();
  const list = h('div.log-entries'), side = h('div.log-people');
  let person: string | null = null, shown = PAGE;

  const when = (at: number | null) => {
    if (!at) return '';
    const d = new Date(at), today = new Date().toDateString() === d.toDateString();
    return (today ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const nodeName = (e: LogEntry) => { const id = e.layer ?? e.folder; return id ? ed.doc.node(id)?.props.name ?? (e.layer ? 'a deleted layer' : 'a deleted folder') : ''; };

  const row = (e: LogEntry) => {
    const p = who(e.author);
    const el = h('div.log-row', {},
      p ? avatarEl(p, 20) : h('span.avatar', { style: 'width:20px;height:20px' }),
      h('span.log-what', {}, h('b', {}, OP_LABEL[e.t] ?? e.t), e.layer || e.folder ? h('small', {}, ' · ' + nodeName(e)) : null),
      h('small.log-when', {}, when(e.at)),
    );
    if (PIXELS.has(e.t) && e.layer && ed.doc.layer(e.layer)) {
      el.append(h('button.btn.small.danger', { type: 'button', onclick: async () => {
        if (!(await confirmDialog('Remove this edit?', `${p?.displayName ?? 'Their'} ${OP_LABEL[e.t].toLowerCase()} on ${nodeName(e)} is taken off the canvas for everyone. Later edits stay.`, 'Remove'))) return;
        el.classList.add('busy');
        const status = h('small.log-when', {}, 'Removing…');
        el.lastElementChild!.replaceWith(status);
        try {
          const changed = await removeEdit(ed, room, e, (t) => { status.textContent = t; });
          status.textContent = changed ? 'Removed' : 'Nothing left of it';
          el.classList.add('removed');
        } catch (err) { status.textContent = (err as Error).message; el.classList.remove('busy'); }
      } }, 'Remove'));
    }
    return el;
  };
  const render = () => {
    clear(list);
    const mine = person ? entries.filter((e) => e.author === person) : entries;
    for (const e of mine.slice(0, shown)) list.append(row(e));
    if (mine.length > shown) list.append(h('button.btn.small', { type: 'button', onclick: () => { shown += PAGE; render(); } }, `Show more (${mine.length - shown})`));
    if (!mine.length) list.append(h('small.muted', {}, 'Nothing yet.'));
    for (const b of side.children) b.classList.toggle('active', (b as HTMLElement).dataset.who === (person ?? ''));
  };
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.author, (counts.get(e.author) ?? 0) + 1);
  const personBtn = (id: string | null, label: HTMLElement | string, n: number) =>
    h('button.log-person', { type: 'button', 'data-who': id ?? '', onclick: () => { person = id; shown = PAGE; render(); } }, label, h('small', {}, String(n)));
  side.append(personBtn(null, 'Everyone', entries.length));
  for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const p = who(id);
    side.append(personBtn(id, p ? h('span.log-name', {}, avatarEl(p, 20), nameText(p, 'person-name', p.favoriteColor)) : id === 'server' ? 'Doodlehive' : 'Someone', n));
  }
  render();
  modal('Edit log', h('div.modal-body.edit-log', {}, side, list), []);
}

/**
 * Takes one edit out of the canvas: the layer is rebuilt from its history without it, and the tiles
 * that differ go out as an ordinary edit everyone gets (and the host can undo). Rebuilding needs the
 * canvas to sit still, so other people's edits wait meanwhile.
 */
async function removeEdit(ed: Editor, room: RoomClient, e: LogEntry, progress: (t: string) => void) {
  await room.settled();
  room.freeze = true;
  try {
    progress('Loading history…');
    let hist = await api.roomHistory(room.id, room.lastSeq, e.layer);
    const partial = hist.complete;
    if (!partial) hist = await api.roomHistory(room.id, room.lastSeq, null);
    const scratch = new DrawDoc({ ...ed.doc.settings });
    let t = performance.now();
    for (let i = 0; i < hist.ops.length; i++) {
      let op = hist.ops[i];
      if (op.id === e.id) continue;
      if (partial && op.t === 'layer.add') op = { ...op, parent: null, index: 0 };
      scratch.apply(op, { ...await scratch.prepared(op), record: false });
      if (performance.now() - t > 30) { progress(`Rebuilding… ${Math.round((100 * i) / hist.ops.length)}%`); await new Promise((r) => setTimeout(r)); t = performance.now(); }
    }
    const ids = partial ? [e.layer!] : ed.doc.layers.map((l) => l.props.id);
    const ops: Op[] = [];
    for (const id of ids) {
      const cur = ed.doc.layer(id), was = scratch.layer(id);
      if (!cur) continue;
      const img = diff(cur.surface, was?.surface), mask = cur.mask ? diff(cur.mask, was?.mask) : null;
      if (img) ops.push({ t: 'tiles', id: uid(), layer: id, tiles: {}, img });
      if (mask) ops.push({ t: 'tiles', id: uid(), layer: id, mask: true, tiles: {}, img: mask });
    }
    if (ops.length) ed.run(ops, 'Remove edit');
    return ops.length > 0;
  } finally {
    room.freeze = false;
  }
}

/** Tiles of `now` that differ from `then`: what to write so the layer looks like `then`. */
function diff(now: TiledSurface, then: TiledSurface | null | undefined): Record<string, ImageData | null> | null {
  const out: Record<string, ImageData | null> = {};
  let any = false;
  const pixels = (s: TiledSurface | null | undefined, k: string) => { const c = s?.tiles.get(k); return c ? ctx2d(c, true).getImageData(0, 0, TILE, TILE) : null; };
  for (const k of new Set([...now.tiles.keys(), ...(then?.tiles.keys() ?? [])])) {
    const a = pixels(now, k), b = pixels(then, k);
    if (!a && !b) continue;
    if (a && b) {
      const da = a.data, db = b.data;
      let same = true;
      for (let i = 3; i < da.length && same; i += 4) same = da[i] === db[i] && (da[i] === 0 || (da[i - 3] === db[i - 3] && da[i - 2] === db[i - 2] && da[i - 1] === db[i - 1]));
      if (same) continue;
    } else if (blank(a ?? b!)) continue;
    out[k] = b;
    any = true;
  }
  return any ? out : null;
}

function blank(d: ImageData) {
  for (let i = 3; i < d.data.length; i += 4) if (d.data[i]) return false;
  return true;
}
