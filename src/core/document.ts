import { Rect, ctx2d, makeCanvas, rectFromPoints, rectIntersect, rectRoundOut, rectUnion, selPath, uid } from './geom';
import { History } from './history';
import { DocSettings, FolderProps, LayerProps, Op, blendOp } from './model';
import { TILE, TiledSurface, TileSnapshot } from './tiles';
import { TILES_PER_OP } from '../shared/hivecanvas';
import { renderStroke } from '../engine/brush';
import { applyEffect, effectReach } from '../engine/effects';
import { renderSmudge, smudgeKeys } from '../engine/smudge';
import { renderShape } from '../engine/shapes';
import { enclosedFill, floodFill, maskCanvas, polyFill, polyMask } from '../engine/fill';
import { effectImage, enclosedFillMask, fillMask } from '../engine/offload';
import { renderRegion } from '../engine/compositor';
import { clearSelection, floatingBounds, liftSelection, placeFloating, selectionBounds } from '../engine/transform';

export interface Layer { kind: 'layer'; props: LayerProps; surface: TiledSurface; mask: TiledSurface | null; parent: string | null; shown: boolean }
export interface Folder { kind: 'folder'; props: FolderProps; parent: string | null; shown: boolean }
export type DocNode = Layer | Folder;

export interface DocChange {
  rect: Rect | null;
  structure?: boolean;
  /** The layer whose pixels (or mask) changed, when only pixels did. */
  pixels?: string;
}

export interface ApplyOptions {
  /** Pixels already rendered by the live preview. */
  buffer?: TiledSurface;
  /** False for other people's ops: no undo information is kept. */
  record?: boolean;
  /** The edit is already on the layer; these are the tiles as they were before it. */
  applied?: TileSnapshot;
  /** A fill worked out ahead of time (see `prepare`); null when it found nothing to fill. */
  fill?: HTMLCanvasElement | null;
  /** An effect worked out ahead of time: the processed pixels of `region`. */
  effect?: { region: Rect; img: ImageData } | null;
}

type TilesOp = Extract<Op, { t: 'tiles' }>;
type FillOp = Extract<Op, { t: 'fill' | 'fillPoly' }>;
type EffectOp = Extract<Op, { t: 'effect' }>;

/** A tree of folders and layers. apply() is deterministic and returns the ops that undo it, so undo syncs like any edit. */
export class DrawDoc {
  readonly nodes = new Map<string, DocNode>();
  private kids = new Map<string, string[]>();
  layers: Layer[] = [];
  readonly history = new History();
  /** Counts applied ops, so work prepared from the canvas can tell when it has gone stale. */
  rev = 0;
  readonly log: Op[] = [];
  private listeners = new Set<(c: DocChange) => void>();
  private record = true;

  constructor(public settings: DocSettings) {}

  static create(opts: { width: number; height: number; infinite: boolean; background: string | null }, firstLayer = true): DrawDoc {
    const doc = new DrawDoc({ id: uid('doc_'), ...opts });
    if (firstLayer) doc.apply({ t: 'layer.add', id: uid(), parent: null, index: 0, layer: newLayerProps('Layer 1') });
    return doc;
  }

