import { MAX_CURVE_POINTS, curveAt } from '../shared/curve';
import { h } from './dom';

const W = 260, H = 170, PAD = 12;

/** Drag points to shape the curve; click empty space to add one, drag a point off the edge to remove it. */
export function curveEditor(points: number[], onChange: (pts: number[]) => void): HTMLElement {
  const pts = [...points];
  const canvas = h('canvas.curve-editor', { width: W * 2, height: H * 2, style: `width:${W}px;height:${H}px`, 'aria-label': 'Pressure curve' });
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  const toPx = (x: number, y: number) => ({ x: PAD + x * (W - PAD * 2), y: H - PAD - y * (H - PAD * 2) });
  const fromPx = (px: number, py: number) => ({ x: (px - PAD) / (W - PAD * 2), y: (H - PAD - py) / (H - PAD * 2) });
  const css = (name: string) => getComputedStyle(canvas).getPropertyValue(name).trim();

  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const a = toPx(i / 4, 0), b = toPx(i / 4, 1), c = toPx(0, i / 4), d = toPx(1, i / 4);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const p = toPx(i / 100, curveAt(pts, i / 100));
      if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.fillStyle = css('--text');
    for (let i = 0; i < pts.length; i += 2) {
      const p = toPx(pts[i], pts[i + 1]);
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
    }
  };

  const local = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const nearest = (px: number, py: number) => {
    let best = -1, bd = 12;
    for (let i = 0; i < pts.length; i += 2) {
      const p = toPx(pts[i], pts[i + 1]);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  let drag = -1;
  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = local(e);
    drag = nearest(x, y);
    if (drag < 0) {
      if (pts.length >= MAX_CURVE_POINTS * 2) return;
      const p = fromPx(x, y);
      const nx = Math.min(0.99, Math.max(0.01, p.x));
      let i = 2;
      while (i < pts.length && pts[i] < nx) i += 2;
      pts.splice(i, 0, nx, Math.min(1, Math.max(0, p.y)));
      drag = i;
    }
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const { x, y } = local(e);
    const p = fromPx(x, y);
    const end = drag === 0 || drag === pts.length - 2;
    if (!end && (x < -20 || x > W + 20 || y < -20 || y > H + 20)) { pts.splice(drag, 2); drag = -1; draw(); onChange([...pts]); return; }
    if (!end) pts[drag] = Math.min(pts[drag + 2] - 0.01, Math.max(pts[drag - 2] + 0.01, p.x));
    pts[drag + 1] = Math.min(1, Math.max(0, p.y));
    draw();
  });
  const release = () => { if (drag >= 0) { drag = -1; onChange([...pts]); } };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  requestAnimationFrame(draw);
  return canvas;
}
