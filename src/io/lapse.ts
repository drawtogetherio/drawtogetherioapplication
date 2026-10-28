import type { DocChange, DrawDoc } from '../core/document';
import { ctx2d } from '../core/geom';
import { TILE, TiledSurface } from '../core/tiles';
import { renderRegion } from '../engine/compositor';
import {
  HIVE_VERSION, HiveSettings, LapseFrameInfo, LapseManifest, ZipEntry, jsonBytes, readLapse, tileName, zipParts,
} from '../shared/hivecanvas';
import { done, finished } from './idb';

// Timelapses, recorded on this device and never sent anywhere. Every few seconds the recorder
// composites the 256 px tiles that changed and keeps them losslessly as PNGs, so a frame is only as
// big as what changed. Frames live in their own IndexedDB database; a .hivelapse file is the same
// frames in a zip.

const DB = 'doodlehive-lapse', VERSION = 1;
const INTERVAL_MS = 10_000;
/** Past this the frames are merged in pairs, so a lapse stays bounded however long the drawing takes. */
export const MAX_FRAMES = 2_000;
const YIELD_MS = 12;
const PREF_KEY = 'doodlehive.lapse';

export interface LapseFrame { t: number; tiles: Map<string, Blob | null> }
export interface LapseSource { name: string; settings: HiveSettings; frames: LapseFrame[] }

interface LapseMeta {
  key: string; name: string; settings: HiveSettings;
  frames: number; nextSeq: number; startedAt: number; updatedAt: number;
  /** Fingerprint of each tile as last recorded; a tile only goes in a frame when it differs. */
  hashes: Record<string, number>;
}
interface FrameRow { key: string; seq: number; t: number; tiles: Record<string, Blob | null> }

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('lapses', { keyPath: 'key' });
      d.createObjectStore('frames', { keyPath: ['key', 'seq'] });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
const range = (key: string) => IDBKeyRange.bound([key, 0], [key, Infinity]);

export const roomLapseKey = (roomId: string) => 'room:' + roomId;

export async function getLapse(key: string): Promise<LapseMeta | undefined> {
  const d = await open();
  return done(d.transaction('lapses').objectStore('lapses').get(key) as IDBRequest<LapseMeta | undefined>);
}

async function addFrame(meta: LapseMeta, frame: FrameRow) {
  const d = await open();
  const tx = d.transaction(['lapses', 'frames'], 'readwrite');
  tx.objectStore('frames').put(frame);
  tx.objectStore('lapses').put(meta);
  await finished(tx);
}

async function frameRows(key: string): Promise<FrameRow[]> {
  const d = await open();
  return done(d.transaction('frames').objectStore('frames').getAll(range(key)) as IDBRequest<FrameRow[]>);
}

/** Merges neighbouring frames: the later tiles win, so playback ends the same, just in bigger steps. */
async function thin(meta: LapseMeta) {
  const rows = await frameRows(meta.key);
  const merged: FrameRow[] = [];
  for (let i = 0; i < rows.length; i += 2) {
    const a = rows[i], b = rows[i + 1];
    merged.push({ key: meta.key, seq: merged.length, t: (b ?? a).t, tiles: b ? { ...a.tiles, ...b.tiles } : a.tiles });
  }
  const d = await open();
  const tx = d.transaction(['lapses', 'frames'], 'readwrite');
  const fs = tx.objectStore('frames');
  fs.delete(range(meta.key));
  for (const r of merged) fs.put(r);
  meta.frames = merged.length;
  meta.nextSeq = merged.length;
  tx.objectStore('lapses').put(meta);
  await finished(tx);
}

export async function deleteLapse(key: string) {
  const d = await open();
  const tx = d.transaction(['lapses', 'frames'], 'readwrite');
  tx.objectStore('frames').delete(range(key));
  tx.objectStore('lapses').delete(key);
  await finished(tx);
}

/** A device canvas that moved to the server keeps its timelapse. */
export async function moveLapse(from: string, to: string) {
  const meta = await getLapse(from);
  if (!meta) return;
  const rows = await frameRows(from);
  const d = await open();
  const tx = d.transaction(['lapses', 'frames'], 'readwrite');
  const fs = tx.objectStore('frames');
  for (const r of rows) fs.put({ ...r, key: to });
  fs.delete(range(from));
  tx.objectStore('lapses').put({ ...meta, key: to });
  tx.objectStore('lapses').delete(from);
  await finished(tx);
}

export async function loadLapse(key: string): Promise<LapseSource | null> {
  const meta = await getLapse(key);
  if (!meta) return null;
  const rows = await frameRows(key);
  return { name: meta.name, settings: meta.settings, frames: rows.map((r) => ({ t: r.t, tiles: new Map(Object.entries(r.tiles)) })) };
}

// ---- .hivelapse files ----

export async function hiveLapseBlob(src: LapseSource): Promise<Blob> {
  const frames: LapseFrameInfo[] = [];
  const images: ZipEntry[] = [];
  for (let n = 0; n < src.frames.length; n++) {
    const f = src.frames[n], info: LapseFrameInfo = { t: f.t, tiles: [], cleared: [] };
    for (const [k, b] of f.tiles) {
      if (!b) { info.cleared.push(k); continue; }
      info.tiles.push(k);
      images.push({ name: `frames/${n}/${tileName(k)}`, data: new Uint8Array(await b.arrayBuffer()) });
    }
    frames.push(info);
  }
  const manifest: LapseManifest = { format: 'hivelapse', version: HIVE_VERSION, name: src.name, settings: src.settings, frames };
  return new Blob(zipParts([{ name: 'manifest.json', data: jsonBytes(manifest) }, ...images]) as BlobPart[], { type: 'application/octet-stream' });
}

