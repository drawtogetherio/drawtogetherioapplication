// Per-account preferences, saved with the profile so they follow the person across devices.
import { DEFAULT_CURVE, curveAt, validCurve } from './curve';
import { cleanBrush } from './brush';
import type { BrushParams } from '../core/model';

export type KeyAction = 'brush' | 'eraser' | 'smudge' | 'fill' | 'select' | 'shape' | 'eyedropper' | 'layers'
  | 'fit' | 'flipH' | 'flipV' | 'zoomIn' | 'zoomOut' | 'sizeUp' | 'sizeDown' | 'rotate' | 'zoomDrag';

export const KEY_ACTIONS: { id: KeyAction; label: string }[] = [
  { id: 'brush', label: 'Brush' }, { id: 'eraser', label: 'Eraser' }, { id: 'smudge', label: 'Smudge' }, { id: 'fill', label: 'Fill' },
  { id: 'select', label: 'Selection' }, { id: 'shape', label: 'Shapes' }, { id: 'eyedropper', label: 'Eyedropper' }, { id: 'layers', label: 'Layers' },
  { id: 'sizeUp', label: 'Bigger brush' }, { id: 'sizeDown', label: 'Smaller brush' }, { id: 'rotate', label: 'Rotate (hold + drag)' }, { id: 'zoomDrag', label: 'Zoom (hold + drag)' },
  { id: 'fit', label: 'Fit to screen' }, { id: 'zoomIn', label: 'Zoom in' }, { id: 'zoomOut', label: 'Zoom out' }, { id: 'flipH', label: 'Flip horizontal' }, { id: 'flipV', label: 'Flip vertical' },
];

export const DEFAULT_KEYS: Record<KeyAction, string> = {
  brush: 'b', eraser: 'e', smudge: 's', fill: 'g', select: 'm', shape: 'u', eyedropper: 'i', layers: 'l',
  sizeUp: ']', sizeDown: '[', rotate: 'r', zoomDrag: 'z', fit: '0', zoomIn: '=', zoomOut: '-', flipH: 'h', flipV: 'v',
};

/** What an Apple Pencil double-tap or squeeze does in the iPad app; 'system' follows iPadOS Settings → Apple Pencil. */
export type PencilAction = 'system' | 'eraser' | 'previous' | 'color' | 'brushes' | 'palette' | 'undo' | 'off';
export const PENCIL_ACTIONS: { id: PencilAction; label: string }[] = [
  { id: 'system', label: 'As in iPad Settings' }, { id: 'eraser', label: 'Switch to eraser' }, { id: 'previous', label: 'Previous tool' },
  { id: 'palette', label: 'Quick palette' }, { id: 'color', label: 'Colour' }, { id: 'brushes', label: 'Brush library' }, { id: 'undo', label: 'Undo' }, { id: 'off', label: 'Nothing' },
];

export type Mode = 'dark' | 'light' | 'system';
export const MODES: Mode[] = ['dark', 'light', 'system'];

/** A brush someone made; `cat` is a library category or one of their own. */
export interface CustomBrush { id: string; name: string; cat: string; params: BrushParams }
export const BUILTIN_CATEGORIES = ['General', 'Pencil', 'Pen', 'Eraser'];
export const MAX_CUSTOM_BRUSHES = 80, MAX_CATEGORIES = 12;

export type PanelId = 'tools' | 'brush' | 'color' | 'swatches' | 'layers';
export type Dock = 'left' | 'right' | 'top' | 'bottom' | 'float';
export interface PanelState { dock: Dock; x: number; y: number; w: number; h: number; show: boolean; order: number }
export const PANELS: { id: PanelId; label: string }[] = [
  { id: 'tools', label: 'Tools' }, { id: 'brush', label: 'Brush properties' }, { id: 'color', label: 'Colour wheel' }, { id: 'swatches', label: 'Swatches' }, { id: 'layers', label: 'Layers' },
];
export const DEFAULT_PANELS: Record<PanelId, PanelState> = {
  tools: { dock: 'left', x: 0, y: 0, w: 56, h: 440, show: true, order: 0 },
  brush: { dock: 'left', x: 0, y: 0, w: 230, h: 480, show: true, order: 1 },
  color: { dock: 'right', x: 0, y: 0, w: 260, h: 340, show: true, order: 0 },
  swatches: { dock: 'right', x: 0, y: 0, w: 260, h: 160, show: true, order: 1 },
  layers: { dock: 'right', x: 0, y: 0, w: 300, h: 420, show: true, order: 2 },
};

export interface Prefs {
  /** Only the bindings that differ from the defaults; '' unbinds. */
  keys: Partial<Record<KeyAction, string>>;
  mode: Mode;
  hoverPreview: boolean;
  showBubbles: boolean;
  pressureGamma: number;
  /** Advanced pressure: a curve through points instead of the exponent. */
  pressureMode: 'simple' | 'advanced';
  pressureCurve: number[];
  /** One finger draws; otherwise it pans. Turns off by itself once a pen is used. */
  fingerDraws: boolean;
  /** The Patreon banner on the home screen; false once it has been closed. */
  supportBanner: boolean;
  /** Brush ids starred in the library. */
  favoriteBrushes: string[];
  customBrushes: CustomBrush[];
  /** Categories the person added to the brush library. */
  brushCategories: string[];
  layout: 'classic' | 'studio';
  /** Where each studio panel sits. */
  panels: Record<PanelId, PanelState>;
  pencilTap: PencilAction;
  pencilSqueeze: PencilAction;
}

