import { clamp } from '../core/geom';
import { h } from './dom';

export interface SliderOptions {
  min: number; max: number; value: number;
  vertical?: boolean;
  label?: string;
  curve?: number;
  format?: (v: number) => string;
  step?: number;
  onInput: (v: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

export class Slider {
  readonly el: HTMLElement;
  private fill: HTMLElement;
  private thumbLabel: HTMLElement;
  private value: number;

  constructor(private o: SliderOptions) {
    this.value = o.value;
    this.fill = h('div.slider-fill');
    this.thumbLabel = h('div.slider-value');
    this.el = h(`div.slider${o.vertical ? '.vertical' : ''}` as 'div', { role: 'slider', 'aria-label': o.label ?? '', tabindex: 0 },
      h('div.slider-track', {}, this.fill), o.label ? h('div.slider-label', {}, o.label) : null, this.thumbLabel);
    this.el.addEventListener('pointerdown', (e) => this.drag(e));
    this.el.addEventListener('keydown', (e) => {
      const step = (o.step ?? (o.max - o.min) / 100) * (e.shiftKey ? 10 : 1);
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this.set(this.value + step, true);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this.set(this.value - step, true);
      else return;
      e.preventDefault();
    });
    this.render();
  }

  private toT(v: number) { return Math.pow((v - this.o.min) / (this.o.max - this.o.min), 1 / (this.o.curve ?? 1)); }
  private fromT(t: number) { return this.o.min + Math.pow(t, this.o.curve ?? 1) * (this.o.max - this.o.min); }

  private drag(e: PointerEvent) {
    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('active');
    this.o.onStart?.();
    const update = (ev: PointerEvent) => {
      const r = this.el.getBoundingClientRect();
      const t = this.o.vertical ? 1 - (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
      this.set(this.fromT(clamp(t, 0, 1)), true);
    };
    update(e);
    const move = (ev: PointerEvent) => update(ev);
    const up = () => {
      this.el.classList.remove('active');
      this.o.onEnd?.();
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  set(v: number, notify = false) {
    v = clamp(v, this.o.min, this.o.max);
    if (this.o.step) v = Math.round(v / this.o.step) * this.o.step;
    this.value = v;
    this.render();
    if (notify) this.o.onInput(v);
  }

  get() { return this.value; }

  private render() {
    const t = this.toT(this.value) * 100;
    if (this.o.vertical) this.fill.style.height = t + '%';
    else this.fill.style.width = t + '%';
    this.thumbLabel.textContent = this.o.format ? this.o.format(this.value) : String(Math.round(this.value));
    this.el.setAttribute('aria-valuenow', String(this.value));
  }
}
