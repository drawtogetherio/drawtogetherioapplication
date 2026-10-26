// Photoshop .abr brush files: versions 1 and 2 (sampled and computed tips) and 6+ (8BIM blocks with a descriptor per brush).
import type { BrushParams } from '../core/model';

/** 8-bit coverage, 255 where the tip paints. `detect` flips a picture whose border is light (painted black on white); `flip` inverts after that. */
export interface RawTip { w: number; h: number; data: Uint8Array; detect?: true; flip?: boolean }
export interface ImportedBrush { name: string; params: Partial<BrushParams>; tip?: RawTip; dual?: RawTip; grain?: RawTip }

const MAX_BRUSHES = 200, MAX_TIP_PX = 4096;
const dec = new TextDecoder('utf-16be'), ascii = new TextDecoder('latin1');

class R {
  p = 0;
  dv: DataView;
  constructor(public b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  get left() { return this.b.length - this.p; }
  u8() { return this.b[this.p++]; }
  i16() { const v = this.dv.getInt16(this.p); this.p += 2; return v; }
  u16() { const v = this.dv.getUint16(this.p); this.p += 2; return v; }
  i32() { const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  u32() { const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p); this.p += 8; return v; }
  str(n: number) { const s = ascii.decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
  /** Pascal string: length byte, bytes, padded to even. */
  pstr() { const n = this.u8(); const s = this.str(n); if ((n + 1) & 1) this.p++; return s; }
  /** UTF-16 string: uint32 length in characters, including a trailing NUL. */
  ustr() { const n = this.u32(); const s = dec.decode(this.b.subarray(this.p, this.p + n * 2)); this.p += n * 2; return s.replace(/\0+$/, ''); }
  /** Descriptor key: uint32 length (0 means 4), then ASCII. */
  key() { const n = this.u32() || 4; return this.str(n); }
  sub(n: number) { if (n < 0 || n > this.left) throw new Error('Damaged brush file'); const r = new R(this.b.subarray(this.p, this.p + n)); this.p += n; return r; }
}

function pixels(r: R, w: number, h: number, depth: number, compressed: boolean): RawTip {
  if (w <= 0 || h <= 0 || w > MAX_TIP_PX || h > MAX_TIP_PX) throw new Error('Damaged brush file');
  const data = new Uint8Array(w * h);
  if (!compressed) {
    if (depth === 16) for (let i = 0; i < data.length; i++) data[i] = r.u16() >> 8;
    else for (let i = 0; i < data.length; i++) data[i] = r.u8();
    return { w, h, data };
  }
  const lens: number[] = [];
  for (let y = 0; y < h; y++) lens.push(r.i16());
  let o = 0;
  for (let y = 0; y < h; y++) {
    const end = r.p + lens[y];
    while (r.p < end && o < data.length) {
      const n = r.u8();
      if (n < 128) { for (let i = 0; i <= n && o < data.length; i++) data[o++] = r.u8(); }
      else if (n > 128) { const v = r.u8(); for (let i = 0; i < 257 - n && o < data.length; i++) data[o++] = v; }
    }
    r.p = end;
  }
  return { w, h, data };
}

// ---- Versions 1 and 2 ----

function parseOld(r: R, version: number): ImportedBrush[] {
  const count = r.u16(), out: ImportedBrush[] = [];
  for (let i = 0; i < count && i < MAX_BRUSHES; i++) {
    const type = r.u16(), size = r.u32();
    const b = r.sub(size);
    if (type === 1) {
      b.i32(); const spacing = b.i16(), diameter = b.i16(), roundness = b.i16(), angle = b.i16(), hardness = b.i16();
      out.push({ name: `Brush ${i + 1}`, params: computed(diameter, hardness / 100, spacing / 100, angle, roundness / 100) });
    } else if (type === 2) {
      b.i32(); const spacing = b.i16();
      const name = version === 2 ? b.ustr() : `Brush ${i + 1}`;
      b.u8();
      b.p += 8; // short bounds
      const top = b.i32(), left = b.i32(), bottom = b.i32(), right = b.i32(), depth = b.i16(), compress = b.u8();
      const tip = pixels(b, right - left, bottom - top, depth, compress === 1);
      out.push({ name, params: { size: Math.min(500, Math.max(tip.w, tip.h)), spacing: spacing / 100 }, tip });
    }
  }
  return out;
}

// ---- Version 6+: descriptors ----

type Desc = { [k: string]: unknown };

function readValue(r: R, type: string, depth: number): unknown {
  if (depth > 32) throw new Error('Damaged brush file');
  switch (type) {
    case 'obj ': { const n = r.u32(); for (let i = 0; i < n; i++) { const t = r.str(4); if (t === 'prop') { r.ustr(); r.key(); r.key(); } else if (t === 'Clss') { r.ustr(); r.key(); } else if (t === 'Enmr') { r.ustr(); r.key(); r.key(); r.key(); } else if (t === 'rele') r.u32(); else if (t === 'Idnt' || t === 'indx') r.u32(); else if (t === 'name') r.ustr(); } return null; }
    case 'Objc': case 'GlbO': return readDesc(r, depth + 1);
    case 'VlLs': { const n = r.u32(), a: unknown[] = []; for (let i = 0; i < n; i++) a.push(readValue(r, r.str(4), depth + 1)); return a; }
    case 'doub': return r.f64();
    case 'UntF': { const unit = r.str(4), v = r.f64(); return { unit, v }; }
    case 'TEXT': return r.ustr();
    case 'enum': { r.key(); return r.key(); }
    case 'long': return r.i32();
    case 'comp': return Number(r.dv.getBigInt64((r.p += 8) - 8));
    case 'bool': return r.u8() !== 0;
    case 'type': case 'GlbC': r.ustr(); r.key(); return null;
    case 'alis': { const n = r.u32(); r.p += n; return null; }
    case 'tdta': { const n = r.u32(); return r.sub(n).b; }
    default: throw new Error('Damaged brush file');
  }
}

function readDesc(r: R, depth: number): Desc {
  r.ustr(); // class name
  const cls = r.key(), n = r.u32(), d: Desc = { _class: cls };
  for (let i = 0; i < n; i++) { const k = r.key(); d[k] = readValue(r, r.str(4), depth); }
  return d;
}

const num = (v: unknown) => (typeof v === 'number' ? v : v && typeof v === 'object' && 'v' in v ? Number((v as { v: number }).v) : NaN);
const pct = (v: unknown) => { const n = num(v); return Number.isFinite(n) ? n / 100 : NaN; };
const bool = (v: unknown) => v === true;
const obj = (v: unknown): Desc => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Desc) : {});

