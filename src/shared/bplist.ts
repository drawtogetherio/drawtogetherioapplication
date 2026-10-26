// Apple binary property lists (bplist00), enough to read a Procreate brush archive.

export type Plist = null | boolean | number | string | Uint8Array | Plist[] | { [k: string]: Plist } | Uid;
export class Uid { constructor(public n: number) {} }

const MAX_OBJECTS = 200_000;

export function parseBplist(bytes: Uint8Array): Plist {
  if (bytes.length < 40 || String.fromCharCode(...bytes.subarray(0, 6)) !== 'bplist') throw new Error('Not a binary plist');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = bytes.length - 32;
  const offSize = bytes[t + 6], refSize = bytes[t + 7];
  const count = Number(dv.getBigUint64(t + 8)), root = Number(dv.getBigUint64(t + 16)), table = Number(dv.getBigUint64(t + 24));
  if (count > MAX_OBJECTS || table + count * offSize > t) throw new Error('Damaged plist');
  const uint = (p: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + bytes[p + i]; return v; };
  const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offSize, offSize));
  const cache = new Map<number, Plist>();
  const dec = new TextDecoder();

  const read = (idx: number, depth: number): Plist => {
    if (idx >= count || depth > 64) throw new Error('Damaged plist');
    if (cache.has(idx)) return cache.get(idx)!;
    let p = offsets[idx];
    if (p >= t) throw new Error('Damaged plist');
    const m = bytes[p++], type = m >> 4;
    let n = m & 15;
    // A length of 15 means an int object follows inline.
    const inlineInt = () => { const mm = bytes[p++]; const k = 1 << (mm & 15); const v = uint(p, k); p += k; return v; };
    let out: Plist;
    switch (type) {
      case 0: out = m === 8 ? false : m === 9 ? true : null; break;
      case 1: { const k = 1 << n; out = k === 8 ? Number(dv.getBigInt64(p)) : uint(p, k); p += k; break; }
      case 2: out = n === 2 ? dv.getFloat32(p) : dv.getFloat64(p); break;
      case 3: out = dv.getFloat64(p) * 1000 + 978307200000; break;
      case 4: { if (n === 15) n = inlineInt(); out = bytes.slice(p, p + n); break; }
      case 5: { if (n === 15) n = inlineInt(); out = dec.decode(bytes.subarray(p, p + n)); break; }
      case 6: { if (n === 15) n = inlineInt(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + i * 2)); out = s; break; }
      case 8: out = new Uid(uint(p, n + 1)); break;
      case 10: case 12: { if (n === 15) n = inlineInt(); const arr: Plist[] = []; for (let i = 0; i < n; i++) arr.push(read(uint(p + i * refSize, refSize), depth + 1)); out = arr; break; }
      case 13: {
        if (n === 15) n = inlineInt();
        const o: { [k: string]: Plist } = {};
        for (let i = 0; i < n; i++) {
          const k = read(uint(p + i * refSize, refSize), depth + 1);
          o[String(k)] = read(uint(p + (n + i) * refSize, refSize), depth + 1);
        }
        out = o; break;
      }
      default: throw new Error('Damaged plist');
    }
    cache.set(idx, out);
    return out;
  };
  return read(root, 0);
}

/** Resolves an NSKeyedArchiver plist into plain objects: UIDs followed, NS.objects/NS.keys unwrapped, $class dropped. */
export function unarchive(bytes: Uint8Array): Plist {
  const top = parseBplist(bytes) as { [k: string]: Plist };
  if (!top || top.$archiver !== 'NSKeyedArchiver' || !Array.isArray(top.$objects)) throw new Error('Not a keyed archive');
  const objs = top.$objects as Plist[];
  const seen = new Map<number, Plist>();
  const res = (v: Plist, depth: number): Plist => {
    if (depth > 64) return null;
    if (v instanceof Uid) {
      if (seen.has(v.n)) return seen.get(v.n)!;
      const o = objs[v.n];
      if (o === '$null') return null;
      seen.set(v.n, null);
      const r = res(o, depth + 1);
      seen.set(v.n, r);
      return r;
    }
    if (Array.isArray(v)) return v.map((x) => res(x, depth + 1));
    if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
      const o = v as { [k: string]: Plist };
      if (Array.isArray(o['NS.objects'])) {
        const items = (o['NS.objects'] as Plist[]).map((x) => res(x, depth + 1));
        if (!Array.isArray(o['NS.keys'])) return items;
        const keys = (o['NS.keys'] as Plist[]).map((x) => res(x, depth + 1));
        const d: { [k: string]: Plist } = {};
        keys.forEach((k, i) => { d[String(k)] = items[i]; });
        return d;
      }
      if (o['NS.string'] !== undefined) return res(o['NS.string'], depth + 1);
      if (o['NS.data'] !== undefined) return res(o['NS.data'], depth + 1);
      const d: { [k: string]: Plist } = {};
      for (const k in o) if (k !== '$class') d[k] = res(o[k], depth + 1);
      return d;
    }
    return v;
  };
  const root = (top.$top as { [k: string]: Plist })?.root;
  return res(root ?? new Uid(1), 0);
}
