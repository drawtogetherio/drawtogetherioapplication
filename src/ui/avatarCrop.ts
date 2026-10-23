import { AVATAR_MAX_BYTES, AVATAR_SIZE, BANNER_H, BANNER_MAX_BYTES, BANNER_W } from '../shared/profile';
import { modal } from './dialogs';
import { h } from './dom';

const STAGE = 300;
const MAX_ZOOM = 5;

/** A crop in source pixels, plus the source size. */
export interface CropRect { x: number; y: number; w: number; h: number; srcW: number; srcH: number }

/** Draws the crop (or the centred one) at outW × outH and encodes it under `maxBytes`. */
export async function renderCrop(file: Blob, crop: CropRect | undefined, outW: number, outH: number, maxBytes: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  let r = crop;
  if (!r) {
    const k = Math.min(bmp.width / outW, bmp.height / outH), w = outW * k, hgt = outH * k;
    r = { x: (bmp.width - w) / 2, y: (bmp.height - hgt) / 2, w, h: hgt, srcW: bmp.width, srcH: bmp.height };
  }
  const c = document.createElement('canvas');
  c.width = outW; c.height = outH;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, outW, outH);
  bmp.close();
  const encode = (type: string, q: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));
  for (const q of [0.85, 0.7, 0.5]) {
    let b = await encode('image/webp', q);
    if (!b || b.type !== 'image/webp') b = await encode('image/jpeg', q); // older Safari can't encode WebP
    if (b && b.size <= maxBytes) return b;
  }
  throw new Error('Couldn’t shrink that picture enough. Try a different one.');
}

/** First frame only, so GIFs become stills. */
export const makeAvatar = (file: Blob, crop?: CropRect) => renderCrop(file, crop, AVATAR_SIZE, AVATAR_SIZE, AVATAR_MAX_BYTES);
export const makeBanner = (file: Blob, crop?: CropRect) => renderCrop(file, crop, BANNER_W, BANNER_H, BANNER_MAX_BYTES);

/** Drag to move, zoom with the slider, wheel or pinch; a round window for 1:1. Resolves with the crop, or null. */
export async function cropImage(file: Blob, aspect = 1, title = 'Crop your picture'): Promise<CropRect | null> {
  const bmp = await createImageBitmap(file);
  const { width: w, height: hgt } = bmp;
  const SW = aspect >= 1 ? STAGE : Math.round(STAGE * aspect), SH = aspect >= 1 ? Math.round(STAGE / aspect) : STAGE;
  const base = Math.max(SW / w, SH / hgt); // zoom 1 = the picture just covers the window
  let zoom = 1, ox = 0, oy = 0; // offset of the picture's centre from the stage centre, in stage px

  const dpr = Math.min(devicePixelRatio || 1, 3);
  const canvas = h('canvas.crop-stage', { width: SW * dpr, height: SH * dpr, style: `width:${SW}px;height:${SH}px`, 'aria-label': 'Drag to move your picture' });
  const ctx = canvas.getContext('2d')!;
  const slider = h('input', { type: 'range', min: '1', max: String(MAX_ZOOM), step: '0.01', value: '1', id: 'crop-zoom', 'aria-label': 'Zoom' });

  const clamp = () => {
    const scale = base * zoom;
    const mx = Math.max(0, (w * scale - SW) / 2), my = Math.max(0, (hgt * scale - SH) / 2);
    ox = Math.min(mx, Math.max(-mx, ox));
    oy = Math.min(my, Math.max(-my, oy));
  };
  const draw = () => {
    clamp();
    const scale = base * zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SW, SH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, SW / 2 + ox - (w * scale) / 2, SH / 2 + oy - (hgt * scale) / 2, w * scale, hgt * scale);
    if (aspect !== 1) return;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, SW, SH);
    ctx.arc(SW / 2, SH / 2, SW / 2 - 1, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(SW / 2, SH / 2, SW / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  };
  const zoomTo = (z: number, px = SW / 2, py = SH / 2) => {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    const k = nz / zoom;
    ox = (ox - (px - SW / 2)) * k + (px - SW / 2);
    oy = (oy - (py - SH / 2)) * k + (py - SH / 2);
    zoom = nz;
    slider.value = String(zoom);
    draw();
  };

  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; zoom: number } | null = null;
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SW, y: ((e.clientY - r.top) / r.height) * SH };
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
    const close = modal(title, body, [cancel, use], () => { bmp.close(); resolve(result); });
    cancel.addEventListener('click', () => close());
    use.addEventListener('click', () => {
      clamp();
      const scale = base * zoom;
      const x = (w * scale / 2 - SW / 2 - ox) / scale, y = (hgt * scale / 2 - SH / 2 - oy) / scale;
      result = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(SW / scale, w), h: Math.min(SH / scale, hgt), srcW: w, srcH: hgt };
      close();
    });
    draw();
  });
}
