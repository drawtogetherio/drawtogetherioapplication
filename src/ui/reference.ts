import type { Editor } from '../editor';
import { ctx2d } from '../core/geom';
import { h } from './dom';
import { icon } from './icons';
import { floating } from './float';
import type { Minimap } from './minimap';
import { StoredRef, getRef, putRef } from '../io/localStore';

/**
 * The overview window: the canvas minimap or a reference image, kept per canvas on this device.
 * The image zooms by wheel, pinch or buttons, rotates by twist or a quarter turn, pans by drag; the eyedropper (or Alt) picks from it.
 */
export class ReferencePanel {
  private canvas = h('canvas.ref-canvas');
  private tools: HTMLElement;
  private tabs: HTMLElement;
  mode: 'canvas' | 'image' = 'canvas';
  /** The canvas whose reference this is (room or device copy id). */
  private key: string | null = null;
  private saveTimer = 0;
  private img: HTMLImageElement | null = null;
  private scale = 1;
  private angle = 0;
  /** Where the image's centre sits on the canvas. */
  private cx = 0;
  private cy = 0;
  private fingers = new Map<number, { x: number; y: number }>();
  readonly el: HTMLElement;

  constructor(private ed: Editor, private minimap: Minimap) {
    const tab = (m: 'canvas' | 'image', label: string) => h('button.ref-tab', { type: 'button', role: 'tab', onclick: () => this.show(m) }, label);
    this.tabs = h('div.segmented.small', { role: 'tablist' }, tab('canvas', 'Canvas'), tab('image', 'Image'));
    this.tools = h('span.ref-tools', {},
      h('button.icon-btn', { type: 'button', title: 'Open image', 'aria-label': 'Open image', html: icon('file', 16), onclick: () => this.open() }),
      h('button.icon-btn', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', html: icon('minus', 16), onclick: () => this.zoomBy(1 / 1.25) }),
      h('button.icon-btn', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', html: icon('plus', 16), onclick: () => this.zoomBy(1.25) }),
      h('button.icon-btn', { type: 'button', title: 'Rotate', 'aria-label': 'Rotate', html: icon('rotate', 16), onclick: () => { this.angle = (this.angle + Math.PI / 2) % (Math.PI * 2); this.draw(); } }),
      h('button.icon-btn', { type: 'button', title: 'Fit', 'aria-label': 'Fit', html: icon('fit', 16), onclick: () => this.fit() }));
    const head = h('div.ref-head', {}, this.tabs, h('span.grow'), this.tools,
      h('button.icon-btn', { type: 'button', title: 'Close', 'aria-label': 'Close', html: icon('x', 16), onclick: () => this.close() }));
    const grip = h('div.sp-resize.ref-resize', { 'aria-hidden': 'true' });
    this.el = h('div.ref-panel', { hidden: true, role: 'dialog', 'aria-label': 'Overview' }, head, minimap.el, this.canvas, grip);
    floating(this.el, head, 'doodlehive.refBox', { grip, min: [260, 150], onMove: () => this.redraw() });
    this.show(this.mode, false);
    // One pointer pans (or picks); two pinch, twist and pan together.
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const pair = () => { const [a, b] = [...this.fingers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x) }; };
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag = this.fingers.size === 1 ? { x: e.clientX, y: e.clientY, moved: false } : null;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.fingers.has(e.pointerId)) return;
      if (this.fingers.size >= 2) {
        const p0 = pair();
        this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const p1 = pair(), r = this.canvas.getBoundingClientRect();
        this.transform(p0.x - r.left, p0.y - r.top, p1.x - r.left, p1.y - r.top, p1.d / p0.d, p1.a - p0.a);
        return;
      }
      if (!drag) return;
      if (ed.toolId === 'eyedropper' || e.altKey) { this.pick(e); return; }
      this.cx += e.clientX - drag.x; this.cy += e.clientY - drag.y;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2) drag.moved = true;
      drag = { ...drag, x: e.clientX, y: e.clientY };
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.draw();
    });
    const lift = (e: PointerEvent) => {
      if (drag && !drag.moved && this.fingers.size === 1 && (ed.toolId === 'eyedropper' || e.altKey)) this.pick(e);
      this.fingers.delete(e.pointerId);
      drag = null;
    };
    this.canvas.addEventListener('pointerup', lift);
    this.canvas.addEventListener('pointercancel', lift);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      this.transform(x, y, x, y, Math.exp(-e.deltaY * 0.002), 0);
    }, { passive: false });
    new ResizeObserver(() => this.redraw()).observe(this.el);
    document.addEventListener('paste', (e) => {
      if (this.el.hidden || this.mode !== 'image') return;
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) this.load(f);
    });
  }

  /** Shows the panel on one of its tabs. */
  show(mode: 'canvas' | 'image', open = true) {
    this.mode = mode;
    if (open) this.el.hidden = false;
    for (const t of this.tabs.children) t.classList.toggle('active', t.textContent === (mode === 'canvas' ? 'Canvas' : 'Image'));
    for (const t of this.tabs.children) t.setAttribute('aria-selected', String(t.classList.contains('active')));
    this.minimap.el.hidden = mode !== 'canvas';
    this.canvas.hidden = mode !== 'image';
    this.tools.hidden = mode !== 'image';
    this.redraw();
  }

  /** The X: on the canvas tab it also turns the overview preference off, so it stays away. */
  close() {
    this.el.hidden = true;
    if (this.mode === 'canvas' && this.ed.prefs.minimap) { this.ed.prefs.minimap = false; this.ed.emit('prefs'); }
  }

  /** Follows the overview preference: on shows the canvas tab, off hides it. */
  syncPref() {
    const on = this.ed.prefs.minimap;
    if (on && this.el.hidden && !this.img) this.show('canvas');
    else if (!on && !this.el.hidden && this.mode === 'canvas') this.el.hidden = true;
  }

  /** Switches to another canvas: its own reference image comes back from this device, if it had one. */
  bind(key: string | null) {
    clearTimeout(this.saveTimer);
    this.key = key;
    this.img = null;
    this.redraw();
    if (!key) return;
    void getRef(key).then((r) => { if (r && this.key === key) this.restore(r); }).catch(() => {});
  }

  private restore(r: StoredRef) {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); if (this.img) return; this.img = img; this.scale = r.scale; this.angle = r.angle; this.cx = r.cx; this.cy = r.cy; this.redraw(); };
    img.src = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.type }));
  }

  open() {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) this.load(f); });
    input.click();
    this.show('image');
  }

  load(file: Blob) {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); this.img = img; this.show('image'); this.fit(); void this.save(file); };
    img.src = URL.createObjectURL(file);
  }

  private async save(file: Blob) {
    if (!this.key) return;
    const key = this.key;
    await putRef(key, { type: file.type, bytes: new Uint8Array(await file.arrayBuffer()), scale: this.scale, angle: this.angle, cx: this.cx, cy: this.cy }).catch(() => {});
  }

  /** The framing is kept with the image, a moment after it stops changing. */
  private saveView() {
    clearTimeout(this.saveTimer);
    const key = this.key;
    if (!key || !this.img) return;
    this.saveTimer = window.setTimeout(() => { void getRef(key).then((r) => r && putRef(key, { ...r, scale: this.scale, angle: this.angle, cx: this.cx, cy: this.cy })).catch(() => {}); }, 500);
  }

  private redraw() { if (this.mode === 'canvas') this.minimap.refresh(); else this.draw(); }

  private fit() {
    if (!this.img) return;
    const w = this.canvas.clientWidth, hh = this.canvas.clientHeight, side = Math.abs(Math.sin(this.angle)) > 0.5;
    this.scale = Math.min(w / (side ? this.img.height : this.img.width), hh / (side ? this.img.width : this.img.height));
    this.cx = w / 2; this.cy = hh / 2;
    this.draw();
  }

  private zoomBy(k: number) { this.transform(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, k, 0); }

  /** Scales by k and turns by da about the point that moved from (x0,y0) to (x1,y1), so what was under the fingers stays there. */
  private transform(x0: number, y0: number, x1: number, y1: number, k: number, da: number) {
    const dx = this.cx - x0, dy = this.cy - y0, c = Math.cos(da), s = Math.sin(da);
    this.cx = x1 + (dx * c - dy * s) * k; this.cy = y1 + (dx * s + dy * c) * k;
    this.scale = Math.max(0.02, Math.min(50, this.scale * k)); this.angle += da;
    this.draw();
  }

  private draw() {
    this.saveView();
    const c = this.canvas, dpr = devicePixelRatio || 1;
    if (c.hidden) return;
    c.width = Math.max(1, Math.round(c.clientWidth * dpr)); c.height = Math.max(1, Math.round(c.clientHeight * dpr));
    const ctx = ctx2d(c, true);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    if (!this.img) { ctx.fillStyle = '#999'; ctx.font = '13px sans-serif'; ctx.fillText('Open an image, or paste one', 12, 24); return; }
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(this.cx, this.cy); ctx.rotate(this.angle); ctx.scale(this.scale, this.scale);
    ctx.drawImage(this.img, -this.img.width / 2, -this.img.height / 2);
  }

  private pick(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const d = ctx2d(this.canvas, true).getImageData(Math.round((e.clientX - r.left) * dpr), Math.round((e.clientY - r.top) * dpr), 1, 1).data;
    this.ed.setColor('#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
  }
}
