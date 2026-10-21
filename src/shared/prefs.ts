// Per-account preferences, saved with the profile so they follow the person across devices.

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

export type Mode = 'dark' | 'light' | 'system';
export const MODES: Mode[] = ['dark', 'light', 'system'];

export interface Prefs {
  /** Only the bindings that differ from the defaults; '' unbinds. */
  keys: Partial<Record<KeyAction, string>>;
  mode: Mode;
  hoverPreview: boolean;
  showBubbles: boolean;
  pressureGamma: number;
}

export const DEFAULT_PREFS: Prefs = { keys: {}, mode: 'dark', hoverPreview: true, showBubbles: true, pressureGamma: 1 };

const isKey = (v: unknown) => typeof v === 'string' && (v === '' || (v.length === 1 && v.trim() === v));

export function cleanPrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const keys: Prefs['keys'] = {};
  const rk = (r.keys && typeof r.keys === 'object' ? r.keys : {}) as Record<string, unknown>;
  for (const a of KEY_ACTIONS) {
    const v = rk[a.id];
    if (isKey(v) && v !== DEFAULT_KEYS[a.id]) keys[a.id] = (v as string).toLowerCase();
  }
  const gamma = Number(r.pressureGamma);
  return {
    keys,
    mode: MODES.includes(r.mode as Mode) ? r.mode as Mode : DEFAULT_PREFS.mode,
    hoverPreview: typeof r.hoverPreview === 'boolean' ? r.hoverPreview : DEFAULT_PREFS.hoverPreview,
    showBubbles: typeof r.showBubbles === 'boolean' ? r.showBubbles : DEFAULT_PREFS.showBubbles,
    pressureGamma: gamma >= 0.4 && gamma <= 2.5 ? gamma : DEFAULT_PREFS.pressureGamma,
  };
}

export const keyOf = (p: Prefs, a: KeyAction) => p.keys[a] ?? DEFAULT_KEYS[a];

export function actionFor(p: Prefs, key: string): KeyAction | null {
  for (const a of KEY_ACTIONS) if (keyOf(p, a.id) === key) return a.id;
  return null;
}
