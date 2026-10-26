import type { DrawDoc } from '../core/document';
import { uid } from '../core/geom';
import type { Op } from '../core/model';
import type { TiledSurface } from '../core/tiles';
import {
  CanvasManifest, HIVECANVAS_EXT, HIVELAPSE_EXT, HIVE_VERSION, HiveFileError, TILE_PX, TreeNode, ZipEntry,
  canvasEntries, canvasOps, readFormat, tileName, unzip,
} from '../shared/hivecanvas';
import { makeThumbnail } from './thumbnail';
import { encodeImages, zipBlob } from '../engine/offload';
import { ctx2d } from '../core/geom';

// .hivecanvas files in the app: written from the open canvas, read back into ops (see src/shared/hivecanvas.ts).

export const HIVE_ACCEPT = `${HIVECANVAS_EXT},${HIVELAPSE_EXT}`;

export const pngBytes = (c: HTMLCanvasElement) => new Promise<Uint8Array>((res, rej) =>
  c.toBlob((b) => (b ? b.arrayBuffer().then((a) => res(new Uint8Array(a)), rej) : rej(new Error('Encoding failed'))), 'image/png'));

/** Tiles go to the worker in batches to be PNG-encoded, so a big canvas doesn't hold the pen. */
async function surfaceEntries(dir: string, s: TiledSurface): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [], keys = [...s.tiles.keys()];
  for (let i = 0; i < keys.length; i += 24) {
    const batch = keys.slice(i, i + 24);
    const blobs = await encodeImages(batch.map((k) => ctx2d(s.tiles.get(k)!, true).getImageData(0, 0, TILE_PX, TILE_PX)), 'image/png');
    for (let j = 0; j < batch.length; j++) {
      const b = blobs[j];
      if (!b) throw new Error('Encoding failed');
      out.push({ name: `${dir}/${tileName(batch[j])}`, data: new Uint8Array(await b.arrayBuffer()) });
    }
  }
  return out;
}

/** The canvas as it looks now. Undo history stays behind, which keeps the file small. */
export async function hiveCanvasBlob(doc: DrawDoc, name: string): Promise<Blob> {
  const tree: TreeNode[] = [];
  const tiles: ZipEntry[] = [];
  const walk = async (parent: string | null) => {
    const kids = doc.children(parent);
    for (let index = 0; index < kids.length; index++) {
      const n = doc.node(kids[index])!;
      if (n.kind === 'folder') { tree.push({ kind: 'folder', props: { ...n.props }, parent, index }); await walk(n.props.id); continue; }
      tree.push({ kind: 'layer', props: { ...n.props }, parent, index });
      tiles.push(...await surfaceEntries(`layers/${n.props.id}`, n.surface));
      if (n.mask) tiles.push(...await surfaceEntries(`masks/${n.props.id}`, n.mask));
    }
  };
  await walk(null);
  const s = doc.settings;
  const manifest: CanvasManifest = { format: 'hivecanvas', version: HIVE_VERSION, name, settings: { width: s.width, height: s.height, infinite: s.infinite, background: s.background }, savedAt: Date.now() };
  const entries = [...canvasEntries(manifest, tree), ...tiles];
  const thumb = await makeThumbnail(doc).catch(() => null);
  if (thumb) entries.push({ name: thumb.type === 'image/webp' ? 'thumb.webp' : 'thumb.jpg', data: new Uint8Array(await thumb.arrayBuffer()) });
  return zipBlob(entries);
}

export async function inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > maxBytes) throw new HiveFileError('That file is damaged.');
    chunks.push(c);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function readHiveFile(file: Blob) {
  const files = await unzip(new Uint8Array(await file.arrayBuffer()), inflate);
  return { format: readFormat(files), files };
}

export function hiveCanvasOps(files: Map<string, Uint8Array>): { manifest: CanvasManifest; ops: Op[] } {
  return canvasOps(files, () => uid());
}

/** File names people pick, without characters file systems refuse. */
export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'canvas';
