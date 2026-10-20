import { Rect, ctx2d, makeCanvas, polyPath, rectUnion, uid } from './geom';
import { History } from './history';
import { DocSettings, FolderProps, LayerProps, Op, blendOp } from './model';
import { TILE, TiledSurface, TileSnapshot } from './tiles';
import { renderStroke } from '../engine/brush';
import { renderShape } from '../engine/shapes';
import { floodFill } from '../engine/fill';
import { renderRegion } from '../engine/compositor';
import { clearSelection, floatingBounds, liftSelection, placeFloating, selectionBounds } from '../engine/transform';

export interface Layer { kind: 'layer'; props: LayerProps; surface: TiledSurface; parent: string | null; shown: boolean }
export interface Folder { kind: 'folder'; props: FolderProps; parent: string | null; shown: boolean }
export type DocNode = Layer | Folder;

export interface DocChange {
  /** Changed document area; null means "everything". */
  rect: Rect | null;
  /** Layer tree or layer/folder properties changed. */
  structure?: boolean;
}

export interface ApplyOptions {
  /** Pre-rendered stroke/shape pixels from the live preview, so we don't render twice. */
  buffer?: TiledSurface;
}

type TilesOp = Extract<Op, { t: 'tiles' }>;

/**
 * The shared document: a tree of folders and layers. Every change goes through apply(), which is
 * deterministic and returns the ops that undo it. Undo and redo are therefore ordinary ops too,
 * which is what lets them sync to everyone in a room.
 */
export class DrawDoc {
  readonly nodes = new Map<string, DocNode>();
  /** Child ids per parent ('' = root), bottom to top. */
  private kids = new Map<string, string[]>();
  /** Layers in render order (bottom to top). */
  layers: Layer[] = [];
  readonly history = new History();
  /** Every applied op in order. */
  readonly log: Op[] = [];
  private listeners = new Set<(c: DocChange) => void>();

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

  /** Position of a node among its siblings. */
  place(id: string): { parent: string | null; index: number } {
    const n = this.nodes.get(id)!;
    return { parent: n.parent, index: this.children(n.parent).indexOf(id) };
  }

  /** The layer directly below in the same folder, if it is a layer. */
  layerBelow(id: string): Layer | undefined {
    const { parent, index } = this.place(id);
    return index > 0 ? this.layer(this.children(parent)[index - 1]) : undefined;
  }

  /** Is `id` the same as, or inside, folder `ancestor`? */
  isWithin(id: string, ancestor: string): boolean {
    for (let n = this.nodes.get(id); n; n = n.parent ? this.nodes.get(n.parent) : undefined) if (n.props.id === ancestor) return true;
    return false;
  }

  /** Document bounds for fixed canvases, content bounds for infinite ones. */
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

  /** Decode PNG tiles of a remote `tiles` op. Must run before apply() for ops received over the wire. */
  async prepare(op: Op) {
    if (op.t !== 'tiles' || op.img) return;
    const img: Record<string, ImageData | null> = {};
    await Promise.all(Object.entries(op.tiles).map(async ([k, url]) => {
      if (!url) { img[k] = null; return; }
      const el = new Image();
      el.src = url;
      await el.decode();
      const c = makeCanvas(TILE, TILE);
      const ctx = ctx2d(c, true);
      ctx.drawImage(el, 0, 0);
      img[k] = ctx.getImageData(0, 0, TILE, TILE);
    }));
    op.img = img;
  }

  /** Apply an op. Returns the ops that undo it (empty if nothing happened). */
  apply(op: Op, opts: ApplyOptions = {}): Op[] {
    const inv = this.applyInner(op, opts);
    if (inv) this.log.push(op);
    return inv ?? [];
  }