  on(fn: (c: DocChange) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(c: DocChange) { for (const fn of this.listeners) fn(c); }

  layer(id: string): Layer | undefined { const n = this.nodes.get(id); return n?.kind === 'layer' ? n : undefined; }
  folder(id: string): Folder | undefined { const n = this.nodes.get(id); return n?.kind === 'folder' ? n : undefined; }
  node(id: string) { return this.nodes.get(id); }
  indexOf(id: string) { return this.layers.findIndex((l) => l.props.id === id); }
  children(parent: string | null): string[] { return this.kids.get(parent ?? '') ?? []; }

  place(id: string): { parent: string | null; index: number } {
    const n = this.nodes.get(id)!;
    return { parent: n.parent, index: this.children(n.parent).indexOf(id) };
  }

  layerBelow(id: string): Layer | undefined {
    const { parent, index } = this.place(id);
    return index > 0 ? this.layer(this.children(parent)[index - 1]) : undefined;
  }

  isWithin(id: string, ancestor: string): boolean {
    for (let n = this.nodes.get(id); n; n = n.parent ? this.nodes.get(n.parent) : undefined) if (n.props.id === ancestor) return true;
    return false;
  }

  bounds(): Rect | null {
    if (!this.settings.infinite) return { x: 0, y: 0, w: this.settings.width, h: this.settings.height };
    let r: Rect | null = null;
    for (const l of this.layers) if (l.shown) r = rectUnion(r, l.surface.contentBounds());
    return r;
  }

  private insert(id: string, parent: string | null, index: number) {
    const key = parent ?? '';
    const list = this.kids.get(key) ?? [];
    list.splice(Math.max(0, Math.min(index, list.length)), 0, id);
    this.kids.set(key, list);
    this.nodes.get(id)!.parent = parent;
  }

  private detach(id: string) {
    const n = this.nodes.get(id)!;
    const list = this.kids.get(n.parent ?? '')!;
    list.splice(list.indexOf(id), 1);
  }

  private rebuild() {
    const out: Layer[] = [];
    const walk = (parent: string | null, shown: boolean) => {
      for (const id of this.children(parent)) {
        const n = this.nodes.get(id)!;
        n.shown = shown && n.props.visible;
        if (n.kind === 'layer') out.push(n);
        else walk(id, n.shown);
      }
    };
    walk(null, true);
    this.layers = out;
  }

  /**
   * The slow part of an op ahead of apply(): PNG tiles are decoded, and fills and effects are worked
   * out in the worker from the canvas as it is now. The options go straight into apply().
   */
  async prepare(op: Op): Promise<ApplyOptions> {
    if (op.t === 'fill' || op.t === 'fillPoly') return { fill: await this.prepareFill(op) };
    if (op.t === 'effect') return { effect: await this.prepareEffect(op) };
    if (op.t !== 'tiles' || op.img) return {};
    const img: Record<string, ImageData | null> = {};
    await Promise.all(Object.entries(op.tiles).map(async ([k, url]) => {
      if (!url) { img[k] = null; return; }
      const el = new Image();
      el.src = url;
      await el.decode();
      const c = makeCanvas(el.naturalWidth, el.naturalHeight);
      const ctx = ctx2d(c, true);
      ctx.drawImage(el, 0, 0);
      img[k] = ctx.getImageData(0, 0, c.width, c.height);
    }));
    op.img = img;
    return {};
  }

  /**
   * prepare(), redone if an edit landed meanwhile: a fill or effect worked out from older pixels
   * would differ from what everyone else computes at the op's place in the log. After a few tries
   * the op is worked out on the thread at apply time instead.
   */
  async prepared(op: Op): Promise<ApplyOptions> {
    for (let i = 0; i < 4; i++) {
      const rev = this.rev, opts = await this.prepare(op);
      if (this.rev === rev) return opts;
    }
    return {};
  }

  /** The fill as a canvas over its region, or null when there is nothing to fill. */
  async prepareFill(op: FillOp): Promise<HTMLCanvasElement | null> {
    const layer = this.layer(op.layer), surface = this.target(layer, op);
    if (!layer || !surface) return null;
    if (op.t === 'fillPoly' && !op.inside) return polyFill(op.region, op.pts, op.color);
    const sample = op.mask ? surface.extract(op.region) : renderRegion(this, op.region, { paper: false, only: op.sampleAll ? undefined : op.layer, raw: !op.sampleAll });
    const data = ctx2d(sample, true).getImageData(0, 0, op.region.w, op.region.h);
    const m = op.t === 'fill' ? await fillMask(data, op.region, op.x, op.y, op.tolerance, op.expand)
      : await enclosedFillMask(data, polyMask(op.region, op.pts), op.tolerance, op.expand);
    return m && maskCanvas(m, op.region.w, op.region.h, op.color);
  }

  /** The part of the layer an effect touches, with the pixels it would leave there. */
  async prepareEffect(op: EffectOp): Promise<{ region: Rect; img: ImageData } | null> {
    const layer = this.layer(op.layer), surface = this.target(layer, op);
    if (!layer || !surface) return null;
    let region = surface.contentBounds();
    if (op.clip) region = region && rectIntersect(region, rectFromPoints(op.clip.pts)!);
    if (!region) return null;
    region = rectRoundOut(region, effectReach(op));
    const src = surface.extract(region);
    const img = await effectImage(ctx2d(src, true).getImageData(0, 0, region.w, region.h), op, region.x, region.y);
    return { region, img };
  }

  apply(op: Op, opts: ApplyOptions = {}): Op[] {
    this.record = opts.record !== false;
    const inv = this.applyInner(op, opts);
    this.record = true;
    if (inv) { this.log.push(op); this.rev++; }
    return inv ?? [];
  }

  private applyInner(op: Op, opts: ApplyOptions): Op[] | null {
    switch (op.t) {
      case 'stroke':
      case 'shape': {
        const layer = this.layer(op.layer), surface = this.target(layer, op);
        if (!layer || !surface) return null;
        let buf = opts.buffer;
        if (!buf) {
          buf = new TiledSurface();
          if (op.t === 'stroke') renderStroke(buf, op.brush, op.color, op.pts);
          else renderShape(buf, op);
        }
        const alpha = op.t === 'stroke' ? op.brush.opacity : op.opacity;
        const gco: GlobalCompositeOperation = op.erase ? 'destination-out' : layer.props.alphaLock && !op.mask ? 'source-atop' : 'source-over';
        const keys = [...buf.tiles.keys()].filter((k) => !op.erase || surface.tiles.has(k));
        const src = buf;
        // Undo keeps only the part of each tile the stroke touched.
        const parts = new Map(keys.map((k) => [k, src.footprint(k)]));
        return this.pixelEdit(layer, surface, keys, () => {
          const clip = op.clip ? selPath(op.clip) : null;
          let dirty: Rect | null = null;
          for (const k of keys) {
            const [tx, ty] = TiledSurface.parse(k);
            const c = ctx2d(surface.ensure(tx, ty));
            c.save();
            if (clip) { c.translate(-tx * TILE, -ty * TILE); c.clip(clip, 'evenodd'); c.setTransform(1, 0, 0, 1, 0, 0); }
            c.globalAlpha = alpha;
            c.globalCompositeOperation = gco;
            c.drawImage(src.tiles.get(k)!, 0, 0);
            c.restore();
            dirty = rectUnion(dirty, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
          }
          return dirty;
        }, true, undefined, !!op.erase, parts);
      }
      case 'smudge': {
        const layer = this.layer(op.layer), surface = this.target(layer, op);
        if (!layer || !surface) return null;
        const done = opts.applied;
        const keys = done ? [...done.keys()] : smudgeKeys(surface, op);
        return this.pixelEdit(layer, surface, keys, () => (done ? rectOfKeys(keys) : renderSmudge(surface, op)), true, done);
      }
      case 'effect': {
        const layer = this.layer(op.layer), surface = this.target(layer, op);
        if (!layer || !surface) return null;
        let done = opts.effect;
        if (done === undefined) {
          // Worked out here and now, on the thread: the same arithmetic as the worker runs.
          let region = surface.contentBounds();
          if (op.clip) region = region && rectIntersect(region, rectFromPoints(op.clip.pts)!);
          if (!region) return null;
          region = rectRoundOut(region, effectReach(op));
          const img = ctx2d(surface.extract(region), true).getImageData(0, 0, region.w, region.h);
          applyEffect(img, op, region.x, region.y);
          done = { region, img };
        }
        if (!done) return null;
        const r = done.region, src = makeCanvas(r.w, r.h);
        ctx2d(src).putImageData(done.img, 0, 0);
        return this.pixelEdit(layer, surface, surface.keysIn(r), () => {
          const clip = op.clip ? selPath(op.clip) : null;
          surface.draw(r, (c) => {
            if (clip) c.clip(clip, 'evenodd');
            c.clearRect(r.x, r.y, r.w, r.h);
            c.drawImage(src, r.x, r.y);
          });
          return r;
        });
      }
      case 'fill':
      case 'fillPoly': {
        const layer = this.layer(op.layer), surface = this.target(layer, op);
        if (!layer || !surface) return null;
        let fill = opts.fill;
        if (fill === undefined) {
          if (op.t === 'fillPoly' && !op.inside) fill = polyFill(op.region, op.pts, op.color);
          else {
            const sample = op.mask ? surface.extract(op.region) : renderRegion(this, op.region, { paper: false, only: op.sampleAll ? undefined : op.layer, raw: !op.sampleAll });
            const data = ctx2d(sample, true).getImageData(0, 0, op.region.w, op.region.h);
            fill = op.t === 'fill' ? floodFill(data, op.region, op.x, op.y, op.color, op.tolerance, op.expand)
              : enclosedFill(data, op.region, op.pts, op.color, op.tolerance, op.expand);
          }
        }
        if (!fill) return null;
        const gco: GlobalCompositeOperation = layer.props.alphaLock && !op.mask ? 'source-atop' : 'source-over';
        return this.pixelEdit(layer, surface, surface.keysIn(op.region), () => {
          const clip = op.clip ? selPath(op.clip) : null;
          surface.draw(op.region, (c) => {
            if (clip) c.clip(clip, 'evenodd');
            c.globalCompositeOperation = gco;
            c.drawImage(fill, op.region.x, op.region.y);
          });
          return op.region;
        });
      }
      case 'transform': {
        const layer = this.layer(op.layer), surface = this.target(layer, op);
        if (!layer || !surface) return null;
        const m = new DOMMatrix(op.m);
        const f = liftSelection(surface, op.sel);
        const src = selectionBounds(op.sel);
        const dst = floatingBounds(f, m);
        const keys = [...new Set([...surface.keysIn(src), ...surface.keysIn(dst)])];
        return this.pixelEdit(layer, surface, keys, () => {
          clearSelection(surface, op.sel);
          placeFloating(surface, f, m);
          return rectUnion(src, dst);
        });
      }
      case 'tiles': {
        const layer = this.layer(op.layer), surface = this.target(layer, op);
        if (!layer || !surface || !op.img) return null;
        const img = op.img, keys = Object.keys(img);
        const parts = new Map(keys.map((k) => [k, { key: k, w: img[k]?.width ?? TILE, h: img[k]?.height ?? TILE }]));
        return this.pixelEdit(layer, surface, keys, () => { surface.restore(new Map(Object.entries(img))); return rectOfKeys(keys); }, true, undefined, true, parts);
      }
      case 'layer.clear': {
        const layer = this.layer(op.layer), surface = this.target(layer, op);
        if (!layer || !surface) return null;
        return this.pixelEdit(layer, surface, [...surface.tiles.keys()], () => { surface.clear(); return null; });
      }
      case 'layer.mask.apply': {
        const layer = this.layer(op.layer);
        if (!layer?.mask) return null;
        const mask = layer.mask;
        const keys = [...layer.surface.tiles.keys()].filter((k) => mask.tiles.has(k));
        const inv = this.pixelEdit(layer, layer.surface, keys, () => {
          for (const k of keys) {
            const c = ctx2d(layer.surface.tiles.get(k)!);
            layer.surface.touch(k);
            c.save();
            c.globalCompositeOperation = 'destination-out';
            c.drawImage(mask.tiles.get(k)!, 0, 0);
            c.restore();
          }
          return rectOfKeys(keys);
        }, false);
        return [...this.dropMask(layer), ...inv];
      }
      case 'layer.add': {
        if (this.nodes.has(op.layer.id) || (op.parent && !this.folder(op.parent))) return null;
        const src = op.copyOf ? this.layer(op.copyOf) : undefined;
        const mask = src?.mask ? src.mask.clone() : op.layer.mask ? new TiledSurface() : null;
        const layer: Layer = { kind: 'layer', props: { ...op.layer, mask: !!mask }, surface: src ? src.surface.clone() : new TiledSurface(), mask, parent: null, shown: true };
        this.nodes.set(layer.props.id, layer);
        this.insert(layer.props.id, op.parent, op.index);
        this.structural(layer.surface.size ? null : undefined);
        return [{ t: 'layer.remove', id: uid(), layer: layer.props.id }];
      }
      case 'layer.remove': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        const inv = this.record ? this.recreate(layer) : [];
        this.detach(layer.props.id);
        this.nodes.delete(layer.props.id);
        this.structural(null);
        return inv;
      }
      case 'layer.props': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        const { mask, ...rest } = op.props;
        const before: Record<string, unknown> = {};
        for (const k of Object.keys(rest)) before[k] = (layer.props as unknown as Record<string, unknown>)[k];
        Object.assign(layer.props, rest);
        const inv: Op[] = Object.keys(rest).length ? [{ t: 'layer.props', id: uid(), layer: op.layer, props: before }] : [];
        if (mask === false && layer.mask) inv.push(...this.dropMask(layer));
        else if (mask === true && !layer.mask) { layer.mask = new TiledSurface(); layer.props.mask = true; inv.push({ t: 'layer.props', id: uid(), layer: op.layer, props: { mask: false } }); }
        this.structural(null);
        return inv;
      }
      case 'layer.merge': {
        const upper = this.layer(op.layer);
        const lower = upper && this.layerBelow(upper.props.id);
        if (!upper || !lower) return null;
        const inv = this.record ? this.recreate(upper) : [];
        const keys = [...upper.surface.tiles.keys()];
        const lowerInv = this.pixelEdit(lower, lower.surface, keys, () => {
          for (const k of keys) {
            const [tx, ty] = TiledSurface.parse(k);
            const c = ctx2d(lower.surface.ensure(tx, ty));
            c.save();
            c.globalAlpha = upper.props.opacity;
            // A clipped layer only ever showed where the lower one has pixels, so it lands the same way.
            c.globalCompositeOperation = lower.props.alphaLock || upper.props.clip ? 'source-atop' : blendOp(upper.props.blend);
            c.drawImage(maskedTile(upper, k), 0, 0);
            c.restore();
          }
          return null;
        }, false);
        this.detach(upper.props.id);
        this.nodes.delete(upper.props.id);
        this.structural(null);
        return [...lowerInv, ...inv];
      }
      case 'folder.add': {
        if (this.nodes.has(op.folder.id) || (op.parent && !this.folder(op.parent))) return null;
        const folder: Folder = { kind: 'folder', props: { ...op.folder }, parent: null, shown: true };
        this.nodes.set(folder.props.id, folder);
        this.insert(folder.props.id, op.parent, op.index);
        this.structural(undefined);
        return [{ t: 'folder.remove', id: uid(), folder: folder.props.id }];
      }
      case 'folder.remove': {
        const folder = this.folder(op.folder);
        if (!folder) return null;
        const inv = this.record ? this.recreate(folder) : [];
        const drop = (id: string) => {
          for (const c of [...this.children(id)]) drop(c);
          this.kids.delete(id);
          this.nodes.delete(id);
        };
        this.detach(folder.props.id);
        drop(folder.props.id);
        this.structural(null);
        return inv;
      }
      case 'folder.props': {
        const folder = this.folder(op.folder);
        if (!folder) return null;
        const before: Record<string, unknown> = {};
        for (const k of Object.keys(op.props)) before[k] = (folder.props as unknown as Record<string, unknown>)[k];
        Object.assign(folder.props, op.props);
        this.structural('visible' in op.props ? null : undefined);
        return [{ t: 'folder.props', id: uid(), folder: op.folder, props: before }];
      }
      case 'node.move': {
        const n = this.nodes.get(op.node);
        if (!n || (op.parent && (!this.folder(op.parent) || this.isWithin(op.parent, op.node)))) return null;
        const from = this.place(op.node);
        this.detach(op.node);
        this.insert(op.node, op.parent, op.index);
        this.structural(null);
        return [{ t: 'node.move', id: uid(), node: op.node, parent: from.parent, index: from.index }];
      }
    }
    return null;
  }

