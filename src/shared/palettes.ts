// Colour palettes: saved sets of swatches, imported from Adobe .aco / .ase, Procreate .swatches, GIMP .gpl or plain hex lists.

export interface Palette { id: string; name: string; colors: string[] }

export const MAX_PALETTES = 40, MAX_PALETTE_COLORS = 256;
const HEX = /^#[0-9a-f]{6}$/;
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

export function hsvHex(h: number, s: number, v: number): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255; };
  return toHex(f(5), f(3), f(1));
}
const cmykHex = (c: number, m: number, y: number, k: number) => toHex(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k));
/** CIE L*a*b* (D50) to sRGB, close enough for swatches. */
function labHex(L: number, a: number, b: number) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.9642 * inv(fx), Y = inv(fy), Z = 0.8251 * inv(fz);
  const lin = [3.1339 * X - 1.617 * Y - 0.4906 * Z, -0.9785 * X + 1.916 * Y + 0.0333 * Z, 0.072 * X - 0.229 * Y + 1.4057 * Z];
  return toHex(...(lin.map((v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055)) as [number, number, number]));
}

/** Adobe Color: big-endian 16-bit colour space + four channels per swatch. */
export function parseAco(buf: ArrayBuffer): string[] {
  const v = new DataView(buf), out: string[] = [];
  if (buf.byteLength < 4) return out;
  const n = v.getUint16(2);
  let o = 4;
  for (let i = 0; i < n && o + 10 <= buf.byteLength; i++, o += 10) {
    const space = v.getUint16(o), w = v.getUint16(o + 2), x = v.getUint16(o + 4), y = v.getUint16(o + 6), z = v.getUint16(o + 8);
    if (space === 0) out.push(toHex(w / 257, x / 257, y / 257));
    else if (space === 1) out.push(hsvHex(w / 182.04, x / 65535, y / 65535));
    else if (space === 2) out.push(cmykHex(1 - w / 65535, 1 - x / 65535, 1 - y / 65535, 1 - z / 65535));
    else if (space === 7) out.push(labHex(w / 100, v.getInt16(o + 4) / 100, v.getInt16(o + 6) / 100));
    else if (space === 8) out.push(toHex(255 - w / 39.2, 255 - w / 39.2, 255 - w / 39.2));
  }
  return out;
}

/** Adobe Swatch Exchange: 'ASEF', then blocks of named colours in RGB, CMYK, Lab or Gray floats. */
export function parseAse(buf: ArrayBuffer): string[] {
  const v = new DataView(buf), out: string[] = [];
  if (buf.byteLength < 12 || v.getUint32(0) !== 0x41534546) return out;
  let o = 12;
  while (o + 6 <= buf.byteLength) {
    const type = v.getUint16(o), len = v.getUint32(o + 2);
    const body = o + 6;
    if (type === 0x0001 && body + 2 <= buf.byteLength) {
      const nameLen = v.getUint16(body), p = body + 2 + nameLen * 2;
      if (p + 4 <= buf.byteLength) {
        const model = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
        const f = (i: number) => v.getFloat32(p + 4 + i * 4);
        if (model === 'RGB ') out.push(toHex(f(0) * 255, f(1) * 255, f(2) * 255));
        else if (model === 'CMYK') out.push(cmykHex(f(0), f(1), f(2), f(3)));
        else if (model === 'LAB ') out.push(labHex(f(0) * 100, f(1), f(2)));
        else if (model === 'Gray') out.push(toHex(f(0) * 255, f(0) * 255, f(0) * 255));
      }
    }
    o = body + len;
  }
  return out;
}

/** GIMP palettes and plain text: any #rrggbb (or "r g b" rows) found. */
export function parseText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const hex = line.match(/#?\b([0-9a-fA-F]{6})\b/);
    const rgb = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\b/);
    if (rgb) out.push(toHex(+rgb[1], +rgb[2], +rgb[3]));
    else if (hex && (line.includes('#') || /^[0-9a-fA-F]{6}$/.test(line.trim()))) out.push('#' + hex[1].toLowerCase());
  }
  return out;
}

