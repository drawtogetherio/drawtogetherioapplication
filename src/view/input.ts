import { pressureMap } from '../shared/prefs';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from '../tools/tool';

interface Touch { x: number; y: number; x0: number; y0: number }

/** Pen and mouse draw; fingers draw until a pen is used, then pan, pinch and rotate. Two-finger tap undoes, three redoes. */
export class InputController {
  private toolPointer: number | null = null;
  private toolStart = 0;
  private toolType: PointerInfo['type'] = 'mouse';
  private lastPressure = 0.5;
  private touches = new Map<number, Touch>();
  private gesture: { m0: DOMMatrix; ids: number[]; pts: { x: number; y: number }[] } | null = null;
  private tap: { t0: number; max: number; moved: boolean } | null = null;
  private pan: { id: number; x: number; y: number } | null = null;
  spaceHeld = false;
  /** R + drag rotates, Z + drag zooms. */
  viewKey: 'rotate' | 'zoom' | null = null;
  private viewDrag: { id: number; mode: 'rotate' | 'zoom'; x0: number; y0: number; m0: DOMMatrix; a0: number } | null = null;
  altPick = false; // Alt held: temporary eyedropper

  constructor(private ed: Editor, private el: HTMLCanvasElement) {
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('pointerleave', () => { this.ed.hover = null; this.ed.view.requestRender(); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    for (const t of ['touchstart', 'touchmove', 'gesturestart', 'gesturechange']) {
      el.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    }
  }

  private info(e: PointerEvent): PointerInfo {
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const d = this.ed.view.viewport.toDoc(sx, sy);
    const type = (e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse') as PointerInfo['type'];
    let p = 1;
    if (type === 'pen') {
      // Some drivers report 0 pressure on the first sample.
      p = e.pressure > 0 ? e.pressure : this.lastPressure;
      this.lastPressure = p;
      p = pressureMap(this.ed.prefs, p);
    }
    return { x: d.x, y: d.y, sx, sy, pressure: p, type, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  }

  private get tool() {
    return this.altPick && (this.ed.toolId === 'brush' || this.ed.toolId === 'fill' || this.ed.toolId === 'shape')
      ? this.ed.tools.eyedropper : this.ed.currentTool;
  }
  private activeTool!: Tool;

  private down(e: PointerEvent) {
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (e.pointerType === 'touch') return this.touchDown(e);
    if (e.button === 0 && this.viewKey) {
      const p = this.local({ x: e.clientX, y: e.clientY });
      const vp = this.ed.view.viewport;
      this.viewDrag = { id: e.pointerId, mode: this.viewKey, x0: p.x, y0: p.y, m0: vp.matrix(), a0: Math.atan2(p.y - vp.h / 2, p.x - vp.w / 2) };
      return;
    }
    if (e.button === 1 || (e.button === 0 && (this.spaceHeld || this.ed.readOnly))) {
      this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    if (e.pointerType === 'pen') {
      if (this.ed.prefs.fingerDraws) { this.ed.prefs.fingerDraws = false; this.ed.emit('prefs'); }
      if (this.toolPointer !== null && this.toolType === 'touch') this.abortTool();
      this.gesture = null;
      this.tap = null;
    }
    this.startTool(e);
  }

  private startTool(e: PointerEvent) {
    if (this.toolPointer !== null) return;
    this.toolPointer = e.pointerId;
    this.toolStart = performance.now();
    this.toolType = e.pointerType as PointerInfo['type'];
    this.activeTool = this.tool;
    this.activeTool.down(this.info(e));
    this.ed.hover = null;
  }

  private abortTool() {
    if (this.toolPointer === null) return;
    this.activeTool.cancel();
    this.toolPointer = null;
  }

  private touchDown(e: PointerEvent) {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    const n = this.touches.size;
    if (n === 1) this.tap = { t0: performance.now(), max: 1, moved: false };
    else if (this.tap) this.tap.max = Math.max(this.tap.max, n);

    if (n === 1 && this.ed.prefs.fingerDraws && !this.ed.readOnly && this.toolPointer === null) {
      this.startTool(e);
      return;
    }
    if (this.toolPointer !== null && this.toolType === 'touch') {
      // Second finger: a gesture. Drop a stroke that just started, keep a long one.
      if (performance.now() - this.toolStart < 300) this.abortTool();
      else { this.activeTool.up(this.info(e)); this.toolPointer = null; }
    }
    if (this.toolPointer === null) this.startGesture();
  }

  private startGesture() {
    const ids = [...this.touches.keys()].slice(0, 2);
    this.gesture = {
      m0: this.ed.view.viewport.matrix(),
      ids,
      pts: ids.map((id) => this.local(this.touches.get(id)!)),
    };
  }

  private local(t: { x: number; y: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: t.x - r.left, y: t.y - r.top };
  }

  private move(e: PointerEvent) {
    if (this.viewDrag && e.pointerId === this.viewDrag.id) { this.dragView(e); return; }
    if (this.pan && e.pointerId === this.pan.id) {
      this.ed.view.viewport.panBy(e.clientX - this.pan.x, e.clientY - this.pan.y);
      this.pan.x = e.clientX; this.pan.y = e.clientY;
      return;
    }
    if (e.pointerId === this.toolPointer) {
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ce of events.length ? events : [e]) this.activeTool.move(this.info(ce));
      const p = this.info(e);
      this.ed.sendCursor(p.x, p.y, true);
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (t) {
      t.x = e.clientX; t.y = e.clientY;
      if (this.tap && Math.hypot(t.x - t.x0, t.y - t.y0) > 12) this.tap.moved = true;
      if (this.gesture) this.updateGesture();
      return;
    }
    if (e.pointerType !== 'touch' && e.buttons === 0) {
      const p = this.info(e);
      this.ed.hover = { x: p.x, y: p.y, pointer: p.type };
      this.ed.view.requestRender();
    }
  }

  private dragView(e: PointerEvent) {
    const d = this.viewDrag!;
    const vp = this.ed.view.viewport;
    const p = this.local({ x: e.clientX, y: e.clientY });
    let m: DOMMatrix;
    if (d.mode === 'zoom') {
      const f = Math.exp(((p.x - d.x0) - (p.y - d.y0)) * 0.006);
      m = new DOMMatrix().translateSelf(d.x0, d.y0).scaleSelf(f).translateSelf(-d.x0, -d.y0);
    } else {
      const cx = vp.w / 2, cy = vp.h / 2;
      let deg = ((Math.atan2(p.y - cy, p.x - cx) - d.a0) * 180) / Math.PI;
      if (e.shiftKey) {
        const start = (Math.atan2(d.m0.b, d.m0.a) * 180) / Math.PI;
        deg = Math.round((start + deg) / 15) * 15 - start;
      }
      m = new DOMMatrix().translateSelf(cx, cy).rotateSelf(deg).translateSelf(-cx, -cy);
    }
    vp.setFromMatrix(m.multiplySelf(d.m0));
  }

  private updateGesture() {
    const g = this.gesture!;
    const vp = this.ed.view.viewport;
    const cur = g.ids.map((id) => this.touches.get(id)).filter(Boolean).map((t) => this.local(t!));
    if (cur.length !== g.pts.length) return;
    let m: DOMMatrix;
    if (cur.length === 1) {
      m = new DOMMatrix().translateSelf(cur[0].x - g.pts[0].x, cur[0].y - g.pts[0].y);
    } else {
      const [a0, b0] = g.pts, [a1, b1] = cur;
      const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1, d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
      const ang = Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
      const c0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, c1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
      m = new DOMMatrix().translateSelf(c1.x, c1.y).rotateSelf((ang * 180) / Math.PI).scaleSelf(d1 / d0).translateSelf(-c0.x, -c0.y);
    }
    vp.setFromMatrix(m.multiplySelf(g.m0));
  }

  private up(e: PointerEvent) {
    if (this.viewDrag && e.pointerId === this.viewDrag.id) { this.viewDrag = null; return; }
    if (this.pan && e.pointerId === this.pan.id) { this.pan = null; return; }
    if (e.pointerId === this.toolPointer) {
      this.toolPointer = null;
      const p = this.info(e);
      this.activeTool.up(p);
      this.ed.sendCursor(p.x, p.y, false);
    }
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.touches.size === 0) {
      const tap = this.tap;
      this.tap = null;
      this.gesture = null;
      if (tap && !tap.moved && performance.now() - tap.t0 < 350) {
        if (tap.max === 2) this.ed.undo();
        else if (tap.max === 3) this.ed.redo();
      }
    } else if (this.gesture) {
      this.startGesture();
    }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const vp = this.ed.view.viewport;
    if (e.ctrlKey || e.metaKey) {
      vp.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)));
    } else if (e.altKey) {
      vp.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002));
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      vp.panBy(-e.deltaX * k, -e.deltaY * k);
    }
  }
}
