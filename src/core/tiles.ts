import { Rect, ctx2d, makeCanvas, rectUnion } from './geom';

export const TILE = 256;

/**
 * Tiles as they were: a whole tile ("tx,ty", null for a tile that didn't exist) or only the part of
 * one an edit touched ("tx,ty@x,y", the pixels from that tile-local corner), so undo keeps a stroke's
 * footprint rather than every 256 px tile it crossed.
 */
export type TileSnapshot = Map<string, ImageData | null>;

/** A sparse raster of 256×256 tiles, created as they are painted. */
export class TiledSurface {
  readonly tiles = new Map<string, HTMLCanvasElement>();
  /** Painted bounds of each tile, tile-local; dropped whenever the tile may have been written. */
  private painted = new Map<string, Rect | null>();
  /** Tile-local bounds of everything drawn through `draw` or `mark`: a stroke buffer's footprint per tile. */
  readonly drawn = new Map<string, Rect>();

  /** `readback`: tiles read back every frame (a stroke's coverage) are kept on the CPU, where Safari reads them without a GPU stall. */
  constructor(private readonly readback = false) {}

  static key(tx: number, ty: number) { return tx + ',' + ty; }
  static parse(k: string): [number, number] {
    const i = k.indexOf(','), at = k.indexOf('@');
    return [+k.slice(0, i), +k.slice(i + 1, at < 0 ? undefined : at)];
  }
  /** The corner a partial snapshot key names, or (0, 0) for a whole tile. */
  static corner(k: string): [number, number] {
    const at = k.indexOf('@');
    if (at < 0) return [0, 0];
    const i = k.indexOf(',', at);
    return [+k.slice(at + 1, i), +k.slice(i + 1)];
  }
  static whole(k: string) { const at = k.indexOf('@'); return at < 0 ? k : k.slice(0, at); }

  get(tx: number, ty: number) { return this.tiles.get(TiledSurface.key(tx, ty)); }

  /** Callers that draw on a tile they got from `tiles` directly say so here. */
  touch(k: string) { this.painted.delete(k); this.drawn.delete(k); }

  /** Records that `r` (tile-local) of tile `k` was drawn on, for `footprint`. */
  mark(k: string, r: Rect) {
    const d = this.drawn.get(k);
    this.drawn.set(k, d ? rectUnion(d, r)! : { ...r });
  }