function computed(diameter: number, hardness: number, spacing: number, angle: number, roundness: number): Partial<BrushParams> {
  const p: Partial<BrushParams> = { size: diameter, hardness, spacing };
  if (angle) p.angle = ((angle % 360) + 360) % 360;
  if (roundness < 0.98) p.hardness = Math.min(hardness, 0.95); // a squashed tip is approximated by a slightly softer round one
  return p;
}

function fromDesc(d: Desc, samples: Map<string, RawTip>): ImportedBrush | null {
  const brush = obj(d.Brsh);
  if (!brush._class) return null;
  const p: Partial<BrushParams> = {};
  const name = typeof d['Nm  '] === 'string' ? d['Nm  '] : '';
  const spacing = pct(d.Spcn);
  if (Number.isFinite(spacing)) p.spacing = spacing;
  const diameter = num(brush.Dmtr), hardness = pct(brush.Hrdn), angle = num(brush.Angl), roundness = pct(brush.Rndn);
  if (Number.isFinite(diameter)) p.size = diameter;
  let tip: RawTip | undefined;
  if (brush._class === 'computedBrush') Object.assign(p, computed(Number.isFinite(diameter) ? diameter : 20, Number.isFinite(hardness) ? hardness : 1, Number.isFinite(spacing) ? spacing : 0.25, Number.isFinite(angle) ? angle : 0, Number.isFinite(roundness) ? roundness : 1));
  else {
    tip = samples.get(String(obj(brush.sampledData) && brush.sampledData));
    if (Number.isFinite(angle) && angle) p.angle = ((angle % 360) + 360) % 360;
  }
  if (bool(d.useTipDynamics)) {
    const j = pct(obj(d.szVr).jitter); if (j > 0) p.sizeJitter = j;
    const a = pct(obj(d.angleDynamics).jitter); if (a > 0) p.angleJitter = a;
    const mn = pct(d.minimumDiameter); if (Number.isFinite(mn)) p.minSize = mn;
    if (obj(d.szVr).bVTy === 'prsr' || obj(d.szVr).bVTy === 'pressure') p.pressureSize = 1;
    if (obj(d.angleDynamics).bVTy === 'drct' || obj(d.angleDynamics).bVTy === 'direction') p.follow = true;
  }
  if (bool(d.useScatter)) {
    const s = pct(obj(d.scatterDynamics).jitter); if (s > 0) p.scatter = Math.min(2, s * 2);
  }
  if (bool(d.useTexture)) {
    const depth = pct(d.textureDepth); p.grain = Number.isFinite(depth) ? Math.min(1, depth) : 0.5;
    const sc = pct(d.textureScale); if (Number.isFinite(sc) && sc > 0) p.grainScale = Math.min(8, Math.max(0.25, sc));
  }
  let dual: RawTip | undefined;
  const db = obj(d.dualBrush);
  if (bool(db.useDualBrush)) {
    const b2 = obj(db.Brsh);
    dual = samples.get(String(b2.sampledData));
    const d2 = num(b2.Dmtr); if (dual && Number.isFinite(d2) && Number.isFinite(diameter) && diameter > 0) p.dualScale = Math.min(4, Math.max(0.1, d2 / diameter));
  }
  if (bool(d.useColorDynamics)) {
    const hue = pct(d['H   ']); if (hue > 0) p.hueJitter = hue;
    const sat = pct(d.Strt); if (sat > 0) p.satJitter = sat;
    const br = pct(d.Brgh); if (br > 0) p.brightJitter = br;
  }
  if (bool(d.usePaintDynamics)) {
    const fl = pct(obj(d.flow ?? d.opVr).jitter); if (fl > 0) p.flowJitter = fl;
    if (obj(d.prVr).bVTy === 'prsr' || obj(d.opVr).bVTy === 'prsr') p.pressureFlow = 1;
    const wet = pct(d.wtVr ?? d.Wtns); if (wet > 0) p.wet = Math.min(1, wet);
  }
  return { name, params: p, tip, dual };
}

