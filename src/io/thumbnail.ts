import type { DrawDoc } from '../core/document';
import { ctx2d, makeCanvas } from '../core/geom';
import { TILE } from '../core/tiles';
import { composite } from '../engine/compositor';
import { api } from '../net/api';
import { exportRect } from './export';
import { encodeImage } from '../engine/offload';

const MAX = 480;

export async function makeThumbnail(doc: DrawDoc): Promise<Blob | null> {
  const s = doc.settings;
  const r = s.infinite ? exportRect(doc) : { x: 0, y: 0, w: s.width, h: s.height };
  if (!r || r.w < 1 || r.h < 1) return null;
  // Composite straight at thumbnail size: a full-size render of a big canvas is the slow part.
  // Tiles land on whole pixels (an integer size each) so no seams show between them.
  const tp = Math.max(1, Math.floor(TILE * Math.min(1, MAX / Math.max(r.w, r.h)))), k = tp / TILE;
  const ox = Math.round(r.x * k), oy = Math.round(r.y * k);
  const out = makeCanvas(Math.max(1, Math.ceil((r.x + r.w) * k) - ox), Math.max(1, Math.ceil((r.y + r.h) * k) - oy));
  const ctx = ctx2d(out);
  ctx.fillStyle = s.background ?? '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(k, 0, 0, k, -ox, -oy);
  composite(ctx, doc, r, { paper: false });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = () => ctx.getImageData(0, 0, out.width, out.height);
  for (const q of [0.8, 0.6, 0.4]) {
    const b = await encodeImage(img(), 'image/webp', q);
    const blob = b && b.type === 'image/webp' ? b : await encodeImage(img(), 'image/jpeg', q);
    if (blob && blob.size < 90 * 1024) return blob;
  }
  return null;
}

export async function saveThumbnail(doc: DrawDoc, roomId: string) {
  const blob = await makeThumbnail(doc);
  if (blob) await api.uploadThumb(roomId, blob);
}