export const DEFAULT_PREFS: Prefs = {
  keys: {}, mode: 'dark', hoverPreview: true, showBubbles: true, pressureGamma: 1, pressureMode: 'simple', pressureCurve: DEFAULT_CURVE,
  fingerDraws: true, supportBanner: true, favoriteBrushes: [], customBrushes: [], brushCategories: [], layout: 'classic', panels: DEFAULT_PANELS,
  pencilTap: 'system', pencilSqueeze: 'system',
};

const isKey = (v: unknown) => typeof v === 'string' && (v === '' || (v.length === 1 && v.trim() === v));
const isBrushId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,24}$/.test(v);
export const cleanName = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const pencilAction = (v: unknown): PencilAction => (PENCIL_ACTIONS.some((a) => a.id === v) ? v as PencilAction : 'system');
const list = (v: unknown) => (Array.isArray(v) ? v : []);

function cleanPanels(raw: unknown): Record<PanelId, PanelState> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown>>;
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);
  const out = {} as Record<PanelId, PanelState>;
  for (const { id } of PANELS) {
    const d = DEFAULT_PANELS[id], p = r[id] ?? {};
    out[id] = {
      dock: ['left', 'right', 'top', 'bottom', 'float'].includes(p.dock as string) ? p.dock as Dock : d.dock,
      x: n(p.x, 0, 8000, d.x), y: n(p.y, 0, 8000, d.y), w: n(p.w, 48, 1600, d.w), h: n(p.h, 48, 2400, d.h), show: p.show !== false, order: n(p.order, 0, 9, d.order),
    };
  }
  return out;
}

export function cleanPrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const keys: Prefs['keys'] = {};
  const rk = (r.keys && typeof r.keys === 'object' ? r.keys : {}) as Record<string, unknown>;
  for (const a of KEY_ACTIONS) {
    const v = rk[a.id];
    if (isKey(v) && v !== DEFAULT_KEYS[a.id]) keys[a.id] = (v as string).toLowerCase();
  }
  const gamma = Number(r.pressureGamma);
  const cats: string[] = [];
  for (const c of list(r.brushCategories)) {
    const name = cleanName(c, 20);
    if (name && !BUILTIN_CATEGORIES.includes(name) && !cats.includes(name) && cats.length < MAX_CATEGORIES) cats.push(name);
  }
  const brushes: CustomBrush[] = [];
  for (const b of list(r.customBrushes) as Record<string, unknown>[]) {
    const params = b && cleanBrush(b.params), name = cleanName(b?.name, 30);
    if (!params || !name || !isBrushId(b.id) || brushes.some((x) => x.id === b.id) || brushes.length >= MAX_CUSTOM_BRUSHES) continue;
    const cat = cleanName(b.cat, 20);
    brushes.push({ id: b.id, name, cat: BUILTIN_CATEGORIES.includes(cat) || cats.includes(cat) ? cat : 'General', params });
  }
  return {
    keys,
    mode: MODES.includes(r.mode as Mode) ? r.mode as Mode : DEFAULT_PREFS.mode,
    hoverPreview: typeof r.hoverPreview === 'boolean' ? r.hoverPreview : DEFAULT_PREFS.hoverPreview,
    showBubbles: typeof r.showBubbles === 'boolean' ? r.showBubbles : DEFAULT_PREFS.showBubbles,
    pressureGamma: gamma >= 0.4 && gamma <= 2.5 ? gamma : DEFAULT_PREFS.pressureGamma,
    pressureMode: r.pressureMode === 'advanced' ? 'advanced' : 'simple',
    pressureCurve: validCurve(r.pressureCurve) ? [...r.pressureCurve] : [...DEFAULT_CURVE],
    fingerDraws: r.fingerDraws !== false,
    supportBanner: r.supportBanner !== false,
    favoriteBrushes: list(r.favoriteBrushes).filter(isBrushId).slice(0, 40),
    customBrushes: brushes,
    brushCategories: cats,
    layout: r.layout === 'studio' ? 'studio' : 'classic',
    panels: cleanPanels(r.panels),
    pencilTap: pencilAction(r.pencilTap),
    pencilSqueeze: pencilAction(r.pencilSqueeze),
  };
}

export function pressureMap(p: Prefs, v: number): number {
  const x = Math.min(1, Math.max(0.001, v));
  return p.pressureMode === 'advanced' ? Math.max(0.001, curveAt(p.pressureCurve, x)) : Math.pow(x, p.pressureGamma);
}

export const keyOf = (p: Prefs, a: KeyAction) => p.keys[a] ?? DEFAULT_KEYS[a];

export function actionFor(p: Prefs, key: string): KeyAction | null {
  for (const a of KEY_ACTIONS) if (keyOf(p, a.id) === key) return a.id;
  return null;
}
