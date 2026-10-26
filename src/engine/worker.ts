import { enclosedMask, floodMask } from './fill';
import { applyEffect } from './effects';
import { zipParts } from '../shared/hivecanvas';
import type { Job } from './offload';

// Heavy pixel work off the main thread, so the pen never waits for a fill, an effect or an export.
// Each job is plain data in and plain data out; the main thread turns results into canvases.

const scope = self as unknown as { onmessage: (e: MessageEvent) => void; postMessage(m: unknown, transfer?: Transferable[]): void };

async function encode(img: ImageData, type: string, quality?: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.convertToBlob({ type, quality }).catch(() => null);
}

async function run(job: Job): Promise<[unknown, Transferable[]]> {
  switch (job.kind) {
    case 'fill': { const m = floodMask(job.img, job.region, job.x, job.y, job.tolerance, job.expand); return [m, m ? [m.buffer] : []]; }
    case 'enclosed': { const m = enclosedMask(job.img, job.lasso, job.tolerance, job.expand); return [m, m ? [m.buffer] : []]; }
    case 'effect': applyEffect(job.img, job.op, job.ox, job.oy); return [job.img, [job.img.data.buffer]];
    case 'encode': return [await encode(job.img, job.type, job.quality), []];
    case 'encodeMany': {
      const out: (Blob | null)[] = [];
      for (const img of job.imgs) out.push(await encode(img, job.type));
      return [out, []];
    }
    case 'zip': {
      const parts = zipParts(job.entries);
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return [out, [out.buffer]];
    }
  }
}

scope.onmessage = async (e: MessageEvent<{ id: number; job: Job }>) => {
  const { id, job } = e.data;
  try {
    const [result, transfer] = await run(job);
    scope.postMessage({ id, result }, transfer);
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