  /** Ops that rebuild the canvas as it looks now, without its history; pixels come in room-sized chunks. */
  snapshot(): Op[] {
    const out: Op[] = [];
    for (const id of this.children(null)) {
      for (const op of this.recreate(this.nodes.get(id)!)) {
        if (op.t !== 'tiles' || !op.img) { out.push(op); continue; }
        const keys = Object.keys(op.img);
        for (let i = 0; i < keys.length; i += TILES_PER_OP) {
          const img: Record<string, ImageData | null> = {};
          for (const k of keys.slice(i, i + TILES_PER_OP)) img[k] = op.img[k];
          out.push({ ...op, id: i ? uid() : op.id, img });
        }
      }
    }
    return out;
  }

  /** Swaps the change log for a snapshot of the canvas, so it stops carrying old undo pixels. */
  compactLog(): Op[] {
    const snap = this.snapshot();
    this.log.length = 0;
    this.log.push(...snap);
    return snap;
  }

  private recreate(n: DocNode): Op[] {
    const { parent, index } = this.place(n.props.id);
    if (n.kind === 'layer') {
      const ops: Op[] = [{ t: 'layer.add', id: uid(), layer: { ...n.props }, parent, index }];
      if (n.surface.size) {
        ops.push({ t: 'tiles', id: uid(), layer: n.props.id, tiles: {}, img: Object.fromEntries(n.surface.snapshot(n.surface.tiles.keys())) });
      }
      if (n.mask?.size) ops.push({ t: 'tiles', id: uid(), layer: n.props.id, mask: true, tiles: {}, img: Object.fromEntries(n.mask.snapshot(n.mask.tiles.keys())) });
      return ops;
    }
    const ops: Op[] = [{ t: 'folder.add', id: uid(), folder: { ...n.props }, parent, index }];
    for (const c of this.children(n.props.id)) ops.push(...this.recreate(this.nodes.get(c)!));
    return ops;
  }

