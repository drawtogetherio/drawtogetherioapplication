import { DrawDoc, toWire } from '../core/document';
import type { Op } from '../core/model';
import type { ShareSettings } from '../shared/protocol';
import { makeThumbnail } from '../io/thumbnail';
import { LocalCanvas, appendOps, getCanvas, loadOps, newLocalId, patchCanvas, putCanvas, replaceOps } from '../io/localStore';

const THUMB_DELAY_MS = 5_000, YIELD_MS = 30;
const HEAVY_TILE_BYTES = 8 * 1024 * 1024, HEAVY_OPS = 20_000;
type Settings = LocalCanvas['settings'];

/** A canvas kept in this browser, written as ops happen. */
export class LocalCopy {
  private pending: Op[] = [];
  private writing = Promise.resolve();
  private thumbTimer = 0;
  private thumbDoc: DrawDoc | null = null;

  constructor(public meta: LocalCanvas, private seq: number) {}

  static async create(user: string, name: string, settings: Settings, share: ShareSettings, room: string | null = null) {
    const now = Date.now();
    const meta: LocalCanvas = { id: newLocalId(), user, name, settings, share, room, createdAt: now, updatedAt: now, thumb: null };
    await putCanvas(meta);
    return new LocalCopy(meta, 0);
  }

  static async open(id: string) {
    const meta = await getCanvas(id);
    if (!meta) return null;
    const ops = await loadOps(id);
    return { copy: new LocalCopy(meta, ops.length), ops };
  }

  async toDoc(ops: Op[], onProgress?: (f: number) => void) {
    const doc = new DrawDoc({ id: 'doc_' + this.meta.id, ...this.meta.settings });
    let t = performance.now();
    for (let i = 0; i < ops.length; i++) {
      await doc.prepare(ops[i]);
      doc.apply(ops[i], { record: false });
      if (performance.now() - t > YIELD_MS) { onProgress?.((i + 1) / ops.length); await new Promise((r) => setTimeout(r)); t = performance.now(); }
    }
    return doc;
  }

  /** A log carrying many old undo pixels (or very long) is worth rewriting as a snapshot of the canvas. */
  static heavy(ops: Op[]) {
    let bytes = 0;
    for (const op of ops) if (op.t === 'tiles') for (const v of Object.values(op.tiles)) bytes += v?.length ?? 0;
    return bytes > HEAVY_TILE_BYTES || ops.length > HEAVY_OPS;
  }

  push(op: Op) {
    this.pending.push(toWire(op));
    if (this.pending.length === 1) queueMicrotask(() => this.flush());
  }

  flush() {
    const ops = this.pending, from = this.seq;
    this.pending = [];
    this.seq += ops.length;
    return this.writing = this.writing.then(() => appendOps(this.meta.id, ops, from)).catch(() => {});
  }

  /** Start over from a full history, e.g. the state a room sent us. */
  replaceWith(ops: Op[]) {
    const wire = ops.map(toWire);
    this.pending = [];
    this.seq = wire.length;
    return this.writing = this.writing.then(() => replaceOps(this.meta.id, wire)).catch(() => {});
  }

  patch(p: Partial<LocalCanvas>) {
    Object.assign(this.meta, p);
    return this.writing = this.writing.then(() => patchCanvas(this.meta.id, p)).catch(() => {});
  }

  thumb(doc: DrawDoc) {
    this.thumbDoc = doc;
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.flushThumb(), THUMB_DELAY_MS);
  }

  private async flushThumb() {
    clearTimeout(this.thumbTimer);
    const doc = this.thumbDoc;
    this.thumbDoc = null;
    if (!doc) return;
    const thumb = await makeThumbnail(doc).catch(() => null);
    if (thumb) await this.patch({ thumb });
  }

  async close() {
    await Promise.all([this.flush(), this.flushThumb()]);
  }
}
