import { hexToRgb } from '../engine/brush';
import { drawSV, hsvToHex, rgbToHsv } from './colorPicker';
import { h } from './dom';

/** A small saturation/value square, hue bar and hex input for one colour, with no editor behind it. */
export class HsvField {
  readonly el: HTMLElement;
  readonly hex: HTMLInputElement;
  private hue = 0; private sat = 0; private val = 0;
  private sv = h('canvas.cp-sv', { width: 200, height: 120 });
  private svThumb = h('div.cp-thumb');
  private hueThumb = h('div.cp-thumb.cp-hue-thumb');

  constructor(color: string, private onChange: (hex: string) => void, hexId = 'fav-hex') {
    const svWrap = h('div.cp-svwrap', {}, this.sv, this.svThumb);
    const hueBar = h('div.cp-hue', {}, this.hueThumb);
    this.hex = h('input.cp-hex', { type: 'text', id: hexId, maxlength: 7, spellcheck: 'false', 'aria-label': 'Hex colour' });
    this.el = h('div.hsv-field', {}, svWrap, hueBar, this.hex);
    this.drag(svWrap, (x, y) => { this.sat = x; this.val = 1 - y; this.push(); });
    this.drag(hueBar, (x) => { this.hue = x * 359.9; drawSV(this.sv, this.hue); this.push(); });
    this.hex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(this.hex.value.trim())) { this.set(this.hex.value.trim().toLowerCase(), false); this.onChange(this.color); } });
    this.set(color);
  }

  get color() { return hsvToHex(this.hue, this.sat, this.val); }

  set(hex: string, fillInput = true) {
    const [hh, s, v] = rgbToHsv(...hexToRgb(hex));
    if (s > 0 && v > 0) this.hue = hh;
    this.sat = s; this.val = v;
    drawSV(this.sv, this.hue);
    this.render(fillInput);
  }

  private push() { this.render(true); this.onChange(this.color); }

  private render(fillInput: boolean) {
    this.svThumb.style.left = this.sat * 100 + '%';
    this.svThumb.style.top = (1 - this.val) * 100 + '%';
    this.svThumb.style.background = this.color;
    this.hueThumb.style.left = (this.hue / 360) * 100 + '%';
    this.hueThumb.style.background = hsvToHex(this.hue, 1, 1);
    if (fillInput) this.hex.value = this.color;
  }

  private drag(el: HTMLElement, fn: (x: number, y: number) => void) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const go = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))); };
      const up = () => { el.removeEventListener('pointermove', go); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', go);
      el.addEventListener('pointerup', up);
      go(e);
    });
  }
}
