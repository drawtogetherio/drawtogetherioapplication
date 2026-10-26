// Brush parameter ranges and the shareable brush code, used by the client and the server.
import type { BrushParams } from '../core/model';
import { isAssetId } from './brushAssets';

/** Numbers (x, y, pressure) one stroke op may carry; longer strokes are split. */
export const MAX_STROKE_PTS = 120_000;
/** A stroke's path length in px, and length × brush size: both bound how long everyone's browser spends painting it. */
export const MAX_STROKE_PATH = 400_000, MAX_STROKE_INK = 20e6;

/** Whether a stroke this long is still one the room accepts; `full` splits well before the limit. */
export function strokeFits(pts: number, len: number, size: number, full = 1) {
  return pts <= MAX_STROKE_PTS * full && len <= MAX_STROKE_PATH * full && len * size <= MAX_STROKE_INK * full;
}

export const MAX_BRUSH_SIZE = 500;

export type BrushGroup = 'Stroke' | 'Pressure' | 'Texture' | 'Dual tip' | 'Scatter' | 'Colour' | 'Wet mix' | 'Tilt';
/** Every slider in the brush editor, in share-code order; `opt` fields may be left out (off). */
export const BRUSH_FIELDS: { key: keyof BrushParams & string; label: string; min: number; max: number; pct?: boolean; opt?: true; group: BrushGroup }[] = [
  { key: 'size', label: 'Size', min: 0.1, max: MAX_BRUSH_SIZE, group: 'Stroke' },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, pct: true, group: 'Stroke' },
  { key: 'flow', label: 'Flow', min: 0, max: 1, pct: true, group: 'Stroke' },
  { key: 'hardness', label: 'Hardness', min: 0, max: 1, pct: true, group: 'Stroke' },
  { key: 'spacing', label: 'Spacing', min: 0.01, max: 4, pct: true, group: 'Stroke' },
  { key: 'pressureSize', label: 'Pressure → size', min: 0, max: 1, pct: true, group: 'Pressure' },
  { key: 'pressureFlow', label: 'Pressure → flow', min: 0, max: 1, pct: true, group: 'Pressure' },
  { key: 'minSize', label: 'Min size', min: 0, max: 1, pct: true, group: 'Pressure' },
  { key: 'smoothing', label: 'Smoothing', min: 0, max: 1, pct: true, group: 'Stroke' },
  { key: 'grain', label: 'Grain', min: 0, max: 1, pct: true, opt: true, group: 'Texture' },
  { key: 'grainScale', label: 'Grain scale', min: 0.25, max: 8, opt: true, group: 'Texture' },
  { key: 'angle', label: 'Angle', min: 0, max: 360, opt: true, group: 'Scatter' },
  { key: 'scatter', label: 'Scatter', min: 0, max: 2, opt: true, group: 'Scatter' },
  { key: 'sizeJitter', label: 'Size jitter', min: 0, max: 1, pct: true, opt: true, group: 'Scatter' },
  { key: 'flowJitter', label: 'Flow jitter', min: 0, max: 1, pct: true, opt: true, group: 'Scatter' },
  { key: 'angleJitter', label: 'Angle jitter', min: 0, max: 1, pct: true, opt: true, group: 'Scatter' },
  { key: 'hueJitter', label: 'Hue jitter', min: 0, max: 1, pct: true, opt: true, group: 'Colour' },
  { key: 'satJitter', label: 'Saturation jitter', min: 0, max: 1, pct: true, opt: true, group: 'Colour' },
  { key: 'brightJitter', label: 'Brightness jitter', min: 0, max: 1, pct: true, opt: true, group: 'Colour' },
  { key: 'wet', label: 'Pick-up', min: 0, max: 1, pct: true, opt: true, group: 'Wet mix' },
  { key: 'tilt', label: 'Tilt shading', min: 0, max: 1, pct: true, opt: true, group: 'Tilt' },
  { key: 'dualScale', label: 'Dual tip size', min: 0.1, max: 4, opt: true, group: 'Dual tip' },
];
export const BRUSH_GROUPS: BrushGroup[] = ['Stroke', 'Pressure', 'Texture', 'Dual tip', 'Scatter', 'Colour', 'Wet mix', 'Tilt'];

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function validBrush(b: unknown): b is BrushParams {
  if (!b || typeof b !== 'object') return false;
  const r = b as Record<string, unknown>;
  for (const f of BRUSH_FIELDS) {
    const v = r[f.key];
    if (v === undefined && f.opt) continue;
    if (!num(v, f.min, f.max)) return false;
  }
  const idOrNone = (v: unknown) => v === undefined || isAssetId(v);
  const flag = (v: unknown) => v === undefined || typeof v === 'boolean';
  return (r.shape === undefined || r.shape === 'round' || r.shape === 'square' || isAssetId(r.shape)) && idOrNone(r.dual) && idOrNone(r.texture) && flag(r.follow) && flag(r.grainMove);
}

/** The same brush with only the known fields, rounded so it stays small when saved. */
export function cleanBrush(b: unknown): BrushParams | null {
  if (!validBrush(b)) return null;
  const out = {} as Record<string, unknown>;
  for (const f of BRUSH_FIELDS) if (b[f.key] !== undefined && !(f.opt && b[f.key] === 0)) out[f.key] = Math.round((b[f.key] as number) * 1000) / 1000;
  if (b.shape === 'square' || isAssetId(b.shape)) out.shape = b.shape;
  if (b.dual) out.dual = b.dual;
  if (b.texture) out.texture = b.texture;
  if (b.follow) out.follow = true;
  if (b.grainMove) out.grainMove = true;
  return out as unknown as BrushParams;
}

const CODE_PREFIX = 'hive-';

/** A brush as text friends can paste in: hive- followed by base64url of "name\nnumbers". */
export function brushCode(name: string, p: BrushParams): string {
  const nums = BRUSH_FIELDS.map((f) => (p[f.key] as number | undefined) ?? '');
  const flags = [p.follow ? 'follow' : '', p.grainMove ? 'move' : '', p.dual ?? '', p.texture ?? ''];
  const text = `${name}\n${nums.join(',')}\n${p.shape ?? 'round'}\n${flags.join(',')}`.replace(/[,\n]+$/, '');
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const c of bytes) bin += String.fromCharCode(c);
  return CODE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseBrushCode(code: string): { name: string; params: BrushParams } | null {
  const s = code.trim();
  if (!s.startsWith(CODE_PREFIX)) return null;
  try {
    const b64 = s.slice(CODE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const [name, nums = '', shape, flags = ''] = text.split('\n');
    const parts = nums.split(','), [follow, move, dual, texture] = flags.split(',');
    const raw: Record<string, unknown> = {
      shape: shape === 'square' || isAssetId(shape) ? shape : undefined, follow: follow === 'follow' || undefined, grainMove: move === 'move' || undefined,
      dual: dual || undefined, texture: texture || undefined,
    };
    BRUSH_FIELDS.forEach((f, i) => { if (parts[i] !== '' && parts[i] !== undefined) raw[f.key] = Number(parts[i]); });
    const params = cleanBrush(raw);
    const clean = (name ?? '').trim().slice(0, 30);
    return params && clean ? { name: clean, params } : null;
  } catch { return null; }
}
