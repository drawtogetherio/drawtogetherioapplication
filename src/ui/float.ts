// Small windows over the stage (chat, minimap, reference) that drag by a handle and remember their place on this device.
import { track } from './panels';

export interface Box { x: number; y: number; w?: number; h?: number }

const read = (key: string): Box | null => {
  try { const b = JSON.parse(localStorage.getItem(key) ?? 'null'); return b && Number.isFinite(b.x) && Number.isFinite(b.y) ? b : null; } catch { return null; }
};
const write = (key: string, b: Box | null) => { try { if (b) localStorage.setItem(key, JSON.stringify(b)); else localStorage.removeItem(key); } catch { /* storage blocked */ } };

/**
 * Lets `el` be dragged by `handle` within its offsetParent and, with `grip`, resized from its corner.
 * `onMove` hears every change; `reset()` puts it back where CSS has it.
 */
export function floating(el: HTMLElement, handle: HTMLElement, key: string, opts: { grip?: HTMLElement; min?: [number, number]; onMove?: (moved: boolean) => void } = {}) {
  let box = read(key);
  const place = (b: Box | null) => {
    const parent = el.offsetParent?.getBoundingClientRect();
    if (b && parent) {
      if (b.w && b.h) { el.style.width = b.w + 'px'; el.style.height = b.h + 'px'; }
      b.x = Math.round(Math.max(0, Math.min(parent.width - Math.min(el.offsetWidth, 120), b.x)));
      b.y = Math.round(Math.max(0, Math.min(parent.height - 40, b.y)));
      el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; el.style.right = el.style.bottom = 'auto';
    } else el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.width = el.style.height = '';
    box = b;
    write(key, b);
    opts.onMove?.(!!b);
  };
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const parent = el.offsetParent?.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!parent) return;
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    track(e, (ev) => place({ ...box, x: ev.clientX - parent.left - ox, y: ev.clientY - parent.top - oy }), () => {});
  });
  opts.grip?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const parent = el.offsetParent?.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!parent) return;
    const [mw, mh] = opts.min ?? [120, 80];
    track(e, (ev) => place({ x: r.left - parent.left, y: r.top - parent.top, w: Math.max(mw, Math.round(r.width + ev.clientX - e.clientX)), h: Math.max(mh, Math.round(r.height + ev.clientY - e.clientY)) }), () => {});
  });
  window.addEventListener('resize', () => { if (box) place(box); });
  if (box) place(box);
  return { reset: () => place(null), get moved() { return !!box; } };
}
