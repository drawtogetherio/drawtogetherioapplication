import { BLEND_MODES, type FolderProps, type LayerProps, type Op } from '../core/model';

// Doodlehive's own files, shared by the app and the server. Both are plain zips:
//
//   .hivecanvas  the canvas as it looks now, never its undo history
//     manifest.json  { format: 'hivecanvas', version, name, settings }
//     tree.json      folders and layers, parents before children, each with its place
//     layers/<layer id>/<tx>_<ty>.png  256 px tiles of the layer's pixels
//     masks/<layer id>/<tx>_<ty>.png   the same for its mask
//     thumb.webp     optional preview
//
//   .hivelapse   a timelapse, recorded and kept on the device only; the server never takes one
//     manifest.json  { format: 'hivelapse', version, name, settings, frames: [{ t, tiles, cleared }] }
//     frames/<n>/<tx>_<ty>.png  the composited tiles that changed in frame n

export const HIVECANVAS_EXT = '.hivecanvas';
export const HIVELAPSE_EXT = '.hivelapse';
export const HIVE_VERSION = 1;
export const TILE_PX = 256;
/** Tiles per `tiles` op, well under what a room accepts in one. */
export const TILES_PER_OP = 256;

export interface HiveSettings { width: number; height: number; infinite: boolean; background: string | null }

export interface CanvasManifest { format: 'hivecanvas'; version: number; name: string; settings: HiveSettings; savedAt?: number }

export type TreeNode =
  | { kind: 'layer'; props: LayerProps; parent: string | null; index: number }
  | { kind: 'folder'; props: FolderProps; parent: string | null; index: number };

export interface LapseFrameInfo { t: number; tiles: string[]; cleared: string[] }
export interface LapseManifest { format: 'hivelapse'; version: number; name: string; settings: HiveSettings; frames: LapseFrameInfo[] }

export class HiveFileError extends Error {}

const MAX_ENTRIES = 60_000, MAX_NODES = 2_000, MAX_TILE_BYTES = 290_000, MAX_FILE_BYTES = 200 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
const TILE_RE = /^(-?\d{1,6})_(-?\d{1,6})\.png$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ---- Zip (store only when writing; store or deflate when reading) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(d: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { name: string; data: Uint8Array }

/** The parts of a store-only zip, in order; join them into a Blob or Buffer. */
export function zipParts(entries: ZipEntry[]): Uint8Array[] {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0, centralSize = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + e.data.length;
    centralSize += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return [...parts, ...central, new Uint8Array(end.buffer)];
}

export type Inflate = (data: Uint8Array, maxBytes: number) => Promise<Uint8Array>;

/** Reads a zip's files from its central directory. Deflated entries need `inflate`. */
export async function unzip(bytes: Uint8Array, inflate?: Inflate): Promise<Map<string, Uint8Array>> {
  if (bytes.length > MAX_FILE_BYTES) throw new HiveFileError('That file is too large.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new HiveFileError('That file isn’t a Doodlehive file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new HiveFileError('That file has too many parts.');
  const dec = new TextDecoder(), out = new Map<string, Uint8Array>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new HiveFileError('That file is damaged.');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), at = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (at + 30 > bytes.length || dv.getUint32(at, true) !== 0x04034b50) throw new HiveFileError('That file is damaged.');
    const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
    if (start + csize > bytes.length) throw new HiveFileError('That file is damaged.');
    total += usize;
    if (total > MAX_FILE_BYTES) throw new HiveFileError('That file is too large.');
    const raw = bytes.subarray(start, start + csize);
    if (name.endsWith('/')) continue;
    if (method === 0) out.set(name, raw);
    else if (method === 8 && inflate) {
      const d = await inflate(raw, usize);
      if (d.length !== usize) throw new HiveFileError('That file is damaged.');
      out.set(name, d);
    } else throw new HiveFileError('That file uses compression Doodlehive can’t read.');
  }
  return out;
}

