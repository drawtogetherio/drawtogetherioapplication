import type { DrawDoc } from '../core/document';
import { ctx2d, makeCanvas } from '../core/geom';
import { renderRegion } from '../engine/compositor';
import { api } from '../net/api';
import { exportRect } from './export';

const MAX = 480;

/** A small WebP preview of the canvas for the home screen (whole page, or the drawn area when unlimited). */
export async function makeThumbnail(doc: DrawDoc): Promise<Blob | null> {
  const s = doc.settings;
  const r = s.infinite ? exportRect(doc) : { x: 0, y: 0, w: s.width, h: s.height };
  if (!r || r.w < 1 || r.h < 1) return null;
  const full = renderRegion(doc, r, { paper: false });
  const k = Math.min(1, MAX / Math.max(r.w, r.h));
  const out = makeCanvas(Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k)));
  const ctx = ctx2d(out);
  ctx.fillStyle = s.background ?? '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, out.width, out.height);
  for (const q of [0.8, 0.6, 0.4]) {
    const b = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/webp', q));
    const blob = b && b.type === 'image/webp' ? b : await new Promise<Blob | null>((res) => out.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size < 90 * 1024) return blob;
  }
  return null;
}

export async function saveThumbnail(doc: DrawDoc, roomId: string) {
  const blob = await makeThumbnail(doc);
  if (blob) await api.uploadThumb(roomId, blob);
}