  /** The pixels an op edits: the layer's own, or its mask. */
  private target(layer: Layer | undefined, op: Op): TiledSurface | null {
    if (!layer) return null;
    return op.mask ? layer.mask : layer.surface;
  }

  /** Removes the mask; returns the ops that bring it back (none when not recording). */
  private dropMask(layer: Layer): Op[] {
    const mask = layer.mask!;
    const inv: Op[] = [];
    if (this.record) {
      inv.push({ t: 'layer.props', id: uid(), layer: layer.props.id, props: { mask: true } });
      if (mask.size) inv.push({ t: 'tiles', id: uid(), layer: layer.props.id, mask: true, tiles: {}, img: Object.fromEntries(mask.snapshot(mask.tiles.keys())) });
    }
    layer.mask = null;
    layer.props.mask = false;
    return inv;
  }

  /**
   * Mutate a layer's pixels (or its mask); returns the `tiles` op that restores them (none when not recording).
   * `canEmpty`: the edit may leave tiles blank, so they are read back and dropped. Painting never does.
   */
  private pixelEdit(layer: Layer, surface: TiledSurface, keys: string[], mutate: () => Rect | null, emit = true, taken?: TileSnapshot, canEmpty = true, parts?: Map<string, { key: string; w: number; h: number }>): Op[] {
    const before: TileSnapshot | null = this.record ? taken ?? surface.snapshot(keys, undefined, parts) : null;
    const dirty = mutate();
    if (before && canEmpty) surface.prune(keys);
    if (emit) this.emit({ rect: dirty ?? rectOfKeys(keys), pixels: layer.props.id });
    if (!before) return [];
    const inv: TilesOp = { t: 'tiles', id: uid(), layer: layer.props.id, tiles: {}, img: Object.fromEntries(before) };
    if (surface === layer.mask) inv.mask = true;
    return [inv];
  }

