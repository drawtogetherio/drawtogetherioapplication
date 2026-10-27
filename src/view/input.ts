import { CANVAS_LOG, clog, pointerData, samples } from '../debug/canvasLog';
import { pressureMap } from '../shared/prefs';
import type { Editor } from '../editor';
import { PointerInfo, Tool } from '../tools/tool';

interface Touch { x: number; y: number; x0: number; y0: number }

/** A finger held still this long picks a colour (Procreate's touch and hold). */
const HOLD_MS = 450, HOLD_SLOP = 8;
/** Pinch-rotating this close to a right angle snaps to it. */
const SNAP_DEG = 3;

/**
 * Pen and mouse draw; fingers draw until a pen is used, then pan, pinch and rotate. Two-finger tap
 * undoes, three redoes, four hides the UI; a finger held still picks a colour.
 */
export class InputController {
  private toolPointer: number | null = null;
  private toolStart = 0;
  private toolType: PointerInfo['type'] = 'mouse';
  private lastPressure = 0.5;
  /** The last tool move handled, to spot the copies iPad Safari sends. */
  private lastMove: PointerEvent | null = null;
  private pendingDown: PointerEvent | null = null;
  private touches = new Map<number, Touch>();
  private gesture: { m0: DOMMatrix; ids: number[]; pts: { x: number; y: number }[] } | null = null;
  private tap: { t0: number; max: number; moved: boolean } | null = null;
  private pan: { id: number; x: number; y: number } | null = null;
  spaceHeld = false;
  /** R + drag rotates, Z + drag zooms. */
  viewKey: 'rotate' | 'zoom' | null = null;
  private viewDrag: { id: number; mode: 'rotate' | 'zoom'; x0: number; y0: number; m0: DOMMatrix; a0: number } | null = null;
  altPick = false; // Alt held: temporary eyedropper
  /** A finger held still: the eyedropper until it lifts. */
  private hold: { timer: number; id: number; picking: boolean } | null = null;
  onGesture: (g: 'hideUI') => void = () => {};
  /** A right click or pen barrel button, in client coordinates. */
  onContext: (x: number, y: number) => void = () => {};
  private el!: HTMLCanvasElement;
  private off: (() => void) | null = null;

  constructor(private ed: Editor, el: HTMLCanvasElement) { this.bind(el); }

  /** The stage canvas can be replaced (low-latency setting); listeners move with it. */
  bind(el: HTMLCanvasElement) {
    this.off?.();
    this.el = el;
    el.style.touchAction = 'none';
    const on = <K extends keyof HTMLElementEventMap>(t: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(t, fn, opts);
      return () => el.removeEventListener(t, fn, opts);
    };
    const offs = [
      on('pointerdown', (e) => this.down(e)),
      on('pointermove', (e) => this.move(e)),
      on('pointerup', (e) => this.up(e)),
      on('pointercancel', (e) => this.up(e)),
      on('pointerleave', () => { this.ed.hover = null; this.ed.view.requestRender(); }),
      on('contextmenu', (e) => { e.preventDefault(); this.onContext(e.clientX, e.clientY); }),
      on('wheel', (e) => this.wheel(e), { passive: false }),
      ...(['touchstart', 'touchmove', 'gesturestart', 'gesturechange'] as const).map((t) => on(t as 'touchstart', (e) => e.preventDefault(), { passive: false })),
    ];
    this.off = () => { for (const f of offs) f(); };
  }