export function lapseFromFiles(files: Map<string, Uint8Array>): LapseSource {
  const { manifest, frame } = readLapse(files);
  const frames = manifest.frames.map((f, n) => {
    const tiles = new Map<string, Blob | null>();
    for (const [k, d] of frame(n)) tiles.set(k, d ? new Blob([d as BlobPart], { type: 'image/png' }) : null);
    return { t: f.t, tiles };
  });
  return { name: manifest.name, settings: manifest.settings, frames };
}

// ---- Recording ----

export function recordingOn(): boolean {
  try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; }
}
export function setRecording(on: boolean) {
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* storage blocked: stays on for this visit */ }
}

/** FNV-1a over the pixels; 0 means the tile is empty. */
function fingerprint(d: Uint8ClampedArray): number {
  const u = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
  let h = 0x811c9dc5, any = false;
  for (let i = 0; i < u.length; i++) {
    const v = u[i];
    if (v >>> 24) any = true;
    h = Math.imul(h ^ v, 0x01000193);
  }
  return any ? (h >>> 0) || 1 : 0;
}

const pngBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), 'image/png'));

/** Records the open canvas. One at a time; `attach` again when the canvas changes. */
class Recorder {
  key: string | null = null;
  private doc: DrawDoc | null = null;
  private name = '';
  private off: (() => void) | null = null;
  private timer = 0;
  private dirty = new Set<string>();
  private all = false;
  private meta: LapseMeta | null = null;
  private running: Promise<void> = Promise.resolve();

  attach(doc: DrawDoc, key: string, name: string) {
    if (this.doc === doc && this.key === key) return;
    this.detach();
    this.doc = doc;
    this.key = key;
    this.name = name;
    this.all = true; // the first frame picks up whatever changed while we weren't recording
    this.off = doc.on((c) => this.mark(c));
    this.timer = window.setInterval(() => this.capture(), INTERVAL_MS);
    this.meta = null;
  }

  rename(name: string) { this.name = name; if (this.meta) this.meta.name = name; }

  /** Stops recording, keeping a last frame of anything still unrecorded. */
  detach(): Promise<void> {
    if (!this.doc) return this.running;
    const last = this.capture();
    this.off?.();
    this.off = null;
    clearInterval(this.timer);
    this.doc = null;
    this.key = null;
    return last;
  }

  /** Records anything pending now, e.g. before exporting. */
  flush() { return this.capture(); }

  private mark(c: DocChange) {
    if (!c.rect) { this.all = true; return; }
    if (c.rect.w <= 0 || c.rect.h <= 0) return;
    for (const k of new TiledSurface().keysIn(c.rect)) this.dirty.add(k);
  }

  private capture(): Promise<void> {
    const doc = this.doc, key = this.key;
    if (!doc || !key || (!this.all && !this.dirty.size) || !recordingOn()) return this.running;
    const all = this.all, dirty = this.dirty;
    this.all = false;
    this.dirty = new Set();
    return this.running = this.running.then(() => this.record(doc, key, all, dirty)).catch(() => {});
  }

  private async record(doc: DrawDoc, key: string, all: boolean, dirty: Set<string>) {
    let meta = this.meta?.key === key ? this.meta : await getLapse(key);
    const s = doc.settings;
    if (!meta) {
      const now = Date.now();
      meta = { key, name: this.name, settings: { width: s.width, height: s.height, infinite: s.infinite, background: s.background }, frames: 0, nextSeq: 0, startedAt: now, updatedAt: now, hashes: {} };
    }
    this.meta = meta;
    const keys = new Set(dirty);
    if (all) {
      for (const l of doc.layers) for (const k of l.surface.tiles.keys()) keys.add(k);
      for (const k of Object.keys(meta.hashes)) keys.add(k);
    }
    const inCanvas = (k: string) => {
      if (s.infinite) return true;
      const [tx, ty] = TiledSurface.parse(k);
      return tx >= 0 && ty >= 0 && tx * TILE < s.width && ty * TILE < s.height;
    };
    const tiles: Record<string, Blob | null> = {};
    let n = 0, t = performance.now();
    for (const k of keys) {
      if (!inCanvas(k)) continue;
      const [tx, ty] = TiledSurface.parse(k);
      const c = renderRegion(doc, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE }, { paper: false });
      const h = fingerprint(ctx2d(c, true).getImageData(0, 0, TILE, TILE).data);
      if (h !== (meta.hashes[k] ?? 0)) {
        if (h) { tiles[k] = await pngBlob(c); meta.hashes[k] = h; }
        else { tiles[k] = null; delete meta.hashes[k]; }
        n++;
      }
      if (performance.now() - t > YIELD_MS) { await new Promise((r) => setTimeout(r)); t = performance.now(); }
    }
    if (!n) return;
    meta.name = this.name || meta.name;
    meta.updatedAt = Date.now();
    meta.frames++;
    const frame: FrameRow = { key, seq: meta.nextSeq++, t: meta.updatedAt, tiles };
    await addFrame(meta, frame);
    if (meta.frames > MAX_FRAMES) await thin(meta);
  }
}

export const lapse = new Recorder();
