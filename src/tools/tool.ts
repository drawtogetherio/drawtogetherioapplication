export interface PointerInfo {
  x: number; y: number; // document coords
  sx: number; sy: number; // screen CSS px
  pressure: number; // 0..1 after the pressure curve
  type: 'pen' | 'mouse' | 'touch';
  shift: boolean; alt: boolean; ctrl: boolean;
}

export interface Tool {
  down(p: PointerInfo): void;
  move(p: PointerInfo): void;
  up(p: PointerInfo): void;
  /** Abort the current gesture without changing the document. */
  cancel(): void;
  /** True while a stroke/drag is in progress. */
  busy?(): boolean;
  /** Commit pending work (e.g. a selection transform). */
  commit?(): void;
  activate?(): void;
  deactivate?(): void;
  overlay?(ctx: CanvasRenderingContext2D, m: DOMMatrix): void;
}