function parseNew(r: R): ImportedBrush[] {
  const minor = r.u16();
  const samples = new Map<string, RawTip>(), descs: Desc[] = [];
  while (r.left >= 12) {
    if (r.str(4) !== '8BIM') throw new Error('Damaged brush file');
    const type = r.str(4), size = r.u32();
    const block = r.sub(size);
    r.p += (4 - (size & 3)) & 3;
    if (type === 'samp') {
      while (block.left >= 4 && samples.size < MAX_BRUSHES) {
        const len = block.u32(), s = block.sub(Math.min(block.left, (len + 3) & ~3));
        const id = s.pstr();
        s.p += minor === 1 ? 10 : 264;
        const top = s.i32(), left = s.i32(), bottom = s.i32(), right = s.i32(), depth = s.i16(), compress = s.u8();
        samples.set(id, pixels(s, right - left, bottom - top, depth, compress === 1));
      }
    } else if (type === 'desc') {
      block.u32(); // descriptor version
      const d = readDesc(block, 0), list = Array.isArray(d.Brsh) ? d.Brsh as unknown[] : [];
      for (const b of list) descs.push(obj(b));
    }
  }
  const out: ImportedBrush[] = [];
  for (const d of descs.slice(0, MAX_BRUSHES)) { const b = fromDesc(d, samples); if (b) out.push(b); }
  // Files with only samples (some third-party packs) still give usable tips.
  if (!out.length) for (const [id, tip] of samples) out.push({ name: id.slice(0, 8), params: { size: Math.min(500, Math.max(tip.w, tip.h)), spacing: 0.25 }, tip });
  return out;
}

export function parseAbr(bytes: Uint8Array): ImportedBrush[] {
  const r = new R(bytes);
  const version = r.u16();
  if (version === 1 || version === 2) return parseOld(r, version);
  if (version >= 6 && version <= 10) return parseNew(r);
  throw new Error('Not a Photoshop brush file');
}