/** Procreate: a zip holding Swatches.json with HSB swatches. */
export async function parseSwatches(buf: ArrayBuffer): Promise<{ name: string; colors: string[] }[]> {
  const json = await zipEntry(buf, /Swatches\.json$/i);
  if (!json) return [];
  const data = JSON.parse(json) as { name?: string; swatches?: ({ hue: number; saturation: number; brightness: number } | null)[] }[];
  return (Array.isArray(data) ? data : [data]).map((p) => ({
    name: String(p.name ?? 'Procreate'),
    colors: (p.swatches ?? []).filter((s): s is NonNullable<typeof s> => !!s).map((s) => hsvHex(s.hue * 360, s.saturation, s.brightness)),
  }));
}

/** The text of the first zip entry whose name matches; stored or deflated entries only. */
async function zipEntry(buf: ArrayBuffer, name: RegExp): Promise<string | null> {
  const v = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = buf.byteLength - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  for (let i = 0; i < count && o + 46 <= buf.byteLength; i++) {
    if (v.getUint32(o, true) !== 0x02014b50) break;
    const method = v.getUint16(o + 10, true), csize = v.getUint32(o + 20, true), nlen = v.getUint16(o + 28, true), xlen = v.getUint16(o + 30, true), clen = v.getUint16(o + 32, true);
    const local = v.getUint32(o + 42, true), entry = new TextDecoder().decode(bytes.subarray(o + 46, o + 46 + nlen));
    o += 46 + nlen + xlen + clen;
    if (!name.test(entry)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) return new TextDecoder().decode(raw);
    if (method !== 8) return null;
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }
  return null;
}

/** Reads any supported palette file into one or more palettes. */
export async function importPaletteFile(file: File): Promise<{ name: string; colors: string[] }[]> {
  const base = file.name.replace(/\.[^.]+$/, '') || 'Palette', ext = file.name.split('.').pop()?.toLowerCase();
  const buf = await file.arrayBuffer();
  let sets: { name: string; colors: string[] }[];
  if (ext === 'swatches') sets = await parseSwatches(buf);
  else if (ext === 'aco') sets = [{ name: base, colors: parseAco(buf) }];
  else if (ext === 'ase') sets = [{ name: base, colors: parseAse(buf) }];
  else sets = [{ name: base, colors: parseText(new TextDecoder().decode(buf)) }];
  return sets.map((s) => ({ name: s.name, colors: [...new Set(s.colors)].slice(0, MAX_PALETTE_COLORS) })).filter((s) => s.colors.length);
}

export type Harmony = 'off' | 'complementary' | 'analogous' | 'triadic' | 'split' | 'tetradic' | 'shades';
export const HARMONIES: [Harmony, string][] = [['off', 'Off'], ['complementary', 'Complementary'], ['analogous', 'Analogous'], ['triadic', 'Triadic'], ['split', 'Split'], ['tetradic', 'Tetradic'], ['shades', 'Shades']];

/** Companions of a colour (given as HSV) under a harmony rule. */
export function harmonyColors(mode: Harmony, h: number, s: number, v: number): string[] {
  const rot = (...d: number[]) => d.map((x) => hsvHex((h + x + 360) % 360, s, v));
  switch (mode) {
    case 'complementary': return rot(180);
    case 'analogous': return rot(-30, 30);
    case 'triadic': return rot(120, 240);
    case 'split': return rot(150, 210);
    case 'tetradic': return rot(90, 180, 270);
    case 'shades': return [0.25, 0.5, 0.75, 1].map((k) => hsvHex(h, s, v * k)).concat([0.5, 0.25].map((k) => hsvHex(h, s * k, v)));
    default: return [];
  }
}
