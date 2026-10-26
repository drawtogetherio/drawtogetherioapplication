export interface PointerInfo {
  x: number; y: number; // document coords
  sx: number; sy: number; // screen CSS px
  pressure: number; // 0..1 after the pressure curve
  type: 'pen' | 'mouse' | 'touch';
  shift: boolean; alt: boolean; ctrl: boolean;
  /** Pen tilt in degrees (-90..90 each way) and where the pen leans: altitude 0 (flat) .. π/2 (upright), azimuth 0..2π. */
  tiltX: number; tiltY: number; altitude: number; azimuth: number;
}

export interface Tool {
  down(p: PointerInfo): void;
  move(p: PointerInfo): void;
  up(p: PointerInfo): void;
  cancel(): void;
  busy?(): boolean;
  commit?(): void;
  activate?(): void;
  deactivate?(): void;
  overlay?(ctx: CanvasRenderingContext2D, m: DOMMatrix): void;
  /** Where the tool is drawing when that isn't under the pointer (stabilizer). */
  pen?(): { x: number; y: number } | null;
  /** Where the pointer is about to be (the browser's prediction), shown but never committed. */
  predict?(pts: PointerInfo[]): void;
}