  /** `force`: the pen pressure to use instead of the event's, for coalesced samples that carry a stale one. */
  private info(e: PointerEvent, r: DOMRect = this.el.getBoundingClientRect(), force?: number): PointerInfo {
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const d = this.ed.view.viewport.toDoc(sx, sy);
    const type = (e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse') as PointerInfo['type'];
    let p = 1;
    const tiltX = e.tiltX || 0, tiltY = e.tiltY || 0;
    // Safari and Chrome report altitude/azimuth; everything else only the tilts, which give the same lean.
    const pe = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    let altitude = pe.altitudeAngle ?? Math.PI / 2, azimuth = pe.azimuthAngle ?? 0;
    if (pe.altitudeAngle === undefined && (tiltX || tiltY)) {
      const tx = Math.tan((tiltX * Math.PI) / 180), ty = Math.tan((tiltY * Math.PI) / 180);
      altitude = Math.atan(1 / Math.hypot(tx, ty));
      azimuth = (Math.atan2(ty, tx) + Math.PI * 2) % (Math.PI * 2);
    }
    if (type === 'pen') {
      // Some drivers report 0 pressure on the first sample.
      p = force ?? (e.pressure > 0 ? e.pressure : this.lastPressure);
      this.lastPressure = p;
      p = pressureMap(this.ed.prefs, p);
    }
    this.ed.pen = { type, pressure: e.pressure, tiltX, tiltY, altitude, azimuth, at: e.timeStamp };
    return { x: d.x, y: d.y, sx, sy, pressure: p, type, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, tiltX, tiltY, altitude, azimuth };
  }

  private get tool() {
    return this.altPick && (this.ed.toolId === 'brush' || this.ed.toolId === 'fill' || this.ed.toolId === 'shape')
      ? this.ed.tools.eyedropper : this.ed.currentTool;
  }
  private activeTool!: Tool;

  private down(e: PointerEvent) {
    if (CANVAS_LOG) clog('down', { ...pointerData(e), tool: this.ed.toolId, toolPointer: this.toolPointer, touches: this.touches.size });
    if (e.button === 2) return; // the quick menu's; capturing would keep its release from reaching the menu
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
    this.ed.hover = null;
    // A pen that reports no pressure yet (iPad) would start with a dot of the last stroke's size: wait for the next sample.
    if (e.pointerType === 'pen' && e.pressure === 0) { this.pendingDown = e; return; }
    this.activeTool.down(this.info(e));
  }

  /** True once the tool has started; a pending pen down waits for a sample that carries pressure. */
  private started(e: PointerEvent, force?: number) {
    const d = this.pendingDown;
    if (!d) return true;
    if ((force ?? e.pressure) === 0 && e.type !== 'pointerup') return false;
    this.pendingDown = null;
    this.activeTool.down({ ...this.info(d), pressure: this.info(e, undefined, force).pressure });
    return true;
  }

  private abortTool() {
    if (this.toolPointer === null) return;
    if (CANVAS_LOG) clog('abort', { tool: this.ed.toolId });
    this.pendingDown = null;
    this.activeTool.cancel();
    this.toolPointer = null;
  }

  private touchDown(e: PointerEvent) {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    const n = this.touches.size;
    if (n === 1) this.tap = { t0: performance.now(), max: 1, moved: false };
    else if (this.tap) this.tap.max = Math.max(this.tap.max, n);
    this.endHold();

    if (n === 1 && this.ed.prefs.fingerDraws && !this.ed.readOnly && this.toolPointer === null) {
      this.startTool(e);
      return;
    }
    if (n === 1 && this.toolPointer === null && !this.ed.readOnly) {
      this.hold = { id: e.pointerId, picking: false, timer: window.setTimeout(() => this.startPick(e), HOLD_MS) };
    }
    if (this.toolPointer !== null && this.toolType === 'touch') {
      // Second finger: a gesture. Drop a stroke that just started, keep a long one.
      if (performance.now() - this.toolStart < 300) this.abortTool();
      else { this.activeTool.up(this.info(e)); this.toolPointer = null; }
    }
    if (this.toolPointer === null) this.startGesture();
  }

  private startGesture() {
    if (CANVAS_LOG) clog('gesture', { touches: this.touches.size });
    const ids = [...this.touches.keys()].slice(0, 2);
    this.gesture = {
      m0: this.ed.view.viewport.matrix(),
      ids,
      pts: ids.map((id) => this.local(this.touches.get(id)!)),
    };
  }

  /** The finger stayed put: pick colours under it until it lifts. */
  private startPick(e: PointerEvent) {
    const hd = this.hold;
    if (!hd || this.toolPointer !== null) return;
    hd.picking = true;
    this.tap = null;
    this.gesture = null;
    this.ed.tools.eyedropper.down(this.info(e));
    this.ed.view.requestRender();
  }

  private endHold() {
    if (!this.hold) return;
    clearTimeout(this.hold.timer);
    this.hold = null;
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
      // iPad Safari delivers each Apple Pencil move twice. Replaying the copy walks the stroke back over
      // its last four samples: double the dabs, overdraw, and smoothing pulled behind the pen.
      const lm = this.lastMove;
      if (lm && lm.pointerId === e.pointerId && lm.timeStamp === e.timeStamp && lm.clientX === e.clientX && lm.clientY === e.clientY && lm.pressure === e.pressure) {
        if (CANVAS_LOG) clog('move.dup', { ts: Math.round(e.timeStamp * 100) / 100 });
        return;
      }
      this.lastMove = e;
      const t0 = CANVAS_LOG ? performance.now() : 0;
      const coalesced = e.getCoalescedEvents?.() ?? [];
      const events = coalesced.length ? coalesced : [e];
      const r = this.el.getBoundingClientRect(); // once per event, not per coalesced sample
      // iPad Safari hands over 240 Hz positions but gives every coalesced sample the same pressure, so
      // width and flow jump once per frame: dashes at light pressure, bands at heavy. When the batch's
      // pressures are all alike, they are ramped from the last event's pressure to this one's instead.
      const from = this.lastPressure, n = events.length;
      const ramp = e.pointerType === 'pen' && !this.pendingDown && n > 1 && e.pressure > 0 && events.every((ce) => ce.pressure === events[0].pressure);
      events.forEach((ce, i) => {
        const force = ramp ? from + (e.pressure - from) * ((i + 1) / n) : undefined;
        if (this.started(ce, force)) this.activeTool.move(this.info(ce, r, force));
      });
      const p = this.info(e, r), at = this.activeTool.pen?.() ?? p;
      if (this.activeTool.predict && !this.pendingDown) {
        const ahead = e.getPredictedEvents?.() ?? [];
        this.activeTool.predict(ahead.map((pe) => this.info(pe, r)));
      }
      this.ed.sendCursor(at.x, at.y, true);
      if (CANVAS_LOG) {
        const ahead = e.getPredictedEvents?.() ?? [];
        clog('move', { e: pointerData(e), n: coalesced.length, c: samples(e, coalesced), pr: samples(e, ahead), ramp, pending: !!this.pendingDown, ms: Math.round((performance.now() - t0) * 100) / 100 });
      }
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (t) {
      t.x = e.clientX; t.y = e.clientY;
      const hd = this.hold;
      if (hd?.id === e.pointerId) {
        if (hd.picking) { this.ed.tools.eyedropper.move(this.info(e)); return; }
        if (Math.hypot(t.x - t.x0, t.y - t.y0) > HOLD_SLOP) this.endHold();
      }
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
    if (cur.length === 2) this.snapRotation(cur[0], cur[1]);
  }

  /** Close to upright (or a quarter turn), the canvas settles exactly there. */
  private snapRotation(a: { x: number; y: number }, b: { x: number; y: number }) {
    const vp = this.ed.view.viewport, q = Math.PI / 2;
    const near = Math.round(vp.rot / q) * q, d = near - vp.rot;
    if (!d || Math.abs(d) > (SNAP_DEG * Math.PI) / 180) return;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    vp.setFromMatrix(new DOMMatrix().translateSelf(c.x, c.y).rotateSelf((d * 180) / Math.PI).translateSelf(-c.x, -c.y).multiplySelf(vp.matrix()));
    vp.rot = near;
  }

  private up(e: PointerEvent) {
    if (CANVAS_LOG) clog(e.type === 'pointercancel' ? 'cancel' : 'up', { ...pointerData(e), tool: e.pointerId === this.toolPointer, touches: this.touches.size });
    if (this.viewDrag && e.pointerId === this.viewDrag.id) { this.viewDrag = null; return; }
    if (this.pan && e.pointerId === this.pan.id) { this.pan = null; return; }
    if (e.pointerId === this.toolPointer) {
      this.toolPointer = null;
      this.started(e);
      const p = this.info(e);
      this.activeTool.up(p);
      this.ed.sendCursor(p.x, p.y, false);
    }
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.hold?.id === e.pointerId) {
      if (this.hold.picking) { this.ed.tools.eyedropper.up(this.info(e)); this.ed.view.requestRender(); }
      this.endHold();
    }
    if (this.touches.size === 0) {
      const tap = this.tap;
      this.tap = null;
      this.gesture = null;
      if (tap && !tap.moved && performance.now() - tap.t0 < 350) {
        if (tap.max === 2) this.ed.undo();
        else if (tap.max === 3) this.ed.redo();
        else if (tap.max === 4) this.onGesture('hideUI');
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
