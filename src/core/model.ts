// Every change to pixels or layers is a serialisable Op, applied deterministically everywhere.

export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken',
  lighten: 'Lighten', 'color-dodge': 'Color Dodge', 'color-burn': 'Color Burn', 'hard-light': 'Hard Light',
  'soft-light': 'Soft Light', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue',
  saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity', add: 'Add (Linear Dodge)',
};

export function blendOp(b: BlendMode): GlobalCompositeOperation {
  return b === 'normal' ? 'source-over' : b === 'add' ? 'lighter' : b;
}

export interface LayerProps {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blend: BlendMode;
  alphaLock: boolean; // paint only where the layer already has pixels
  /** Shows only where the first unclipped layer below it in the same folder has pixels. */
  clip?: boolean;
  /** Has a mask: painted mask pixels hide the layer there, erasing them shows it again. */
  mask?: boolean;
  /** Creator in a room; only they or a host may edit it. */
  owner?: string;
  /** An adjustment layer: no pixels of its own, it recolours what lies below (its mask limits where). */
  adjust?: Adjustment | null;
}

export interface FolderProps {
  id: string;
  name: string;
  visible: boolean;
  owner?: string;
  /** A member's top-level folder in a room. */
  user?: boolean;
  color?: string | null;
}

export interface DocSettings {
  id: string;
  width: number; // ignored for infinite canvases
  height: number;
  infinite: boolean;
  background: string | null;
}

export interface BrushParams {
  size: number; // max diameter in px
  opacity: number; // whole-stroke opacity 0..1
  flow: number; // per-dab alpha 0..1
  hardness: number; // 0 (soft) .. 1 (hard edge)
  spacing: number; // dab spacing as a fraction of diameter
  pressureSize: number; // 0..1: how much pressure affects size
  pressureFlow: number; // 0..1: how much pressure affects flow
  minSize: number; // fraction of size at zero pressure
  smoothing: number; // 0..1 streamline
  /** Dab shape; round unless set. */
  shape?: 'round' | 'square';
  /** 0..1 how much paper grain breaks the dab up; the texture is fixed to the canvas so strokes line up. */
  grain?: number;
  /** Grain texture scale, 1 = fine. */
  grainScale?: number;
}

export const EFFECTS = ['blur', 'motion', 'mosaic', 'chroma', 'glitch', 'sharpen', 'noise', 'hsb', 'balance', 'curves', 'levels', 'invert', 'gradientMap'] as const;
export type EffectId = (typeof EFFECTS)[number];
/** Colour adjustments: pointwise, so they can also live on an adjustment layer. */
export const ADJUSTMENTS: EffectId[] = ['hsb', 'balance', 'curves', 'levels', 'invert', 'gradientMap'];
export const isAdjustment = (e: EffectId) => ADJUSTMENTS.includes(e);
/** A colour adjustment with its settings; on a layer it applies to everything beneath. */
export interface Adjustment { effect: EffectId; amount: number; params?: number[]; colors?: string[] }

/** A polygon; `holes` are rings cut out of it (magic wand). */
export interface Selection { pts: number[]; holes?: number[][] }

export interface GradientStop { at: number; color: string; alpha: number }

export type ShapeKind = 'line' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'arrow' | 'bubble' | 'polyline' | 'curve' | 'arc';
export const SHAPE_KINDS_ALL: ShapeKind[] = ['line', 'rect', 'ellipse', 'polygon', 'star', 'arrow', 'bubble', 'polyline', 'curve', 'arc'];
/** Shapes drawn by clicking points rather than dragging a box. */
export const POINT_SHAPES: ShapeKind[] = ['polyline', 'curve', 'arc'];

/** `mask: true` on a pixel edit aims it at the layer's mask instead of its pixels. */
interface OpBase { id: string; author?: string; mask?: boolean; /** When the room took it (ms). */ at?: number }

export type Op =
  | (OpBase & {
      t: 'stroke'; layer: string; erase: boolean; brush: BrushParams; color: string;
      /** Raw samples, flat x, y, pressure; smoothing happens when rendering. */
      pts: number[]; clip?: Selection;
    })
  /** Drags the layer's own pixels along the path; flow is the strength. */
  | (OpBase & { t: 'smudge'; layer: string; brush: BrushParams; pts: number[]; clip?: Selection })
  /** Baked into the layer's pixels once, the same way everywhere; `angle` only for motion blur. */
  | (OpBase & { t: 'effect'; layer: string; effect: EffectId; amount: number; angle?: number; params?: number[]; colors?: string[]; clip?: Selection })
  | (OpBase & {
      t: 'shape'; layer: string; shape: ShapeKind; x0: number; y0: number; x1: number; y1: number;
      width: number; fill: boolean; color: string; opacity: number; erase: boolean; clip?: Selection;
      /** Corners of a polygon or points of a star. */ sides?: number;
      /** x,y pairs for point shapes; an arc is start, a point on it, end. */ pts?: number[];
    })
  | (OpBase & {
      t: 'fill'; layer: string; x: number; y: number; color: string; tolerance: number;
      sampleAll: boolean; expand: number; region: { x: number; y: number; w: number; h: number }; clip?: Selection;
    })
  /** A lasso filled with colour; `inside` fills only the parts closed off by lines. */
  | (OpBase & {
      t: 'gradient'; layer: string; kind: 'linear' | 'radial'; x0: number; y0: number; x1: number; y1: number;
      stops: GradientStop[]; opacity: number; region: { x: number; y: number; w: number; h: number }; clip?: Selection;
    })
  | (OpBase & {
      t: 'fillPoly'; layer: string; pts: number[]; color: string; inside: boolean; tolerance: number;
      sampleAll: boolean; expand: number; region: { x: number; y: number; w: number; h: number }; clip?: Selection;
    })
  | (OpBase & {
      t: 'transform'; layer: string; sel: Selection;
      m: [number, number, number, number, number, number];
    })
  | (OpBase & { t: 'layer.add'; layer: LayerProps; parent: string | null; index: number; copyOf?: string })
  | (OpBase & { t: 'layer.remove'; layer: string })
  | (OpBase & { t: 'layer.props'; layer: string; props: Partial<Omit<LayerProps, 'id' | 'owner'>> })
  | (OpBase & { t: 'layer.merge'; layer: string /* merged down into the layer below */ })
  | (OpBase & { t: 'layer.clear'; layer: string })
  /** Bakes the mask into the pixels and drops it. */
  | (OpBase & { t: 'layer.mask.apply'; layer: string })
  | (OpBase & { t: 'folder.add'; folder: FolderProps; parent: string | null; index: number })
  | (OpBase & { t: 'folder.remove'; folder: string })
  | (OpBase & { t: 'folder.props'; folder: string; props: Partial<Pick<FolderProps, 'name' | 'visible' | 'color'>> })
  /** index counts from the bottom. */
  | (OpBase & { t: 'node.move'; node: string; parent: string | null; index: number })
  /** Raw tile pixels as PNG data URLs (undo/redo). `img` is the decoded local copy, never sent. */
  | (OpBase & { t: 'tiles'; layer: string; tiles: Record<string, string | null>; img?: Record<string, ImageData | null> });

export type OpType = Op['t'];
