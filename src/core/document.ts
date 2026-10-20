import { Rect, polyPath, rectUnion, uid } from './geom';
import { History } from './history';
import { DocSettings, LayerProps, Op, Selection, blendOp } from './model';
import { TILE, TiledSurface, TileSnapshot } from './tiles';
import { renderStroke } from '../engine/brush';
import { renderShape } from '../engine/shapes';
import { floodFill } from '../engine/fill';
import { renderRegion } from '../engine/compositor';
import { clearSelection, floatingBounds, liftSelection, placeFloating, selectionBounds } from '../engine/transform';

export interface Layer { props: LayerProps; surface: TiledSurface }

export interface DocChange {
  /** Changed document area; null means "everything". */
  rect: Rect | null;
  /** Layer list or layer properties changed. */
  structure?: boolean;
}

export interface ApplyOptions {
  /** Pre-rendered stroke/shape pixels from the live preview, so we don't render twice. */
  buffer?: TiledSurface;
  /** Record in local undo history (false for ops coming from collaborators later). */
  undoable?: boolean;
}

export class DrawDoc {
  layers: Layer[] = [];
  readonly history = new History();
  /** Every applied op in order. This is the stream a sync layer will exchange. */
  readonly log: Op[] = [];
  private listeners = new Set<(c: DocChange) => void>();

  constructor(public settings: DocSettings) {}

  static create(opts: { width: number; height: number; infinite: boolean; background: string | null }): DrawDoc {
    const doc = new DrawDoc({ id: uid('doc_'), ...opts });
    doc.apply({ t: 'layer.add', id: uid(), index: 0, layer: newLayerProps('Layer 1') }, { undoable: false });
    return doc;
  }

