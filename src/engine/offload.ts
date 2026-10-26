import type { Rect } from '../core/geom';
import type { Op } from '../core/model';
import type { ZipEntry } from '../shared/hivecanvas';
import { enclosedMask, floodMask } from './fill';
import { applyEffect } from './effects';
import { zipParts } from '../shared/hivecanvas';

export type Job =
  | { kind: 'fill'; img: ImageData; region: Rect; x: number; y: number; tolerance: number; expand: number }
  | { kind: 'enclosed'; img: ImageData; lasso: Uint8Array; tolerance: number; expand: number }
  | { kind: 'effect'; img: ImageData; op: Extract<Op, { t: 'effect' }>; ox: number; oy: number }
  | { kind: 'encode'; img: ImageData; type: string; quality?: number }
  | { kind: 'encodeMany'; imgs: ImageData[]; type: string }
  | { kind: 'zip'; entries: ZipEntry[] };

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();

/** The worker, made on first use; null where workers can't run (then everything runs inline). */
function get(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = waiting.get(e.data.id);
      if (!p) return;
      waiting.delete(e.data.id);
      if (e.data.error) p.rej(new Error(e.data.error)); else p.res(e.data.result);
    };
    // A worker that can't start (an old browser, a single-file build) fails every pending job: they fall back inline.
    w.onerror = () => { worker = null; w.terminate(); for (const p of waiting.values()) p.rej(new Error('worker')); waiting.clear(); };
    worker = w;
  } catch { worker = null; }
  return worker;
}

/** Runs `job` in the worker, or `inline` when it can't; `transfer` hands buffers over instead of copying. */
export async function offload<T>(job: Job, transfer: Transferable[], inline: () => T | Promise<T>): Promise<T> {
  const w = get();
  if (!w) return inline();
  const id = ++seq;
  try {
    return await new Promise<T>((res, rej) => { waiting.set(id, { res: res as (v: unknown) => void, rej }); w.postMessage({ id, job }, transfer); });
  } catch { return inline(); }
}

// Transferring a buffer empties it here, so inline fallbacks need their own copy of anything transferred.
const copy = (img: ImageData) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

export const fillMask = (img: ImageData, region: Rect, x: number, y: number, tolerance: number, expand: number) => {
  const mine = copy(img);
  return offload<Uint8Array | null>({ kind: 'fill', img, region, x, y, tolerance, expand }, [img.data.buffer], () => floodMask(mine, region, x, y, tolerance, expand));
};

export const enclosedFillMask = (img: ImageData, lasso: Uint8Array, tolerance: number, expand: number) => {
  const mine = copy(img), lassoCopy = new Uint8Array(lasso);
  return offload<Uint8Array | null>({ kind: 'enclosed', img, lasso, tolerance, expand }, [img.data.buffer, lasso.buffer], () => enclosedMask(mine, lassoCopy, tolerance, expand));
};

export const effectImage = (img: ImageData, op: Extract<Op, { t: 'effect' }>, ox: number, oy: number) => {
  const mine = copy(img);
  return offload<ImageData>({ kind: 'effect', img, op, ox, oy }, [img.data.buffer], () => { applyEffect(mine, op, ox, oy); return mine; });
};

const toBlob = (img: ImageData, type: string, quality?: number) => new Promise<Blob | null>((res) => {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  c.toBlob(res, type, quality);
});

/** PNG, JPEG or WebP bytes of an image; unsupported types come back as another type, as toBlob does. */
export const encodeImage = (img: ImageData, type: string, quality?: number) => {
  const mine = copy(img);
  return offload<Blob | null>({ kind: 'encode', img, type, quality }, [img.data.buffer], () => toBlob(mine, type, quality));
};

export const encodeImages = (imgs: ImageData[], type: string) => {
  const mine = imgs.map(copy);
  return offload<(Blob | null)[]>({ kind: 'encodeMany', imgs, type }, imgs.map((i) => i.data.buffer), () => Promise.all(mine.map((i) => toBlob(i, type))));
};

export const zipBlob = (entries: ZipEntry[]) =>
  offload<Uint8Array>({ kind: 'zip', entries }, [], () => { const parts = zipParts(entries); const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; })
    .then((bytes) => new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
