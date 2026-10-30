import { TILE } from '../core/tiles';
import type { Editor } from '../editor';
import { h } from './dom';

const TILE_BYTES = TILE * TILE * 4, GB = 1024 ** 3;
const IOS = /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Canvas memory a page can hold before the browser starts dropping it; iPad Safari is the tightest. */
const BUDGET = ((navigator as { deviceMemory?: number }).deviceMemory ?? 0) * 0.3 * GB || (IOS ? 1 : 2) * GB;
const HISTORY_COST = [700, 300, 100];
const WARN = [
  '',
  'Canvas memory is getting high. Undo history is kept shorter for now.',
  'Canvas memory is near this device’s limit. Merge or delete layers, or the page may crash.',
];

export interface MemoryReading { used: number; budget: number; layers: number; tiles: number; history: number; level: 0 | 1 | 2 }

export const fmtBytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
export const describe = (r: MemoryReading) => `${fmtBytes(r.used)} of about ${fmtBytes(r.budget)} · ${r.layers} layer${r.layers === 1 ? '' : 's'} · undo ${fmtBytes(r.history)}`;

export function measureMemory(ed: Editor, budget = BUDGET): MemoryReading {
  let tiles = 0;
  for (const l of ed.doc.layers) tiles += l.surface.size + (l.mask?.size ?? 0);
  const history = ed.doc.history.cost * TILE_BYTES, used = tiles * TILE_BYTES + history, f = used / budget;
  return { used, budget, layers: ed.doc.layers.length, tiles, history, level: f > 0.9 ? 2 : f > 0.7 ? 1 : 0 };
}

/** Watches canvas memory: shows it, shortens undo history as it climbs and warns before the browser gives up. */
export class MemoryMeter {
  readonly el = h('span.mem-meter', { role: 'meter', 'aria-label': 'Canvas memory' }, h('span.mem-text'), h('span.mem-bar', {}, h('span.mem-fill')));
  reading: MemoryReading;
  budget = BUDGET;
  private level: 0 | 1 | 2 = 0;
  private timer = 0;
  private listeners = new Set<(r: MemoryReading) => void>();

  constructor(private ed: Editor, private warn: (msg: string) => void) {
    this.reading = measureMemory(ed);
    ed.on((w) => { if (w === 'doc' || w === 'layers' || w === 'history' || w.startsWith('pixels:')) this.schedule(); });
    this.show();
  }

  on(fn: (r: MemoryReading) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private schedule() {
    if (this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = 0; this.update(); }, 400);
  }

  private update() {
    const r = this.reading = measureMemory(this.ed, this.budget), hist = this.ed.doc.history;
    if (r.level !== this.level) {
      if (r.level > this.level) this.warn(WARN[r.level]);
      this.level = r.level;
      hist.maxCost = HISTORY_COST[r.level];
      hist.trim();
    }
    this.show();
    for (const fn of this.listeners) fn(r);
  }

  private show() {
    const r = this.reading;
    this.el.dataset.level = String(r.level);
    this.el.dataset.tip = `Canvas memory: ${describe(r)} · ${r.tiles} tiles`;
    this.el.querySelector('.mem-text')!.textContent = fmtBytes(r.used);
    (this.el.querySelector('.mem-fill') as HTMLElement).style.width = `${Math.min(100, (r.used / r.budget) * 100).toFixed(1)}%`;
  }
}
