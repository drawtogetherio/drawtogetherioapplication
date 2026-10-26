// Brush images (tip shapes, dual tips, textures) are content-addressed: the id is the first 32 hex
// characters of the PNG's SHA-256, so the same image is one asset everywhere and can be cached forever.
import type { BrushParams } from '../core/model';

export const ASSET_ID_RE = /^[0-9a-f]{32}$/;
export const isAssetId = (v: unknown): v is string => typeof v === 'string' && ASSET_ID_RE.test(v);
/** Stored PNGs: at most this many bytes, and this wide or tall. */
export const MAX_ASSET_BYTES = 64 * 1024, MAX_ASSET_SIZE = 256;

/** The asset ids a brush draws with. */
export function brushAssets(b: BrushParams): string[] {
  const ids: string[] = [];
  if (isAssetId(b.shape)) ids.push(b.shape);
  if (b.dual) ids.push(b.dual);
  if (b.texture) ids.push(b.texture);
  return ids;
}

/** PNG signature and its IHDR size, without decoding; null when it isn't a PNG. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}
