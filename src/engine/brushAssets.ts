// Brush images on this device: decoded once into alpha masks (white, alpha = how much paint), kept
// in memory, saved in IndexedDB, and fetched from or uploaded to the server by id.
import { ctx2d, makeCanvas } from '../core/geom';
import { MAX_ASSET_BYTES, MAX_ASSET_SIZE, isAssetId, pngSize } from '../shared/brushAssets';
import { getAssetBytes, putAssetBytes } from '../io/localStore';

const images = new Map<string, HTMLCanvasElement>();
const bytesOf = new Map<string, Uint8Array>();
const missing = new Set<string>();
const loading = new Map<string, Promise<boolean>>();
/** Ids the server has confirmed, or is being sent. */
const onServer = new Set<string>();
let server = false;

/** Whether assets can be fetched from and sent to a server. */
export function assetServer(on: boolean) { server = on; onServer.clear(); }

/** The decoded tip or texture, or null when it isn't here (the stroke falls back to a round tip). */
export const assetImage = (id: string) => images.get(id) ?? null;
export const haveAssets = (ids: string[]) => ids.every((id) => images.has(id));

async function sha(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Luminance over black becomes alpha, so any picture works as a tip or texture. */
async function decode(bytes: Uint8Array): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  const c = makeCanvas(bmp.width, bmp.height), ctx = ctx2d(c, true);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i + 3] = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114); d[i] = d[i + 1] = d[i + 2] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function keep(id: string, bytes: Uint8Array) {
  images.set(id, await decode(bytes));
  bytesOf.set(id, bytes);
  missing.delete(id);
}

/**
 * Makes an asset from any image: scaled to fit 256 px, drawn as white on black, saved as a PNG.
 * Returns its id, or null when the picture can't be read.
 */
export async function importAssetImage(src: Blob | ImageBitmap | HTMLCanvasElement): Promise<string | null> {
  try {
    const bmp = src instanceof Blob ? await createImageBitmap(src) : src;
    const k = Math.min(1, MAX_ASSET_SIZE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = makeCanvas(w, h), ctx = ctx2d(c, true);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const l = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114); d[i] = d[i + 1] = d[i + 2] = l; d[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    if (!blob || blob.size > MAX_ASSET_BYTES) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return addAssetBytes(bytes);
  } catch { return null; }
}

/** Keeps a normalised PNG as an asset; the id comes from its bytes. */
export async function addAssetBytes(bytes: Uint8Array): Promise<string | null> {
  const size = pngSize(bytes);
  if (!size || size.w > MAX_ASSET_SIZE || size.h > MAX_ASSET_SIZE || bytes.length > MAX_ASSET_BYTES) return null;
  const id = await sha(bytes);
  if (!images.has(id)) { await keep(id, bytes); await putAssetBytes(id, bytes).catch(() => {}); }
  return id;
}

/** Brings every asset here, from this device or the server; false when any is unavailable. */
export async function ensureAssets(ids: string[]): Promise<boolean> {
  const results = await Promise.all(ids.map((id) => {
    if (images.has(id)) return true;
    if (!isAssetId(id) || missing.has(id)) return false;
    let p = loading.get(id);
    if (!p) {
      p = fetchAsset(id).finally(() => loading.delete(id));
      loading.set(id, p);
    }
    return p;
  }));
  return results.every(Boolean);
}

async function fetchAsset(id: string): Promise<boolean> {
  const local = await getAssetBytes(id).catch(() => null);
  if (local) { await keep(id, local); return true; }
  if (server) {
    try {
      const res = await fetch(`/api/brush-assets/${id}`, { credentials: 'same-origin' });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (await sha(bytes) === id) { await keep(id, bytes); onServer.add(id); await putAssetBytes(id, bytes).catch(() => {}); return true; }
      }
    } catch { /* offline: try again next time */ }
  }
  missing.add(id);
  return false;
}

/** Sends assets the server doesn't have yet, before strokes that use them. */
export async function uploadAssets(ids: string[]) {
  if (!server) return;
  await Promise.all(ids.filter((id) => !onServer.has(id) && bytesOf.has(id)).map(async (id) => {
    onServer.add(id);
    try {
      const res = await fetch(`/api/brush-assets/${id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/png' }, body: bytesOf.get(id)! as BufferSource });
      if (!res.ok) onServer.delete(id);
    } catch { onServer.delete(id); }
  }));
}
