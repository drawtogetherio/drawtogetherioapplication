import { clamp } from '../core/geom';
import { hexToRgb } from '../engine/brush';
import type { Editor } from '../editor';
import { h } from './dom';

/** Wheel geometry as fractions of the wrap: the ring's inner radius and the side of the square inside it (matches .wheel .cp-sv). */
const INNER = 0.78, SQUARE = 0.53;

const PALETTE = [
  '#000000', '#3c3c43', '#7c7c85', '#bdbdc4', '#ffffff', '#f2e8dc',
  '#e53935', '#f4511e', '#fb8c00', '#fdd835', '#c0ca33', '#43a047',
  '#00897b', '#00acc1', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60',
  '#6d4c41', '#a1887f', '#ffccbc', '#f8bbd0', '#b3e5fc', '#c8e6c9',
];

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60; if (hue < 0) hue += 360;
  }
  return [hue, max ? d / max : 0, max];
}

export function hsvToHex(hh: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + hh / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class ColorPicker {
  readonly el: HTMLElement;
  /** The picker and the swatches, so the studio layout can give each its own panel. */
  readonly pickerEl: HTMLElement;
  readonly swatchesEl: HTMLElement;
  private hue = 0; private sat = 0; private val = 0;
  private sv: HTMLCanvasElement;
  private svWrap: HTMLElement;
  private ring: HTMLCanvasElement;
  private wheel = false;
  private hueBar: HTMLElement;
  private svThumb: HTMLElement;
  private hueThumb: HTMLElement;
  private hex: HTMLInputElement;
  private current: HTMLElement;
  private previous: HTMLElement;
  private recent: HTMLElement;
  private internal = false;

  constructor(private ed: Editor) {
    this.sv = h('canvas.cp-sv', { width: 240, height: 180 });
    this.svThumb = h('div.cp-thumb');
    this.hueThumb = h('div.cp-thumb.cp-hue-thumb');
    this.hueBar = h('div.cp-hue', {}, this.hueThumb);
    this.hex = h('input.cp-hex', { type: 'text', maxlength: 7, spellcheck: 'false', 'aria-label': 'Hex colour' });
    this.current = h('div.cp-swatch-big');
    this.previous = h('div.cp-swatch-big', { title: 'Previous colour' });
    this.recent = h('div.cp-swatches');
    const palette = h('div.cp-swatches');
    for (const c of PALETTE) palette.append(this.swatch(c));

    this.ring = h('canvas.cp-ring', { width: 320, height: 320 });
    this.svWrap = h('div.cp-svwrap', {}, this.ring, this.sv, this.svThumb);
    this.pickerEl = h('div.cp-main', {}, this.svWrap, this.hueBar, h('div.cp-row', {}, h('div.cp-compare', {}, this.previous, this.current), this.hex));
    this.swatchesEl = h('div.cp-swatches-wrap', {}, h('div.cp-section', {}, 'Palette'), palette, h('div.cp-section', {}, 'Recent'), this.recent);
    this.el = h('div.color-picker', {}, this.pickerEl, this.swatchesEl);

    this.previous.addEventListener('click', () => this.ed.setColor(this.previous.dataset.c!, true));
    this.dragArea(this.svWrap, (x, y) => { this.sat = x; this.val = 1 - y; this.push(); }, (x, y) => this.wheel && Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)) > SQUARE / 2);
    this.dragArea(this.hueBar, (x) => { this.hue = x * 359.9; this.push(); this.drawSV(); });
    this.hex.addEventListener('change', () => {
      const v = this.hex.value.trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(v) || /^#?[0-9a-fA-F]{3}$/.test(v)) {
        const full = '#' + v.replace('#', '');
        const [r, g, b] = hexToRgb(full);
        this.ed.setColor('#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join(''), true);
      } else this.sync();
    });
    ed.on((w) => { if (w === 'color' && !this.internal) this.sync(); });
    this.sync();
  }

  opened() {
    this.previous.dataset.c = this.ed.color;
    this.previous.style.background = this.ed.color;
    this.renderRecent();
  }

  /** A hue ring around the square instead of the bar below it. */
  setWheel(on: boolean) {
    this.wheel = on;
    this.svWrap.classList.toggle('wheel', on);
    this.hueBar.hidden = on;
    (on ? this.svWrap : this.hueBar).append(this.hueThumb);
    if (on && !this.ring.dataset.drawn) this.drawRing();
    this.renderThumbs();
  }

  private drawRing() {
    const c = this.ring.getContext('2d')!, S = this.ring.width, R = S / 2, r = R * INNER;
    c.lineWidth = R - r;
    for (let a = 0; a < 360; a++) {
      c.beginPath();
      c.strokeStyle = `hsl(${a} 100% 50%)`;
      c.arc(R, R, (R + r) / 2, ((a - 0.6) * Math.PI) / 180, ((a + 0.6) * Math.PI) / 180);
      c.stroke();
    }
    this.ring.dataset.drawn = '1';
  }

  private swatch(c: string) {
    return h('button.cp-swatch', { style: `background:${c}`, title: c, 'aria-label': c, onclick: () => this.ed.setColor(c, true) });
  }

  private renderRecent() {
    this.recent.replaceChildren(...this.ed.recentColors.map((c) => this.swatch(c)));
  }

  /** `onRing` decides at pointer-down whether the drag turns the hue ring instead. */
  private dragArea(el: HTMLElement, fn: (x: number, y: number) => void, onRing?: (x: number, y: number) => boolean) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const at = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]; };
      const [x0, y0] = at(e);
      const ring = !!onRing?.(x0, y0);
      const go = (ev: PointerEvent) => {
        const [x, y] = at(ev);
        if (ring) { this.hue = ((Math.atan2(y - 0.5, x - 0.5) * 180) / Math.PI + 360) % 360; this.push(); this.drawSV(); return; }
        const lo = this.wheel ? (1 - SQUARE) / 2 : 0, span = this.wheel ? SQUARE : 1;
        fn(clamp((x - lo) / span, 0, 1), clamp((y - lo) / span, 0, 1));
      };
      go(e);
      const up = () => {
        el.removeEventListener('pointermove', go);
        el.removeEventListener('pointerup', up);
        this.ed.pushRecent(this.ed.color);
        this.renderRecent();
      };
      el.addEventListener('pointermove', go);
      el.addEventListener('pointerup', up);
    });
  }

  private push() {
    this.internal = true;
    this.ed.setColor(hsvToHex(this.hue, this.sat, this.val));
    this.internal = false;
    this.renderThumbs();
  }

  private sync() {
    const [r, g, b] = hexToRgb(this.ed.color);
    const [hh, s, v] = rgbToHsv(r, g, b);
    if (s > 0 && v > 0) this.hue = hh; // keep hue when picking greys
    this.sat = s; this.val = v;
    this.drawSV();
    this.renderThumbs();
    this.renderRecent();
  }

  private renderThumbs() {
    const lo = this.wheel ? (1 - SQUARE) / 2 : 0, span = this.wheel ? SQUARE : 1;
    this.svThumb.style.left = (lo + this.sat * span) * 100 + '%';
    this.svThumb.style.top = (lo + (1 - this.val) * span) * 100 + '%';
    this.svThumb.style.background = this.ed.color;
    if (this.wheel) {
      const a = (this.hue * Math.PI) / 180, m = (1 + INNER) / 4;
      this.hueThumb.style.left = (0.5 + Math.cos(a) * m) * 100 + '%';
      this.hueThumb.style.top = (0.5 + Math.sin(a) * m) * 100 + '%';
    } else { this.hueThumb.style.left = (this.hue / 360) * 100 + '%'; this.hueThumb.style.top = ''; }
    this.hueThumb.style.background = hsvToHex(this.hue, 1, 1);
    this.current.style.background = this.ed.color;
    if (document.activeElement !== this.hex) this.hex.value = this.ed.color;
  }

  private drawSV() {
    const c = this.sv.getContext('2d')!;
    const { width: w, height: hh } = this.sv;
    c.fillStyle = hsvToHex(this.hue, 1, 1);
    c.fillRect(0, 0, w, hh);
    const white = c.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, '#fff'); white.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = white; c.fillRect(0, 0, w, hh);
    const black = c.createLinearGradient(0, 0, 0, hh);
    black.addColorStop(0, 'rgba(0,0,0,0)'); black.addColorStop(1, '#000');
    c.fillStyle = black; c.fillRect(0, 0, w, hh);
  }
}