  /** Tree changed. dirty: null = repaint all, undefined = no pixels changed. */
  private structural(dirty: null | undefined) {
    this.rebuild();
    this.emit({ rect: dirty === undefined ? { x: 0, y: 0, w: 0, h: 0 } : null, structure: true });
  }
}

/** A layer tile with its mask applied, as the layer shows on screen. */
function maskedTile(layer: Layer, k: string): HTMLCanvasElement {
  const t = layer.surface.tiles.get(k)!, m = layer.mask?.tiles.get(k);
  if (!m) return t;
  const c = makeCanvas(TILE, TILE), ctx = ctx2d(c);
  ctx.drawImage(t, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(m, 0, 0);
  return c;
}

function rectOfKeys(keys: string[]): Rect | null {
  let r: Rect | null = null;
  for (const k of keys) {
    const [tx, ty] = TiledSurface.parse(k);
    r = rectUnion(r, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
  }
  return r;
}

/** Characters of PNG one `tiles` op may carry on the wire; bigger edits go in pieces. */
const WIRE_CHARS = 4_000_000;

/** The op as sent to the room: a big `tiles` op is split so each piece fits the room's limits. */
export function wireOps(op: Op): Op[] {
  const w = toWire(op);
  if (w.t !== 'tiles') return [w];
  const out: Op[] = [];
  let tiles: Record<string, string | null> = {}, n = 0, chars = 0;
  for (const [k, v] of Object.entries(w.tiles)) {
    if (n && (n >= TILES_PER_OP || chars + (v?.length ?? 0) > WIRE_CHARS)) { out.push({ ...w, id: out.length ? uid() : w.id, tiles }); tiles = {}; n = 0; chars = 0; }
    tiles[k] = v; n++; chars += v?.length ?? 0;
  }
  out.push({ ...w, id: out.length ? uid() : w.id, tiles });
  return out;
}

export function toWire(op: Op): Op {
  if (op.t !== 'tiles' || !op.img) return op;
  const tiles: Record<string, string | null> = {};
  const c = makeCanvas(TILE, TILE);
  const ctx = ctx2d(c);
  for (const [k, d] of Object.entries(op.img)) {
    if (!d) { tiles[k] = null; continue; }
    // A partial tile is encoded at its own size, so it lands back on just its strip.
    c.width = d.width; c.height = d.height;
    ctx.putImageData(d, 0, 0);
    tiles[k] = c.toDataURL('image/png');
  }
  const { img: _img, ...rest } = op;
  return { ...rest, tiles };
}

/** Undo memory in whole tiles' worth of pixels; a partial tile counts its share. */
export function opsCost(ops: Op[]) {
  let n = 0;
  for (const o of ops) if (o.t === 'tiles' && o.img) for (const d of Object.values(o.img)) n += d ? (d.width * d.height) / (TILE * TILE) : 1;
  return n;
}

export function newLayerProps(name: string, owner?: string): LayerProps {
  return { id: uid('ly_'), name, visible: true, opacity: 1, blend: 'normal', alphaLock: false, owner };
}

export function newFolderProps(name: string, owner?: string): FolderProps {
  return { id: uid('fd_'), name, visible: true, owner };
}
