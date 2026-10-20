import { AVATAR_MAX_BYTES, AVATAR_SIZE } from '../shared/profile';
import { modal } from './dialogs';
import { h } from './dom';

const STAGE = 280;
const MAX_ZOOM = 5;

/** The part of the picture to keep, in image pixels (always a square). */
export interface CropRect { x: number; y: number; size: number }

/** Scale a picture down to a small square avatar (first frame only, so GIFs become static). */
export async function makeAvatar(file: Blob, crop?: CropRect): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const r = crop ?? { x: (bmp.width - s) / 2, y: (bmp.height - s) / 2, size: s };
  const c = document.createElement('canvas');
  c.width = c.height = AVATAR_SIZE;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, r.x, r.y, r.size, r.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bmp.close();
  const encode = (type: string, q: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));
  for (const q of [0.85, 0.7, 0.5]) {
    let b = await encode('image/webp', q);
    if (!b || b.type !== 'image/webp') b = await encode('image/jpeg', q); // older Safari can't encode WebP
    if (b && b.size <= AVATAR_MAX_BYTES) return b;
  }
  throw new Error('Couldn’t shrink that picture enough. Try a different one.');
}

/**
 * Let the person choose which part of a picture shows in the circle: drag to move, and zoom
 * with the slider, the mouse wheel or a pinch. Resolves with the crop, or null if cancelled.
 */
export async function cropAvatar(file: Blob): Promise<CropRect | null> {
  const bmp = await createImageBitmap(file);
  const { width: w, height: hgt } = bmp;
  const base = STAGE / Math.min(w, hgt); // zoom 1 = the picture just covers the circle's square
  let zoom = 1, ox = 0, oy = 0; // offset of the picture's centre from the stage centre, in stage px

  const dpr = Math.min(devicePixelRatio || 1, 3);
  const canvas = h('canvas.crop-stage', { width: STAGE * dpr, height: STAGE * dpr, 'aria-label': 'Drag to move your picture' });
  const ctx = canvas.getContext('2d')!;
  const slider = h('input', { type: 'range', min: '1', max: String(MAX_ZOOM), step: '0.01', value: '1', id: 'crop-zoom', 'aria-label': 'Zoom' });

  const clamp = () => {
    const scale = base * zoom;
    const mx = Math.max(0, (w * scale - STAGE) / 2), my = Math.max(0, (hgt * scale - STAGE) / 2);
    ox = Math.min(mx, Math.max(-mx, ox));
    oy = Math.min(my, Math.max(-my, oy));
  };
  const draw = () => {
    clamp();
    const scale = base * zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, STAGE, STAGE);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, STAGE / 2 + ox - (w * scale) / 2, STAGE / 2 + oy - (hgt * scale) / 2, w * scale, hgt * scale);
    // Dim everything outside the circle that other people will see.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, STAGE, STAGE);
    ctx.arc(STAGE / 2, STAGE / 2, STAGE / 2 - 1, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(STAGE / 2, STAGE / 2, STAGE / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  };
  /** Zoom while keeping the stage point (px, py) still. */
  const zoomTo = (z: number, px = STAGE / 2, py = STAGE / 2) => {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    const k = nz / zoom;
    ox = (ox - (px - STAGE / 2)) * k + (px - STAGE / 2);
    oy = (oy - (py - STAGE / 2)) * k + (py - STAGE / 2);
    zoom = nz;
    slider.value = String(zoom);
    draw();
  };

  // Drag with one pointer, pinch with two.
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; zoom: number } | null = null;
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * STAGE, y: ((e.clientY - r.top) / r.height) * STAGE };
  };
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) pinch = { dist: spread(), zoom };
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      zoomTo(pinch.zoom * (spread() / pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (pts.size === 1) {
      ox += p.x - prev.x; oy += p.y - prev.y;
      draw();
    }
  });
  const lift = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e as unknown as PointerEvent);
    zoomTo(zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  slider.addEventListener('input', () => zoomTo(Number(slider.value)));

  return new Promise((resolve) => {
    let result: CropRect | null = null;
    const body = h('div.modal-body.crop-body', {},
      canvas,
      h('label.crop-zoom', {}, h('span', {}, '−'), slider, h('span', {}, '+')),
      h('small.muted', {}, 'Drag to move. Pinch, scroll or use the slider to zoom.'),
    );
    const cancel = h('button.btn', { type: 'button' }, 'Cancel');
    const use = h('button.btn.primary', { type: 'button' }, 'Use picture');
    const close = modal('Crop your picture', body, [cancel, use], () => { bmp.close(); resolve(result); });
    cancel.addEventListener('click', () => close());
    use.addEventListener('click', () => {
      clamp();
      const scale = base * zoom;
      const size = STAGE / scale;
      const x = (w * scale / 2 - STAGE / 2 - ox) / scale;
      const y = (hgt * scale / 2 - STAGE / 2 - oy) / scale;
      result = { x: Math.max(0, x), y: Math.max(0, y), size: Math.min(size, w, hgt) };
      close();
    });
    draw();
  });
}
