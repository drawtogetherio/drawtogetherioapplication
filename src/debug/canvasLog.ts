// Canvas logs: a detailed, timestamped record of a drawing session to export and send in when the
// canvas misbehaves on some device. Beta builds only: every call site is written `CANVAS_LOG && …`,
// and `__CANVAS_LOG__` is false in any other build, so the minifier drops the calls and this module
// with them. scripts/check-build.mjs fails a non-beta build that still contains it.

import type { Editor } from '../editor';
import { saveFile } from '../io/platform';

export const CANVAS_LOG: boolean = __CANVAS_LOG__;

/** [ms since the log started, kind, data]. */
type Entry = [number, string, unknown?];

/** Past this the oldest entries go, but the first ones (device, canvas creation) are kept. */
const MAX_ENTRIES = 150_000, KEEP_HEAD = 2_000;

const t0 = performance.now();
const startedAt = new Date().toISOString();
let entries: Entry[] = [];
let dropped = 0;
const ms = (v: number) => Math.round(v * 100) / 100;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Adds one entry. */
export function clog(kind: string, data?: unknown) {
  entries.push(data === undefined ? [ms(performance.now() - t0), kind] : [ms(performance.now() - t0), kind, data]);
  if (entries.length > MAX_ENTRIES) {
    const cut = Math.floor(MAX_ENTRIES / 10);
    entries = entries.slice(0, KEEP_HEAD).concat(entries.slice(KEEP_HEAD + cut));
    dropped += cut;
  }
}

/** A pointer event as the browser reported it. */
export function pointerData(e: PointerEvent) {
  const pe = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
  return {
    id: e.pointerId, type: e.pointerType, primary: e.isPrimary, x: r2(e.clientX), y: r2(e.clientY), p: r2(e.pressure * 1000) / 1000,
    tx: e.tiltX, ty: e.tiltY, alt: pe.altitudeAngle !== undefined ? r2(pe.altitudeAngle) : undefined, az: pe.azimuthAngle !== undefined ? r2(pe.azimuthAngle) : undefined,
    w: e.width, h: e.height, btn: e.button, btns: e.buttons, ts: ms(e.timeStamp), lag: ms(performance.now() - e.timeStamp),
  };
}

/** Coalesced or predicted samples, compactly: [ms after the event, x, y, pressure]. */
export const samples = (e: PointerEvent, list: readonly PointerEvent[]) =>
  list.map((s) => [ms(s.timeStamp - e.timeStamp), r2(s.clientX), r2(s.clientY), Math.round(s.pressure * 1000) / 1000]);

/** Renderer work during the current stroke, summed and reported when it ends. */
export const strokeStats = { dabs: 0, syncs: 0, syncMs: 0, syncMax: 0, syncPx: 0, addMs: 0, addMax: 0, adds: 0 };
export function resetStrokeStats() { for (const k of Object.keys(strokeStats) as (keyof typeof strokeStats)[]) strokeStats[k] = 0; }

/** The device, the browser and what the page can see of the GPU. */
function deviceInfo() {
  const n = navigator as Navigator & { deviceMemory?: number; userAgentData?: unknown };
  let gpu: string | null = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
  } catch { /* no WebGL */ }
  const vv = window.visualViewport;
  return {
    version: __APP_VERSION__, startedAt, url: location.href.split('?')[0], ua: navigator.userAgent, platform: navigator.platform,
    dpr: window.devicePixelRatio, screen: [screen.width, screen.height], window: [innerWidth, innerHeight],
    visualViewport: vv ? [vv.width, vv.height, vv.scale] : null, cores: navigator.hardwareConcurrency, memoryGB: n.deviceMemory ?? null,
    touchPoints: navigator.maxTouchPoints, gpu, standalone: matchMedia('(display-mode: standalone)').matches,
    native: !!(window as Window & { Capacitor?: unknown }).Capacitor,
    pointerrawupdate: 'onpointerrawupdate' in window, coalesced: 'getCoalescedEvents' in PointerEvent.prototype, predicted: 'getPredictedEvents' in PointerEvent.prototype,
  };
}