  /** Each tile's drawn area, whole pixels, as a snapshot key: "tx,ty@x,y" with its size, or the whole tile when unknown. */
  footprint(k: string): { key: string; w: number; h: number } {
    const d = this.drawn.get(k);
    if (!d) return { key: k, w: TILE, h: TILE };
    const x0 = Math.max(0, Math.floor(d.x)), y0 = Math.max(0, Math.floor(d.y));
    const x1 = Math.min(TILE, Math.ceil(d.x + d.w)), y1 = Math.min(TILE, Math.ceil(d.y + d.h));
    if (x1 - x0 >= TILE && y1 - y0 >= TILE) return { key: k, w: TILE, h: TILE };
    return { key: `${k}@${x0},${y0}`, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  /** The tile to draw on, made if missing; its cached bounds are dropped since the caller writes to it. */
  ensure(tx: number, ty: number): HTMLCanvasElement {
    const k = TiledSurface.key(tx, ty);
    this.painted.delete(k);
    let t = this.tiles.get(k);
    if (!t) {
      t = makeCanvas(TILE, TILE);
      if (this.readback) ctx2d(t, true); // the first getContext decides
      this.tiles.set(k, t);
    }
    return t;
  }

  keysIn(r: Rect): string[] {
    const out: string[] = [];
    const tx0 = Math.floor(r.x / TILE), ty0 = Math.floor(r.y / TILE);
    const tx1 = Math.floor((r.x + r.w - 1e-6) / TILE), ty1 = Math.floor((r.y + r.h - 1e-6) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push(TiledSurface.key(tx, ty));
    return out;
  }

  /** Draw on every tile overlapping `r`, in document coordinates. */
  draw(r: Rect, fn: (ctx: CanvasRenderingContext2D) => void, create = true) {
    for (const k of this.keysIn(r)) {
      const [tx, ty] = TiledSurface.parse(k);
      const t = create ? this.ensure(tx, ty) : this.get(tx, ty);
      if (!t) continue;
      this.painted.delete(k);
      this.mark(k, { x: r.x - tx * TILE, y: r.y - ty * TILE, w: r.w, h: r.h });
      const c = ctx2d(t);
      c.save();
      c.translate(-tx * TILE, -ty * TILE);
      fn(c);
      c.restore();
    }
  }

  /** Tiles as they are now. `parts` limits what is read of a tile (from `footprint`); a missing tile is recorded whole, as null. */
  snapshot(keys: Iterable<string>, into: TileSnapshot = new Map(), parts?: Map<string, { key: string; w: number; h: number }>): TileSnapshot {
    for (const k of keys) {
      const whole = TiledSurface.whole(k), t = this.tiles.get(whole);
      if (!t) { if (!into.has(whole)) into.set(whole, null); continue; }
      const p = parts?.get(k);
      if (p && p.key !== k) {
        if (into.has(p.key) || into.has(whole)) continue;
        const [x, y] = TiledSurface.corner(p.key);
        into.set(p.key, ctx2d(t).getImageData(x, y, p.w, p.h));
        continue;
      }
      if (into.has(k)) continue;
      const [x, y] = TiledSurface.corner(k);
      into.set(k, k === whole ? ctx2d(t).getImageData(0, 0, TILE, TILE) : ctx2d(t).getImageData(x, y, Math.min(TILE - x, p?.w ?? TILE - x), Math.min(TILE - y, p?.h ?? TILE - y)));
    }
    return into;
  }

  restore(s: TileSnapshot) {
    for (const [k, data] of s) {
      const whole = TiledSurface.whole(k);
      this.painted.delete(whole);
      this.drawn.delete(whole);
      if (!data) { this.tiles.delete(whole); continue; }
      const [tx, ty] = TiledSurface.parse(k), [x, y] = TiledSurface.corner(k);
      ctx2d(this.ensure(tx, ty)).putImageData(data, x, y);
    }
  }

  /** Drops tiles that came out blank; `keys` are whole tiles. */
  prune(keys: Iterable<string>) {
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (t && isEmpty(ctx2d(t).getImageData(0, 0, TILE, TILE))) this.tiles.delete(k);
    }
  }

  tileBounds(): Rect | null {
    let r: Rect | null = null;
    for (const k of this.tiles.keys()) {
      const [tx, ty] = TiledSurface.parse(k);
      r = rectUnion(r, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
    }
    return r;
  }

  /** Bounds of the painted pixels. Each tile is read back once and cached until it is drawn on again. */
  contentBounds(): Rect | null {
    let r: Rect | null = null;
    for (const [k, t] of this.tiles) {
      let b = this.painted.get(k);
      if (b === undefined) this.painted.set(k, b = paintedIn(t));
      if (!b) continue;
      const [tx, ty] = TiledSurface.parse(k);
      r = rectUnion(r, { x: tx * TILE + b.x, y: ty * TILE + b.y, w: b.w, h: b.h });
    }
    return r;
  }

  drawTo(ctx: CanvasRenderingContext2D, r?: Rect) {
    const keys = r ? this.keysIn(r) : [...this.tiles.keys()];
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (!t) continue;
      const [tx, ty] = TiledSurface.parse(k);
      ctx.drawImage(t, tx * TILE, ty * TILE);
    }
  }

  extract(r: Rect): HTMLCanvasElement {
    const c = makeCanvas(r.w, r.h);
    const ctx = ctx2d(c);
    ctx.translate(-r.x, -r.y);
    this.drawTo(ctx, r);
    return c;
  }

  clone(): TiledSurface {
    const s = new TiledSurface();
    for (const [k, t] of this.tiles) {
      const c = makeCanvas(TILE, TILE);
      ctx2d(c).drawImage(t, 0, 0);
      s.tiles.set(k, c);
    }
    for (const [k, b] of this.painted) s.painted.set(k, b);
    return s;
  }

  clear() { this.tiles.clear(); this.painted.clear(); this.drawn.clear(); }
  get size() { return this.tiles.size; }
}

function isEmpty(d: ImageData) {
  const a = d.data;
  for (let i = 3; i < a.length; i += 4) if (a[i]) return false;
  return true;
}

function paintedIn(t: HTMLCanvasElement): Rect | null {
  const d = ctx2d(t).getImageData(0, 0, TILE, TILE).data;
  let x0 = TILE, y0 = TILE, x1 = -1, y1 = -1;
  for (let y = 0; y < TILE; y++) {
    const row = y * TILE * 4;
    for (let x = 0; x < TILE; x++) {
      if (d[row + x * 4 + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
}