  on(fn: (c: DocChange) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(c: DocChange) { for (const fn of this.listeners) fn(c); }

  layer(id: string): Layer | undefined { return this.layers.find((l) => l.props.id === id); }
  indexOf(id: string) { return this.layers.findIndex((l) => l.props.id === id); }

  /** Document bounds for fixed canvases, content bounds for infinite ones. */
  bounds(): Rect | null {
    if (!this.settings.infinite) return { x: 0, y: 0, w: this.settings.width, h: this.settings.height };
    let r: Rect | null = null;
    for (const l of this.layers) if (l.props.visible) r = rectUnion(r, l.surface.contentBounds());
    return r;
  }

  apply(op: Op, opts: ApplyOptions = {}) {
    const undoable = opts.undoable ?? true;
    switch (op.t) {
      case 'stroke':
      case 'shape': {
        const layer = this.layer(op.layer);
        if (!layer) return;
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
        this.pixelEdit(layer, keys, op.t, undoable, () => {
          const clip = op.clip ? polyPath(op.clip.pts) : null;
          let dirty: Rect | null = null;
          for (const k of keys) {
            const [tx, ty] = TiledSurface.parse(k);
            const t = layer.surface.ensure(tx, ty);
            const c = t.getContext('2d')!;
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
        break;
      }
      case 'fill': {
        const layer = this.layer(op.layer);
        if (!layer) return;
        const sample = renderRegion(this, op.region, { paper: false, only: op.sampleAll ? undefined : op.layer, raw: !op.sampleAll });
        const data = sample.getContext('2d')!.getImageData(0, 0, op.region.w, op.region.h);
        const fill = floodFill(data, op.region, op.x, op.y, op.color, op.tolerance, op.expand);
        if (!fill) return;
        const gco: GlobalCompositeOperation = layer.props.alphaLock ? 'source-atop' : 'source-over';
        const keys = layer.surface.keysIn(op.region);
        this.pixelEdit(layer, keys, 'fill', undoable, () => {
          const clip = op.clip ? polyPath(op.clip.pts) : null;
          layer.surface.draw(op.region, (c) => {
            if (clip) c.clip(clip);
            c.globalCompositeOperation = gco;
            c.drawImage(fill, op.region.x, op.region.y);
          });
          return op.region;
        });
        break;
      }
      case 'transform': {
        const layer = this.layer(op.layer);
        if (!layer) return;
        const m = new DOMMatrix(op.m);
        const f = liftSelection(layer.surface, op.sel);
        const src = selectionBounds(op.sel);
        const dst = floatingBounds(f, m);
        const keys = [...new Set([...layer.surface.keysIn(src), ...layer.surface.keysIn(dst)])];
        this.pixelEdit(layer, keys, 'transform', undoable, () => {
          clearSelection(layer.surface, op.sel);
          placeFloating(layer.surface, f, m);
          return rectUnion(src, dst);
        });
        break;
      }
      case 'layer.add': {
        const surface = op.copyOf ? this.layer(op.copyOf)?.surface.clone() ?? new TiledSurface() : new TiledSurface();
        const layer: Layer = { props: { ...op.layer }, surface };
        const insert = () => { this.layers.splice(Math.min(op.index, this.layers.length), 0, layer); };
        const remove = () => { this.layers.splice(this.layers.indexOf(layer), 1); };
        insert();
        this.structural(undoable, 'Add layer', remove, insert);
        break;
      }
      case 'layer.remove': {
        const layer = this.layer(op.layer);
        if (!layer || this.layers.length <= 1) return;
        const idx = this.layers.indexOf(layer);
        const remove = () => { this.layers.splice(this.layers.indexOf(layer), 1); };
        const insert = () => { this.layers.splice(idx, 0, layer); };
        remove();
        this.structural(undoable, 'Delete layer', insert, remove);
        break;
      }
      case 'layer.props': {
        const layer = this.layer(op.layer);
        if (!layer) return;
        const before: Partial<LayerProps> = {};
        for (const k of Object.keys(op.props) as (keyof LayerProps)[]) (before as any)[k] = layer.props[k];
        const set = (p: Partial<LayerProps>) => () => { Object.assign(layer.props, p); };
        set(op.props)();
        this.structural(undoable, 'Layer properties', set(before), set(op.props));
        break;
      }
      case 'layer.move': {
        const layer = this.layer(op.layer);
        if (!layer) return;
        const from = this.layers.indexOf(layer);
        const moveTo = (i: number) => () => {
          this.layers.splice(this.layers.indexOf(layer), 1);
          this.layers.splice(Math.max(0, Math.min(i, this.layers.length)), 0, layer);
        };
        moveTo(op.index)();
        this.structural(undoable, 'Move layer', moveTo(from), moveTo(op.index));
        break;
      }
      case 'layer.merge': {
        const idx = this.indexOf(op.layer);
        if (idx <= 0) return;
        const upper = this.layers[idx], lower = this.layers[idx - 1];
        const keys = [...upper.surface.tiles.keys()];
        const before = lower.surface.snapshot(keys);
        for (const k of keys) {
          const [tx, ty] = TiledSurface.parse(k);
          const c = lower.surface.ensure(tx, ty).getContext('2d')!;
          c.save();
          c.globalAlpha = upper.props.opacity;
          c.globalCompositeOperation = lower.props.alphaLock ? 'source-atop' : blendOp(upper.props.blend);
          c.drawImage(upper.surface.tiles.get(k)!, 0, 0);
          c.restore();
        }
        const after = lower.surface.snapshot(keys);
        lower.surface.prune(after);
        this.layers.splice(idx, 1);
        if (undoable) this.history.push({
          label: 'Merge down', cost: keys.length * 2,
          undo: () => { lower.surface.restore(before); this.layers.splice(idx, 0, upper); this.emit({ rect: null, structure: true }); },
          redo: () => { lower.surface.restore(after); this.layers.splice(idx, 1); this.emit({ rect: null, structure: true }); },
        });
        this.emit({ rect: null, structure: true });
        break;
      }
      case 'layer.clear': {
        const layer = this.layer(op.layer);
        if (!layer) return;
        const keys = [...layer.surface.tiles.keys()];
        this.pixelEdit(layer, keys, 'clear', undoable, () => { layer.surface.clear(); return null; });
        break;
      }
    }
    this.log.push(op);
  }

  /** Apply a pixel mutation to a layer, capturing before/after tiles for undo. */
  private pixelEdit(layer: Layer, keys: string[], label: string, undoable: boolean, mutate: () => Rect | null) {
    const before: TileSnapshot | null = undoable ? layer.surface.snapshot(keys) : null;
    const dirty = mutate();
    const after = layer.surface.snapshot(keys);
    layer.surface.prune(after);
    const rect = dirty ?? null;
    if (before) {
      const cost = keys.length * 2;
      this.history.push({
        label, cost,
        undo: () => { layer.surface.restore(before); this.emit({ rect, structure: true }); },
        redo: () => { layer.surface.restore(after); this.emit({ rect, structure: true }); },
      });
    }
    this.emit({ rect, structure: true });
  }

  private structural(undoable: boolean, label: string, undo: () => void, redo: () => void) {
    if (undoable) this.history.push({
      label, cost: 0,
      undo: () => { undo(); this.emit({ rect: null, structure: true }); },
      redo: () => { redo(); this.emit({ rect: null, structure: true }); },
    });
    this.emit({ rect: null, structure: true });
  }
}

export function newLayerProps(name: string): LayerProps {
  return { id: uid('ly_'), name, visible: true, opacity: 1, blend: 'normal', alphaLock: false };
}

export type { Selection };