  private applyInner(op: Op, opts: ApplyOptions): Op[] | null {
    switch (op.t) {
      case 'stroke':
      case 'shape': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        let buf = opts.buffer;
        if (!buf) {
          buf = new TiledSurface();
          if (op.t === 'stroke') renderStroke(buf, op.brush, op.color, op.pts);
          else renderShape(buf, op);
        }
        const alpha = op.t === 'stroke' ? op.brush.opacity : op.opacity;
        const gco: GlobalCompositeOperation = op.erase ? 'destination-out' : layer.props.alphaLock ? 'source-atop' : 'source-over';
        const keys = [...buf.tiles.keys()].filter((k) => !op.erase || layer.surface.tiles.has(k));
        const src = buf;
        return this.pixelEdit(layer, keys, () => {
          const clip = op.clip ? polyPath(op.clip.pts) : null;
          let dirty: Rect | null = null;
          for (const k of keys) {
            const [tx, ty] = TiledSurface.parse(k);
            const c = ctx2d(layer.surface.ensure(tx, ty));
            c.save();
            if (clip) { c.translate(-tx * TILE, -ty * TILE); c.clip(clip); c.setTransform(1, 0, 0, 1, 0, 0); }
            c.globalAlpha = alpha;
            c.globalCompositeOperation = gco;
            c.drawImage(src.tiles.get(k)!, 0, 0);
            c.restore();
            dirty = rectUnion(dirty, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
          }
          return dirty;
        });
      }
      case 'fill': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        const sample = renderRegion(this, op.region, { paper: false, only: op.sampleAll ? undefined : op.layer, raw: !op.sampleAll });
        const data = ctx2d(sample, true).getImageData(0, 0, op.region.w, op.region.h);
        const fill = floodFill(data, op.region, op.x, op.y, op.color, op.tolerance, op.expand);
        if (!fill) return null;
        const gco: GlobalCompositeOperation = layer.props.alphaLock ? 'source-atop' : 'source-over';
        return this.pixelEdit(layer, layer.surface.keysIn(op.region), () => {
          const clip = op.clip ? polyPath(op.clip.pts) : null;
          layer.surface.draw(op.region, (c) => {
            if (clip) c.clip(clip);
            c.globalCompositeOperation = gco;
            c.drawImage(fill, op.region.x, op.region.y);
          });
          return op.region;
        });
      }
      case 'transform': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        const m = new DOMMatrix(op.m);
        const f = liftSelection(layer.surface, op.sel);
        const src = selectionBounds(op.sel);
        const dst = floatingBounds(f, m);
        const keys = [...new Set([...layer.surface.keysIn(src), ...layer.surface.keysIn(dst)])];
        return this.pixelEdit(layer, keys, () => {
          clearSelection(layer.surface, op.sel);
          placeFloating(layer.surface, f, m);
          return rectUnion(src, dst);
        });
      }
      case 'tiles': {
        const layer = this.layer(op.layer);
        if (!layer || !op.img) return null;
        return this.pixelEdit(layer, Object.keys(op.img), () => {
          layer.surface.restore(new Map(Object.entries(op.img!)));
          return rectOfKeys(Object.keys(op.img!));
        });
      }
      case 'layer.clear': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        return this.pixelEdit(layer, [...layer.surface.tiles.keys()], () => { layer.surface.clear(); return null; });
      }
      case 'layer.add': {
        if (this.nodes.has(op.layer.id) || (op.parent && !this.folder(op.parent))) return null;
        const src = op.copyOf ? this.layer(op.copyOf) : undefined;
        const layer: Layer = { kind: 'layer', props: { ...op.layer }, surface: src ? src.surface.clone() : new TiledSurface(), parent: null, shown: true };
        this.nodes.set(layer.props.id, layer);
        this.insert(layer.props.id, op.parent, op.index);
        this.structural(layer.surface.size ? null : undefined);
        return [{ t: 'layer.remove', id: uid(), layer: layer.props.id }];
      }
      case 'layer.remove': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        const inv = this.recreate(layer);
        this.detach(layer.props.id);
        this.nodes.delete(layer.props.id);
        this.structural(null);
        return inv;
      }
      case 'layer.props': {
        const layer = this.layer(op.layer);
        if (!layer) return null;
        const before: Record<string, unknown> = {};
        for (const k of Object.keys(op.props)) before[k] = (layer.props as unknown as Record<string, unknown>)[k];
        Object.assign(layer.props, op.props);
        this.structural(null);
        return [{ t: 'layer.props', id: uid(), layer: op.layer, props: before }];
      }
      case 'layer.merge': {
        const upper = this.layer(op.layer);
        const lower = upper && this.layerBelow(upper.props.id);
        if (!upper || !lower) return null;
        const inv = this.recreate(upper);
        const keys = [...upper.surface.tiles.keys()];
        const lowerInv = this.pixelEdit(lower, keys, () => {
          for (const k of keys) {
            const [tx, ty] = TiledSurface.parse(k);
            const c = ctx2d(lower.surface.ensure(tx, ty));
            c.save();
            c.globalAlpha = upper.props.opacity;
            c.globalCompositeOperation = lower.props.alphaLock ? 'source-atop' : blendOp(upper.props.blend);
            c.drawImage(upper.surface.tiles.get(k)!, 0, 0);
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
        const inv = this.recreate(folder);
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

  /** Ops that rebuild a node (and its contents) exactly where it is now. */
  private recreate(n: DocNode): Op[] {
    const { parent, index } = this.place(n.props.id);
    if (n.kind === 'layer') {
      const ops: Op[] = [{ t: 'layer.add', id: uid(), layer: { ...n.props }, parent, index }];
      if (n.surface.size) {
        ops.push({ t: 'tiles', id: uid(), layer: n.props.id, tiles: {}, img: Object.fromEntries(n.surface.snapshot(n.surface.tiles.keys())) });
      }
      return ops;
    }
    const ops: Op[] = [{ t: 'folder.add', id: uid(), folder: { ...n.props }, parent, index }];
    for (const c of this.children(n.props.id)) ops.push(...this.recreate(this.nodes.get(c)!));
    return ops;
  }

  /** Mutate a layer's pixels and return a `tiles` op that restores the previous state. */
  private pixelEdit(layer: Layer, keys: string[], mutate: () => Rect | null, emit = true): Op[] {
    const before: TileSnapshot = layer.surface.snapshot(keys);
    const dirty = mutate();
    const after = layer.surface.snapshot(keys);
    layer.surface.prune(after);
    if (emit) this.emit({ rect: dirty ?? rectOfKeys(keys), structure: true });
    const inv: TilesOp = { t: 'tiles', id: uid(), layer: layer.props.id, tiles: {}, img: Object.fromEntries(before) };
    return [inv];
  }

  /** Tree changed. dirty: null = repaint all, undefined = no pixels changed. */
  private structural(dirty: null | undefined) {
    this.rebuild();
    this.emit({ rect: dirty === undefined ? { x: 0, y: 0, w: 0, h: 0 } : null, structure: true });
  }
}

function rectOfKeys(keys: string[]): Rect | null {
  let r: Rect | null = null;
  for (const k of keys) {
    const [tx, ty] = TiledSurface.parse(k);
    r = rectUnion(r, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
  }
  return r;
}

/** Serialise an op for the network: tile images become PNG data URLs. */
export function toWire(op: Op): Op {
  if (op.t !== 'tiles' || !op.img) return op;
  const tiles: Record<string, string | null> = {};
  const c = makeCanvas(TILE, TILE);
  const ctx = ctx2d(c);
  for (const [k, d] of Object.entries(op.img)) {
    if (!d) { tiles[k] = null; continue; }
    ctx.clearRect(0, 0, TILE, TILE);
    ctx.putImageData(d, 0, 0);
    tiles[k] = c.toDataURL('image/png');
  }
  const { img: _img, ...rest } = op;
  return { ...rest, tiles };
}

/** Approximate memory cost of ops in tiles (for capping undo history). */
export function opsCost(ops: Op[]) {
  return ops.reduce((s, o) => s + (o.t === 'tiles' && o.img ? Object.keys(o.img).length : 0), 0);
}

export function newLayerProps(name: string, owner?: string): LayerProps {
  return { id: uid('ly_'), name, visible: true, opacity: 1, blend: 'normal', alphaLock: false, owner };
}

export function newFolderProps(name: string, owner?: string): FolderProps {
  return { id: uid('fd_'), name, visible: true, owner };
}
