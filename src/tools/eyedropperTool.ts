import { renderRegion } from '../engine/compositor';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from './tool';

export function sampleColor(ed: Editor, x: number, y: number): string | null {
  const c = renderRegion(ed.doc, { x: Math.floor(x), y: Math.floor(y), w: 1, h: 1 });
  const d = c.getContext('2d')!.getImageData(0, 0, 1, 1).data;
  if (d[3] === 0) return null;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export class EyedropperTool implements Tool {
  private active = false;
  /** Tool to return to after picking (set when used as a temporary modifier). */
  returnTo: (() => void) | null = null;

  constructor(private ed: Editor) {}

  busy() { return this.active; }
  down(p: PointerInfo) { this.active = true; this.pick(p); }
  move(p: PointerInfo) { if (this.active) this.pick(p); }
  up(p: PointerInfo) {
    if (!this.active) return;
    this.active = false;
    this.pick(p);
    this.ed.pushRecent(this.ed.color);
    this.ed.emit('color');
  }
  cancel() { this.active = false; }

  private pick(p: PointerInfo) {
    const c = sampleColor(this.ed, p.x, p.y);
    if (c) this.ed.setColor(c);
  }
}
