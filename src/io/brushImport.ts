// Brushes from other apps: Photoshop .abr, Procreate .brush and .brushset. Tips and grains become assets.
import type { BrushParams } from '../core/model';
import { ctx2d, makeCanvas } from '../core/geom';
import { importAssetImage } from '../engine/brushAssets';
import { MAX_BRUSH_SIZE, cleanBrush } from '../shared/brush';
import { ImportedBrush, RawTip, parseAbr } from '../shared/abr';
import { unarchive } from '../shared/bplist';
import { unzip } from '../shared/hivecanvas';
import { inflate } from './hivecanvas';

export interface ImportedParams { name: string; params: BrushParams }

const base: BrushParams = { size: 20, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: 0.6, pressureFlow: 0, minSize: 0.1, smoothing: 0.3 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MAX_IMPORT = 60;

/** Everything in the file Doodlehive can turn into a brush; an empty list when it holds none. */
export async function importBrushFile(file: File): Promise<ImportedParams[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const raws = bytes[0] === 0x50 && bytes[1] === 0x4b ? await procreate(bytes) : parseAbr(bytes);
  const out: ImportedParams[] = [];
  for (const b of raws.slice(0, MAX_IMPORT)) {
    const p: Record<string, unknown> = { ...base, ...b.params };
    const shape = b.tip && await importAssetImage(tipCanvas(b.tip));
    if (shape) p.shape = shape;
    const dual = b.dual && await importAssetImage(tipCanvas(b.dual));
    if (dual) { p.dual = dual; p.dualScale ??= 1; }
    const grain = b.grain && await importAssetImage(tipCanvas(b.grain));
    if (grain) { p.texture = grain; p.grain ??= 0.5; }
    p.size = clamp(Math.round((p.size as number) * 10) / 10, 1, MAX_BRUSH_SIZE);
    for (const k in p) if (typeof p[k] === 'number' && !Number.isFinite(p[k] as number)) delete p[k];
    const params = cleanBrush(p) ?? cleanBrush(fit(p));
    if (params) out.push({ name: (b.name || 'Imported brush').trim().slice(0, 30), params });
  }
  return out;
}

/** Ranges from other apps don't all match ours; pull each number into its slider's range. */
function fit(p: Record<string, unknown>) {
  const r = { ...p };
  const lim: Record<string, [number, number]> = { spacing: [0.01, 4], grainScale: [0.25, 8], dualScale: [0.1, 4], scatter: [0, 2], angle: [0, 360] };
  for (const k in r) {
    const v = r[k];
    if (typeof v !== 'number') continue;
    const [lo, hi] = lim[k] ?? [0, 1];
    r[k] = clamp(v, lo, hi);
  }
  return r;
}

/** An 8-bit coverage tip as an opaque grey picture, white where it paints. */
function tipCanvas(t: RawTip): HTMLCanvasElement {
  const c = makeCanvas(t.w, t.h), ctx = ctx2d(c, true), img = ctx.createImageData(t.w, t.h), d = img.data;
  let border = 0, n = 0;
  for (let x = 0; x < t.w; x++) { border += t.data[x] + t.data[(t.h - 1) * t.w + x]; n += 2; }
  for (let y = 0; y < t.h; y++) { border += t.data[y * t.w] + t.data[y * t.w + t.w - 1]; n += 2; }
  const inv = (!!t.detect && border / n > 128) !== !!t.flip;
  for (let i = 0; i < t.data.length; i++) { const v = inv ? 255 - t.data[i] : t.data[i]; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---- Procreate ----

type Dict = { [k: string]: unknown };
const num = (d: Dict, k: string) => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? (d[k] as number) : NaN);
const has = (v: number) => Number.isFinite(v);

async function procreate(bytes: Uint8Array): Promise<ImportedBrush[]> {
  const files = await unzip(bytes, inflate);
  const dirs = new Map<string, Map<string, Uint8Array>>();
  for (const [name, data] of files) {
    const parts = name.split('/'), dir = parts.slice(0, -1).join('/'), leaf = parts[parts.length - 1];
    if (!dirs.has(dir)) dirs.set(dir, new Map());
    dirs.get(dir)!.set(leaf, data);
  }
  const out: ImportedBrush[] = [];
  for (const [dir, f] of dirs) {
    const archive = f.get('Brush.archive');
    if (!archive || /(^|\/)(Reset|Sub01|Signature|QuickLook)(\/|$)/.test(dir)) continue;
    let b: ImportedBrush;
    try { b = await procreateBrush(unarchive(archive) as Dict, f); } catch { continue; }
    const sub = dirs.get((dir ? dir + '/' : '') + 'Sub01');
    const subShape = sub?.get('Shape.png');
    if (subShape) { const t = await pngTip(subShape); if (t) b.dual = t; }
    if (!b.name) b.name = dir.split('/').pop() || 'Procreate brush';
    out.push(b);
  }
  return out;
}

async function procreateBrush(a: Dict, f: Map<string, Uint8Array>): Promise<ImportedBrush> {
  const p: Partial<BrushParams> = {};
  const name = typeof a.name === 'string' ? a.name : '';
  const size = num(a, 'paintSize'), spacing = num(a, 'plotSpacing'), opacity = num(a, 'paintOpacity');
  if (has(size)) p.size = 1 + clamp(size, 0, 1) ** 2 * 500;
  if (has(spacing)) p.spacing = clamp(Math.sqrt(clamp(spacing, 0, 16)), 0.01, 4);
  if (has(opacity)) p.opacity = clamp(opacity, 0, 1);
  const flow = num(a, 'paintFlow'); if (has(flow)) p.flow = clamp(flow, 0.05, 1);
  const smooth = num(a, 'plotSmoothing'); if (has(smooth)) p.smoothing = clamp(smooth, 0, 1);
  const pSize = num(a, 'dynamicsPressureSize'); if (has(pSize)) p.pressureSize = clamp(pSize, 0, 1);
  const pFlow = num(a, 'dynamicsPressureOpacity'); if (has(pFlow)) p.pressureFlow = clamp(pFlow, 0, 1);
  const minSize = num(a, 'minSize'); if (has(minSize)) p.minSize = clamp(minSize, 0, 1);
  const scatter = num(a, 'shapeScatter'), jitter = num(a, 'plotJitter');
  if (has(scatter) && scatter > 0) p.scatter = clamp(scatter * 2, 0, 2); else if (has(jitter) && jitter > 0) p.scatter = clamp(jitter, 0, 2);
  const rot = num(a, 'shapeRotation'); if (has(rot) && rot > 0.5) p.follow = true;
  const rnd = num(a, 'shapeRandomise'); if (has(rnd) && rnd > 0) p.angleJitter = clamp(rnd, 0, 1);
  const jit = (k: string, key: keyof BrushParams) => { const v = num(a, k); if (has(v) && v > 0) (p as Record<string, number>)[key] = clamp(v, 0, 1); };
  jit('dynamicsJitterSize', 'sizeJitter'); jit('dynamicsJitterOpacity', 'flowJitter'); jit('dynamicsJitterHue', 'hueJitter'); jit('dynamicsJitterSaturation', 'satJitter');
  const dark = num(a, 'dynamicsJitterDarkness'), light = num(a, 'dynamicsJitterLightness');
  const bright = Math.max(has(dark) ? dark : 0, has(light) ? light : 0); if (bright > 0) p.brightJitter = clamp(bright, 0, 1);
  const tilt = Math.max(num(a, 'dynamicsTiltSize') || 0, num(a, 'dynamicsTiltOpacity') || 0); if (tilt > 0) p.tilt = clamp(tilt, 0, 1);
  const wet = Math.max(num(a, 'wetMixPull') || 0, num(a, 'wetMixDilution') || 0, num(a, 'dynamicsWetMix') || 0); if (wet > 0) p.wet = clamp(wet, 0, 1);
  const depth = num(a, 'grainDepth'), gScale = num(a, 'grainScale'), gMove = num(a, 'grainMovement');
  const b: ImportedBrush = { name, params: p };
  const shape = f.get('Shape.png');
  if (shape) { const t = await pngTip(shape); if (t) { t.detect = true; t.flip = a.shapeInverted === true; b.tip = t; } }
  const grain = f.get('Grain.png');
  if (grain && !(has(depth) && depth <= 0)) {
    const t = await pngTip(grain);
    if (t) {
      b.grain = t;
      p.grain = has(depth) ? clamp(depth, 0.05, 1) : 0.5;
      if (has(gScale)) p.grainScale = clamp(0.25 + gScale * 3, 0.25, 8);
      if (has(gMove) && gMove > 0.5) p.grainMove = true;
    }
  }
  return b;
}

/** A PNG's luminance as a tip, 256 px at most. */
async function pngTip(bytes: Uint8Array): Promise<RawTip | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
    const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = makeCanvas(w, h), ctx = ctx2d(c, true);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data, data = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = Math.round((d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) * d[i * 4 + 3] / 255);
    return { w, h, data };
  } catch { return null; }
}
