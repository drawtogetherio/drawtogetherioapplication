// Brush parameter ranges and the shareable brush code, used by the client and the server.
import type { BrushParams } from '../core/model';

/** Numbers (x, y, pressure) one stroke op may carry; longer strokes are split. */
export const MAX_STROKE_PTS = 120_000;

export const MAX_BRUSH_SIZE = 500;

/** Every slider in the brush editor, in share-code order. */
export const BRUSH_FIELDS: { key: keyof BrushParams & string; label: string; min: number; max: number; pct?: boolean }[] = [
  { key: 'size', label: 'Size', min: 0.1, max: MAX_BRUSH_SIZE },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, pct: true },
  { key: 'flow', label: 'Flow', min: 0, max: 1, pct: true },
  { key: 'hardness', label: 'Hardness', min: 0, max: 1, pct: true },
  { key: 'spacing', label: 'Spacing', min: 0.01, max: 4, pct: true },
  { key: 'pressureSize', label: 'Pressure → size', min: 0, max: 1, pct: true },
  { key: 'pressureFlow', label: 'Pressure → flow', min: 0, max: 1, pct: true },
  { key: 'minSize', label: 'Min size', min: 0, max: 1, pct: true },
  { key: 'smoothing', label: 'Smoothing', min: 0, max: 1, pct: true },
  { key: 'grain', label: 'Grain', min: 0, max: 1, pct: true },
  { key: 'grainScale', label: 'Grain scale', min: 0.25, max: 8 },
];

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function validBrush(b: unknown): b is BrushParams {
  if (!b || typeof b !== 'object') return false;
  const r = b as Record<string, unknown>;
  for (const f of BRUSH_FIELDS) {
    const v = r[f.key];
    if (v === undefined && (f.key === 'grain' || f.key === 'grainScale')) continue;
    if (!num(v, f.min, f.max)) return false;
  }
  return r.shape === undefined || r.shape === 'round' || r.shape === 'square';
}

/** The same brush with only the known fields, rounded so it stays small when saved. */
export function cleanBrush(b: unknown): BrushParams | null {
  if (!validBrush(b)) return null;
  const out = {} as Record<string, unknown>;
  for (const f of BRUSH_FIELDS) if (b[f.key] !== undefined) out[f.key] = Math.round((b[f.key] as number) * 1000) / 1000;
  if (b.shape === 'square') out.shape = 'square';
  return out as unknown as BrushParams;
}

const CODE_PREFIX = 'hive-';

/** A brush as text friends can paste in: hive- followed by base64url of "name\nnumbers". */
export function brushCode(name: string, p: BrushParams): string {
  const nums = BRUSH_FIELDS.map((f) => (p[f.key] as number | undefined) ?? '');
  const text = `${name}\n${nums.join(',')}\n${p.shape === 'square' ? 'square' : 'round'}`;
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
    const [name, nums = '', shape] = text.split('\n');
    const parts = nums.split(',');
    const raw: Record<string, unknown> = { shape: shape === 'square' ? 'square' : undefined };
    BRUSH_FIELDS.forEach((f, i) => { if (parts[i] !== '' && parts[i] !== undefined) raw[f.key] = Number(parts[i]); });
    const params = cleanBrush(raw);
    const clean = (name ?? '').trim().slice(0, 30);
    return params && clean ? { name: clean, params } : null;
  } catch { return null; }
}