/** The canvas as it stands: size, layers, tiles, history. */
export function docData(ed: Editor) {
  const d = ed.doc, s = d.settings;
  return {
    size: s.infinite ? 'infinite' : [s.width, s.height], layers: d.layers.length,
    tiles: d.layers.reduce((n, l) => n + l.surface.tiles.size + (l.mask?.tiles.size ?? 0), 0),
    ops: d.log.length, room: ed.room ? { id: ed.room.id, members: ed.room.members.length } : null,
    zoom: r2(ed.view.viewport.zoom * 1000) / 1000, rot: r2(ed.view.viewport.rot), view: [ed.view.viewport.w, ed.view.viewport.h], dpr: ed.view.dpr,
  };
}

const prefsData = (ed: Editor) => ({ ...ed.prefs, customBrushes: ed.prefs.customBrushes.length, palettes: ed.prefs.palettes.length, keys: undefined, quickMenu: undefined, panels: undefined });

/** Starts the log for an editor: device, canvas, and the watchers that run the whole session. */
export function startCanvasLog(ed: Editor) {
  clog('device', deviceInfo());
  clog('prefs', prefsData(ed));
  clog('canvas', docData(ed));
  ed.on((what) => {
    if (what === 'doc') clog('canvas', docData(ed));
    else if (what === 'prefs') clog('prefs', prefsData(ed));
    else if (what === 'tool') clog('tool', { tool: ed.toolId });
    else clog('ed', what);
  });
  // Main-thread stalls: a 50 ms timer that fires late was blocked for the difference.
  let last = performance.now();
  setInterval(() => { const now = performance.now(), late = now - last - 50; last = now; if (late > 30) clog('stall', { ms: ms(late) }); }, 50);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) clog('longtask', { ms: ms(e.duration), at: ms(e.startTime - t0) }); }).observe({ type: 'longtask', buffered: true });
  } catch { /* Safari has no long task timing */ }
  addEventListener('error', (e) => clog('error', { msg: e.message, at: `${e.filename}:${e.lineno}:${e.colno}`, stack: (e.error as Error | undefined)?.stack }));
  addEventListener('unhandledrejection', (e) => clog('error', { msg: String((e.reason as Error)?.message ?? e.reason), stack: (e.reason as Error)?.stack }));
  document.addEventListener('visibilitychange', () => clog('visibility', document.visibilityState));
  addEventListener('resize', () => clog('resize', { window: [innerWidth, innerHeight], dpr: devicePixelRatio, view: [ed.view.viewport.w, ed.view.viewport.h] }));
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
  setInterval(() => clog('memory', { heapMB: perf.memory ? Math.round(perf.memory.usedJSHeapSize / 1048576) : null, ...docData(ed) }), 10_000);
  const err = console.error.bind(console);
  console.error = (...a: unknown[]) => { clog('console.error', a.map((x) => (x instanceof Error ? x.stack ?? x.message : String(x))).join(' ')); err(...a); };
}

/** Saves the log as a JSON file (on iPad, the share sheet or Files). */
export async function exportCanvasLog(ed: Editor) {
  clog('export', docData(ed));
  const body = JSON.stringify({ format: 'doodlehive-canvas-log', v: 1, dropped, legend: LEGEND, entries });
  const name = `doodlehive-canvas-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  await saveFile(new Blob([body], { type: 'application/json' }), name);
}

/** What each kind holds, so the file explains itself. */
const LEGEND = {
  entry: '[ms since the log started, kind, data]',
  device: 'browser, screen, GPU and which pointer APIs exist', prefs: 'preferences (counts for lists)', canvas: 'canvas size, layers, tiles, ops, view',
  down: 'pointerdown: id, type, x, y (client px), p pressure, tilt, altitude/azimuth, contact size, buttons, ts event time, lag ms from event to handler',
  move: 'tool pointer move: e = the event (as down), n coalesced count, c coalesced samples [ms after event, x, y, pressure], pr predicted samples, ramp = pressure ramped, ms = time to handle',
  up: 'pointerup or pointercancel (kind says which)', 'stroke.start': 'brush params, colour, layer, zoom, symmetry, stabilizer', 'stroke.end': 'samples, length, duration and renderer totals',
  frame: 'a redraw: ms to render, gap since the last frame, dirty areas', stall: 'main thread blocked this long', commit: 'an edit applied: label, op types, ms',
};
