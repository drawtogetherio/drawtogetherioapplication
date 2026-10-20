// The document model. Everything that changes pixels or layers is described as a
// serialisable Op. Ops are applied deterministically by DrawDoc.apply(), so a remote
// collaborator can later receive the same Op stream and reproduce the same canvas.

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

/** Canvas2D composite operation for a layer blend mode. */
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
}

export interface DocSettings {
  id: string;
  width: number; // ignored for infinite canvases
  height: number;
  infinite: boolean;
  /** Paper colour, or null for transparent. */
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
}

/** A selection outline in document coordinates (closed polygon, flat x,y list). */
export interface Selection { pts: number[] }

export type ShapeKind = 'line' | 'rect' | 'ellipse';

interface OpBase { id: string; author?: string }

export type Op =
  | (OpBase & {
      t: 'stroke'; layer: string; erase: boolean; brush: BrushParams; color: string;
      /** Raw input samples, flat [x, y, pressure, ...]. Smoothing is applied by the renderer. */
      pts: number[]; clip?: Selection;
    })
  | (OpBase & {
      t: 'shape'; layer: string; shape: ShapeKind; x0: number; y0: number; x1: number; y1: number;
      width: number; fill: boolean; color: string; opacity: number; erase: boolean; clip?: Selection;
    })
  | (OpBase & {
      t: 'fill'; layer: string; x: number; y: number; color: string; tolerance: number;
      sampleAll: boolean; expand: number; region: { x: number; y: number; w: number; h: number }; clip?: Selection;
    })
  | (OpBase & {
      t: 'transform'; layer: string; sel: Selection;
      /** Matrix a,b,c,d,e,f mapping the lifted pixels to their new place. */
      m: [number, number, number, number, number, number];
    })
  | (OpBase & { t: 'layer.add'; layer: LayerProps; index: number; copyOf?: string })
  | (OpBase & { t: 'layer.remove'; layer: string })
  | (OpBase & { t: 'layer.props'; layer: string; props: Partial<Omit<LayerProps, 'id'>> })
  | (OpBase & { t: 'layer.move'; layer: string; index: number })
  | (OpBase & { t: 'layer.merge'; layer: string /* merged down into the layer below */ })
  | (OpBase & { t: 'layer.clear'; layer: string });

export type OpType = Op['t'];
