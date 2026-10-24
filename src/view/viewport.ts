import { Point, Rect, clamp } from '../core/geom';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export class Viewport {
  cx = 0; cy = 0; // document point shown at the screen centre
  zoom = 1;
  rot = 0; // radians
  flipX = 1; flipY = 1;
  w = 1; h = 1; // screen size, CSS px
  onChange: () => void = () => {};

  matrix(): DOMMatrix {
    return new DOMMatrix()
      .translateSelf(this.w / 2, this.h / 2)
      .rotateSelf((this.rot * 180) / Math.PI)
      .scaleSelf(this.zoom * this.flipX, this.zoom * this.flipY)
      .translateSelf(-this.cx, -this.cy);
  }

  toDoc(sx: number, sy: number): Point {
    const p = this.matrix().inverse().transformPoint({ x: sx, y: sy });
    return { x: p.x, y: p.y };
  }

  toScreen(x: number, y: number): Point {
    const p = this.matrix().transformPoint({ x, y });
    return { x: p.x, y: p.y };
  }

  setFromMatrix(m: DOMMatrixReadOnly) {
    const det = m.a * m.d - m.b * m.c;
    this.zoom = clamp(Math.sqrt(Math.abs(det)), MIN_ZOOM, MAX_ZOOM);
    this.rot = Math.atan2(m.b * this.flipX, m.a * this.flipX);
    const c = m.inverse().transformPoint({ x: this.w / 2, y: this.h / 2 });
    this.cx = c.x; this.cy = c.y;
    this.onChange();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const z = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const m = new DOMMatrix().translateSelf(sx, sy).scaleSelf(z / this.zoom).translateSelf(-sx, -sy).multiplySelf(this.matrix());
    this.setFromMatrix(m);
  }

  panBy(dx: number, dy: number) {
    this.setFromMatrix(new DOMMatrix().translateSelf(dx, dy).multiplySelf(this.matrix()));
  }

  /** Fits `r` on screen, turned by `rot`: the rotated box is what has to fit. */
  fit(r: Rect, margin = 40, rot = 0) {
    this.rot = rot;
    this.cx = r.x + r.w / 2; this.cy = r.y + r.h / 2;
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    const w = r.w * c + r.h * s, h = r.w * s + r.h * c;
    this.zoom = clamp(Math.min((this.w - margin * 2) / w, (this.h - margin * 2) / h), MIN_ZOOM, 1);
    this.onChange();
  }

  flip(horizontal: boolean) {
    if (horizontal) this.flipX *= -1; else this.flipY *= -1;
    this.rot = -this.rot;
    this.onChange();
  }
}
