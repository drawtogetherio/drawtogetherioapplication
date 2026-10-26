import type { Editor } from '../editor';
import { ctx2d } from '../core/geom';
import { h } from './dom';
import { icon } from './icons';

/** A floating reference image over the stage: wheel zooms, drag pans, the eyedropper (or Alt) picks from it. */
export class ReferencePanel {
  private canvas = h('canvas.ref-canvas');
  private img: HTMLImageElement | null = null;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  readonly el: HTMLElement;

  constructor(private ed: Editor) {
    const head = h('div.ref-head', {}, h('span.grow', {}, 'Reference'),
      h('button.icon-btn', { type: 'button', title: 'Open image', 'aria-label': 'Open image', html: icon('file', 16), onclick: () => this.open() }),
      h('button.icon-btn', { type: 'button', title: 'Fit', 'aria-label': 'Fit', html: icon('fit', 16), onclick: () => this.fit() }),
      h('button.icon-btn', { type: 'button', title: 'Close', 'aria-label': 'Close', html: icon('x', 16), onclick: () => this.close() }));
    this.el = h('div.ref-panel', { hidden: true, role: 'dialog', 'aria-label': 'Reference image' }, head, this.canvas);
    let drag: { x: number; y: number; moved: boolean } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (ed.toolId === 'eyedropper' || e.altKey) { this.pick(e); return; }
      this.ox += e.clientX - drag.x; this.oy += e.clientY - drag.y;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2) drag.moved = true;
      drag = { ...drag, x: e.clientX, y: e.clientY };
      this.draw();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved && (ed.toolId === 'eyedropper' || e.altKey)) this.pick(e);
      drag = null;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect(), k = Math.exp(-e.deltaY * 0.002), x = e.clientX - r.left, y = e.clientY - r.top;
      this.ox = x - (x - this.ox) * k; this.oy = y - (y - this.oy) * k; this.scale *= k;
      this.draw();
    }, { passive: false });
    // Drag the panel by its head; the browser's resize handle does the rest.
    let move: { x: number; y: number; l: number; t: number } | null = null;
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      head.setPointerCapture(e.pointerId);
      move = { x: e.clientX, y: e.clientY, l: this.el.offsetLeft, t: this.el.offsetTop };
    });
    head.addEventListener('pointermove', (e) => { if (move) { this.el.style.left = `${move.l + e.clientX - move.x}px`; this.el.style.top = `${move.t + e.clientY - move.y}px`; } });
    head.addEventListener('pointerup', () => { move = null; });
    new ResizeObserver(() => this.draw()).observe(this.el);
    document.addEventListener('paste', (e) => {
      if (this.el.hidden) return;
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) this.load(f);
    });
  }

  open() {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) this.load(f); });
    input.click();
    this.el.hidden = false;
  }

  load(file: File) {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); this.img = img; this.el.hidden = false; this.fit(); };
    img.src = URL.createObjectURL(file);
  }

  close() { this.el.hidden = true; }

  private fit() {
    if (!this.img) return;
    const w = this.canvas.clientWidth, hh = this.canvas.clientHeight;
    this.scale = Math.min(w / this.img.width, hh / this.img.height);
    this.ox = (w - this.img.width * this.scale) / 2; this.oy = (hh - this.img.height * this.scale) / 2;
    this.draw();
  }

  private draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(c.clientWidth * dpr)); c.height = Math.max(1, Math.round(c.clientHeight * dpr));
    const ctx = ctx2d(c, true);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    if (!this.img) { ctx.fillStyle = '#999'; ctx.font = '13px sans-serif'; ctx.fillText('Open an image, or paste one', 12, 24); return; }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.img, this.ox, this.oy, this.img.width * this.scale, this.img.height * this.scale);
  }

  private pick(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const d = ctx2d(this.canvas, true).getImageData(Math.round((e.clientX - r.left) * dpr), Math.round((e.clientY - r.top) * dpr), 1, 1).data;
    this.ed.setColor('#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
  }
}
