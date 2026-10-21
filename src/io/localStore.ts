import type { Op } from '../core/model';
import type { ShareSettings } from '../shared/protocol';
import { NativeCanvas, native } from './native';

// Canvases kept on this device: free accounts draw here; shared rooms leave a copy here too.
// In the browser that is IndexedDB; the desktop app keeps files instead (see desktop/).

export interface LocalCanvas {
  id: string;
  /** Account the canvas belongs to on this device. */
  user: string;
  name: string;
  settings: { width: number; height: number; infinite: boolean; background: string | null };
  share: ShareSettings;
  /** Live room this canvas is shared as, until that room closes. */
  room: string | null;
  createdAt: number;
  updatedAt: number;
  thumb: Blob | null;
}

const DB = 'doodlehive', VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('canvases', { keyPath: 'id' }).createIndex('user', 'user');
      d.createObjectStore('ops', { keyPath: ['canvas', 'seq'] });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

const done = <T>(req: IDBRequest<T>) => new Promise<T>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const finished = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export const newLocalId = () => 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const fromNative = (c: NativeCanvas): LocalCanvas => ({ ...c, thumb: c.thumb ? new Blob([c.thumb.bytes as BlobPart], { type: c.thumb.type }) : null });
const toNative = async (c: LocalCanvas): Promise<NativeCanvas> =>
  ({ ...c, thumb: c.thumb ? { type: c.thumb.type, bytes: new Uint8Array(await c.thumb.arrayBuffer()) } : null });

export async function listCanvases(user: string): Promise<LocalCanvas[]> {
  let all: LocalCanvas[];
  if (native) all = (await native.canvases.list(user)).map(fromNative);
  else {
    const d = await open();
    all = await done(d.transaction('canvases').objectStore('canvases').index('user').getAll(user) as IDBRequest<LocalCanvas[]>);
  }
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getCanvas(id: string): Promise<LocalCanvas | undefined> {
  if (native) return (await native.canvases.get(id).then((c) => c && fromNative(c))) ?? undefined;
  const d = await open();
  return done(d.transaction('canvases').objectStore('canvases').get(id) as IDBRequest<LocalCanvas | undefined>);
}

export async function putCanvas(c: LocalCanvas) {
  if (native) return native.canvases.put(await toNative(c));
  const d = await open();
  const tx = d.transaction('canvases', 'readwrite');
  tx.objectStore('canvases').put(c);
  await finished(tx);
}

export async function patchCanvas(id: string, patch: Partial<LocalCanvas>) {
  const c = await getCanvas(id);
  if (c) await putCanvas({ ...c, ...patch });
}

export async function loadOps(id: string): Promise<Op[]> {
  if (native) return native.canvases.loadOps(id);
  const d = await open();
  const rows = await done(d.transaction('ops').objectStore('ops').getAll(IDBKeyRange.bound([id, 0], [id, Infinity])) as IDBRequest<{ op: Op }[]>);
  return rows.map((r) => r.op);
}

/** Appends in order; `seq` keeps growing across sessions. */
export async function appendOps(id: string, ops: Op[], from: number) {
  if (!ops.length) return;
  if (native) { await native.canvases.appendOps(id, ops); return patchCanvas(id, { updatedAt: Date.now() }); }
  const d = await open();
  const tx = d.transaction(['ops', 'canvases'], 'readwrite');
  const store = tx.objectStore('ops');
  ops.forEach((op, i) => store.put({ canvas: id, seq: from + i, op }));
  const c = await done(tx.objectStore('canvases').get(id) as IDBRequest<LocalCanvas | undefined>);
  if (c) tx.objectStore('canvases').put({ ...c, updatedAt: Date.now() });
  await finished(tx);
}

export async function replaceOps(id: string, ops: Op[]) {
  if (native) return native.canvases.replaceOps(id, ops);
  const d = await open();
  const tx = d.transaction('ops', 'readwrite');
  const store = tx.objectStore('ops');
  store.delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  ops.forEach((op, i) => store.put({ canvas: id, seq: i, op }));
  await finished(tx);
}

export async function deleteCanvas(id: string) {
  if (native) return native.canvases.delete(id);
  const d = await open();
  const tx = d.transaction(['ops', 'canvases'], 'readwrite');
  tx.objectStore('ops').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  tx.objectStore('canvases').delete(id);
  await finished(tx);
}
