import { Rect, ctx2d, makeCanvas, rectUnion } from './geom';

export const TILE = 256;

export type TileSnapshot = Map<string, ImageData | null>;

/**
 * A sparse, unbounded raster made of 256x256 tiles. Tiles are created lazily when painted,
 * which is what lets the "unlimited" canvas grow in any direction.
 */
export class TiledSurface {
  readonly tiles = new Map<string, HTMLCanvasElement>();

  static key(tx: number, ty: number) { return tx + ',' + ty; }
  static parse(k: string): [number, number] {
    const i = k.indexOf(',');
    return [+k.slice(0, i), +k.slice(i + 1)];
  }

  get(tx: number, ty: number) { return this.tiles.get(TiledSurface.key(tx, ty)); }

  ensure(tx: number, ty: number): HTMLCanvasElement {
    const k = TiledSurface.key(tx, ty);
    let t = this.tiles.get(k);
    if (!t) { t = makeCanvas(TILE, TILE); this.tiles.set(k, t); }
    return t;
  }

  /** Tile keys overlapping a document-space rect. */
  keysIn(r: Rect): string[] {
    const out: string[] = [];
    const tx0 = Math.floor(r.x / TILE), ty0 = Math.floor(r.y / TILE);
    const tx1 = Math.floor((r.x + r.w - 1e-6) / TILE), ty1 = Math.floor((r.y + r.h - 1e-6) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push(TiledSurface.key(tx, ty));
    return out;
  }

  /**
   * Run a drawing callback against every tile overlapping `r`. The context is translated so the
   * callback can draw in document coordinates.
   */
  draw(r: Rect, fn: (ctx: CanvasRenderingContext2D) => void, create = true) {
    for (const k of this.keysIn(r)) {
      const [tx, ty] = TiledSurface.parse(k);
      const t = create ? this.ensure(tx, ty) : this.get(tx, ty);
      if (!t) continue;
      const c = ctx2d(t);
      c.save();
      c.translate(-tx * TILE, -ty * TILE);
      fn(c);
      c.restore();
    }
  }

  /** Copy pixel data of the given tiles (null = tile did not exist). */
  snapshot(keys: Iterable<string>, into: TileSnapshot = new Map()): TileSnapshot {
    for (const k of keys) {
      if (into.has(k)) continue;
      const t = this.tiles.get(k);
      into.set(k, t ? ctx2d(t).getImageData(0, 0, TILE, TILE) : null);
    }
    return into;
  }

  /** Restore tiles from a snapshot. */
  restore(s: TileSnapshot) {
    for (const [k, data] of s) {
      if (!data) { this.tiles.delete(k); continue; }
      const [tx, ty] = TiledSurface.parse(k);
      ctx2d(this.ensure(tx, ty)).putImageData(data, 0, 0);
    }
  }

  /** Drop tiles in `keys` that are fully transparent. Snapshot data is reused when given. */
  prune(s: TileSnapshot) {
    for (const [k, data] of s) {
      if (data && isEmpty(data)) { this.tiles.delete(k); s.set(k, null); }
    }
  }

  /** Bounding rect of existing tiles (coarse, tile-aligned). */
  tileBounds(): Rect | null {
    let r: Rect | null = null;
    for (const k of this.tiles.keys()) {
      const [tx, ty] = TiledSurface.parse(k);
      r = rectUnion(r, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
    }
    return r;
  }

  /** Exact bounding rect of non-transparent pixels. */
  contentBounds(): Rect | null {
    let r: Rect | null = null;
    for (const [k, t] of this.tiles) {
      const [tx, ty] = TiledSurface.parse(k);
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
      if (x1 >= 0) r = rectUnion(r, { x: tx * TILE + x0, y: ty * TILE + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return r;
  }

  /** Draw tiles (optionally limited to a rect) onto ctx, which maps document space. */
  drawTo(ctx: CanvasRenderingContext2D, r?: Rect) {
    const keys = r ? this.keysIn(r) : [...this.tiles.keys()];
    for (const k of keys) {
      const t = this.tiles.get(k);
      if (!t) continue;
      const [tx, ty] = TiledSurface.parse(k);
      ctx.drawImage(t, tx * TILE, ty * TILE);
    }
  }

  /** Render a region of this surface into a new canvas of size r.w x r.h. */
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
    return s;
  }

  clear() { this.tiles.clear(); }
  get size() { return this.tiles.size; }
}

function isEmpty(d: ImageData) {
  const a = d.data;
  for (let i = 3; i < a.length; i += 4) if (a[i]) return false;
  return true;
}