// ---- Helpers ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64(d: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < d.length; i += 3) {
    const n = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < d.length) {
    const n = (d[i] << 16) | ((d[i + 1] ?? 0) << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < d.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return s;
}

export function unbase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, n = 0, bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new HiveFileError('Bad image data.');
    n = (n << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (n >> bits) & 255; }
  }
  return out.subarray(0, o);
}

export const isPng = (d: Uint8Array) => d.length > 8 && PNG_MAGIC.every((b, i) => d[i] === b);
export const tileName = (key: string) => key.replace(',', '_') + '.png';
export const tileKey = (file: string) => { const m = TILE_RE.exec(file); return m ? `${+m[1]},${+m[2]}` : null; };

export const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
function readJson(files: Map<string, Uint8Array>, name: string): unknown {
  const d = files.get(name);
  if (!d) throw new HiveFileError('That file isn’t a Doodlehive file.');
  try { return JSON.parse(new TextDecoder().decode(d)); } catch { throw new HiveFileError('That file is damaged.'); }
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanSettings(v: unknown): HiveSettings {
  if (!obj(v)) throw new HiveFileError('That file is damaged.');
  const infinite = v.infinite === true;
  const width = Math.round(Number(v.width)) || 2048, height = Math.round(Number(v.height)) || 2048;
  if (!infinite && !(width >= 16 && height >= 16 && width <= 16384 && height <= 16384 && width * height <= 100e6)) throw new HiveFileError('That canvas size isn’t supported.');
  const background = typeof v.background === 'string' && /^#[0-9a-f]{6}$/i.test(v.background) ? v.background.toLowerCase() : null;
  return { width, height, infinite, background };
}

export function readFormat(files: Map<string, Uint8Array>): 'hivecanvas' | 'hivelapse' {
  const m = readJson(files, 'manifest.json');
  if (obj(m) && (m.format === 'hivecanvas' || m.format === 'hivelapse')) {
    if (typeof m.version !== 'number' || m.version > HIVE_VERSION) throw new HiveFileError('That file is from a newer Doodlehive. Update the app to open it.');
    return m.format;
  }
  throw new HiveFileError('That file isn’t a Doodlehive file.');
}

// ---- .hivecanvas ----

/** Everything a .hivecanvas holds besides the tile images. */
export function canvasEntries(manifest: CanvasManifest, tree: TreeNode[]): ZipEntry[] {
  return [{ name: 'manifest.json', data: jsonBytes(manifest) }, { name: 'tree.json', data: jsonBytes(tree) }];
}

/**
 * The ops that rebuild a .hivecanvas: its folders and layers, then their pixels as `tiles` ops in the
 * same form rooms send them. Shapes are only checked loosely here; rooms validate every op anyway.
 */
export function canvasOps(files: Map<string, Uint8Array>, uid: () => string): { manifest: CanvasManifest; ops: Op[] } {
  if (readFormat(files) !== 'hivecanvas') throw new HiveFileError('That’s a timelapse, not a canvas.');
  const m = readJson(files, 'manifest.json') as Record<string, unknown>;
  const manifest: CanvasManifest = {
    format: 'hivecanvas', version: Number(m.version), settings: cleanSettings(m.settings),
    name: typeof m.name === 'string' ? m.name.slice(0, 64) : '',
  };
  const tree = readJson(files, 'tree.json');
  if (!Array.isArray(tree) || tree.length > MAX_NODES) throw new HiveFileError('That file is damaged.');
  const ops: Op[] = [], layers = new Set<string>(), seen = new Set<string>();
  for (const n of tree) {
    if (!obj(n) || !obj(n.props) || typeof n.props.id !== 'string' || !ID_RE.test(n.props.id) || seen.has(n.props.id)) throw new HiveFileError('That file is damaged.');
    const parent = n.parent === null || n.parent === undefined ? null : String(n.parent);
    if (parent !== null && !seen.has(parent)) throw new HiveFileError('That file is damaged.');
    const index = Number.isInteger(n.index) ? Math.max(0, n.index as number) : 0;
    seen.add(n.props.id);
    if (n.kind === 'layer') {
      const p = n.props as unknown as LayerProps;
      const props: LayerProps = { id: p.id, name: String(p.name ?? 'Layer').slice(0, 64), visible: p.visible !== false, opacity: Math.min(1, Math.max(0, Number(p.opacity ?? 1))), blend: BLEND_MODES.includes(p.blend) ? p.blend : 'normal', alphaLock: !!p.alphaLock };
      if (p.clip) props.clip = true;
      if (p.mask) props.mask = true;
      if (typeof p.owner === 'string') props.owner = p.owner;
      ops.push({ t: 'layer.add', id: uid(), layer: props, parent, index });
      layers.add(p.id);
    } else if (n.kind === 'folder') {
      const p = n.props as unknown as FolderProps;
      const props: FolderProps = { id: p.id, name: String(p.name ?? 'Folder').slice(0, 64), visible: p.visible !== false };
      if (typeof p.owner === 'string') props.owner = p.owner;
      if (p.user) props.user = true;
      if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) props.color = p.color;
      ops.push({ t: 'folder.add', id: uid(), folder: props, parent, index });
    } else throw new HiveFileError('That file is damaged.');
  }
  // Tiles grouped per layer (and mask), in chunks a room accepts.
  const groups = new Map<string, Record<string, string>>();
  for (const [name, data] of files) {
    const parts = name.split('/');
    if (parts.length !== 3 || (parts[0] !== 'layers' && parts[0] !== 'masks') || !layers.has(parts[1])) continue;
    const key = tileKey(parts[2]);
    if (!key || data.length > MAX_TILE_BYTES || !isPng(data)) continue;
    const g = parts[0] + '/' + parts[1];
    let rec = groups.get(g);
    if (!rec) groups.set(g, rec = {});
    rec[key] = 'data:image/png;base64,' + base64(data);
  }
  for (const [g, tiles] of groups) {
    const [kind, layer] = g.split('/');
    const keys = Object.keys(tiles);
    for (let i = 0; i < keys.length; i += TILES_PER_OP) {
      const chunk: Record<string, string> = {};
      for (const k of keys.slice(i, i + TILES_PER_OP)) chunk[k] = tiles[k];
      const op: Op = { t: 'tiles', id: uid(), layer, tiles: chunk };
      if (kind === 'masks') op.mask = true;
      ops.push(op);
    }
  }
  return { manifest, ops };
}

// ---- .hivelapse ----

export function readLapse(files: Map<string, Uint8Array>): { manifest: LapseManifest; frame: (n: number) => Map<string, Uint8Array | null> } {
  if (readFormat(files) !== 'hivelapse') throw new HiveFileError('That’s a canvas, not a timelapse.');
  const m = readJson(files, 'manifest.json') as Record<string, unknown>;
  if (!Array.isArray(m.frames)) throw new HiveFileError('That file is damaged.');
  const frames: LapseFrameInfo[] = m.frames.filter(obj).map((f) => ({
    t: Number(f.t) || 0,
    tiles: Array.isArray(f.tiles) ? f.tiles.filter((k): k is string => typeof k === 'string') : [],
    cleared: Array.isArray(f.cleared) ? f.cleared.filter((k): k is string => typeof k === 'string') : [],
  }));
  const manifest: LapseManifest = { format: 'hivelapse', version: Number(m.version), name: typeof m.name === 'string' ? m.name.slice(0, 64) : '', settings: cleanSettings(m.settings), frames };
  const frame = (n: number) => {
    const out = new Map<string, Uint8Array | null>();
    for (const k of frames[n].cleared) out.set(k, null);
    for (const k of frames[n].tiles) { const d = files.get(`frames/${n}/${tileName(k)}`); if (d && isPng(d)) out.set(k, d); }
    return out;
  };
  return { manifest, frame };
}
