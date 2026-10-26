import { EFFECTS, EffectId } from '../core/model';
import { ctx2d, rectFromPoints, rectIntersect, rectRoundOut, selPath, transformRect, uid } from '../core/geom';
import { EFFECT_INFO, EffectOp, effectReach } from '../engine/effects';
import { effectImage } from '../engine/offload';
import type { Editor } from '../editor';
import { h } from './dom';
import { icon } from './icons';
import { Slider } from './slider';

let closeOpen: (() => void) | null = null;

/** Previews an effect on the canvas itself, from a bar under the selection (top centre for the whole layer), then bakes it in as one op. */
export function effectsBar(ed: Editor, initial: EffectId = 'blur') {
  closeOpen?.();
  ed.commitPending();
  const layer = ed.layer;
  if (!layer || !ed.canEdit(layer.props.id)) { ed.toast('Pick a layer of yours first'); return; }
  const surface = ed.editSurface(layer), mask = ed.onMask;
  const view = ed.view, vp = view.viewport, stage = view.canvas.parentElement!;
  const sel = ed.selection;
  const clip = sel ? selPath(sel) : null;
  const selBox = sel ? rectFromPoints(sel.pts) : null;
  const state = { effect: initial, amount: 0.3, angle: 0 };
  const op = (): EffectOp => ({ t: 'effect', id: uid(), layer: layer.props.id, effect: state.effect, amount: state.amount, angle: state.effect === 'motion' ? state.angle : undefined, clip: sel ?? undefined, mask });

  let timer = 0, seq = 0;
  const render = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const o = op(), reach = effectReach(o), n = ++seq;
      let region = surface.contentBounds();
      if (region && selBox) region = rectIntersect(region, selBox);
      // Only what is on screen gets processed, so the slider stays quick on big layers.
      if (region) region = rectIntersect(region, rectRoundOut(transformRect(vp.matrix().inverse(), { x: 0, y: 0, w: vp.w, h: vp.h }), reach));
      if (!region) { view.live = null; view.invalidate(null); return; }
      const r = rectRoundOut(region, reach);
      const src = surface.extract(r);
      const img = await effectImage(ctx2d(src, true).getImageData(0, 0, r.w, r.h), { ...o, id: 'preview' }, r.x, r.y);
      if (n !== seq || closeOpen !== close) return; // a newer slider value, or the bar closed meanwhile
      const c = ctx2d(src);
      c.putImageData(img, 0, 0);
      if (clip) { c.setTransform(1, 0, 0, 1, -r.x, -r.y); c.globalCompositeOperation = 'destination-in'; c.fill(clip, 'evenodd'); }
      const hole = new Path2D();
      hole.rect(r.x, r.y, r.w, r.h);
      // The processed pixels replace the layer's there, so the original never shows through.
      view.live = { layerId: layer.props.id, hole: clip ?? hole, floating: { canvas: src, x: r.x, y: r.y, m: new DOMMatrix() }, mask };
      view.invalidate(null);
    }, 40);
  };

  const select = h('select', { id: 'effect-kind', 'aria-label': 'Effect' }, ...EFFECTS.map((e) => h('option', { value: e }, EFFECT_INFO[e].name)));
  select.value = initial;
  const amount = new Slider({ min: 0, max: 1, value: state.amount, label: EFFECT_INFO[initial].amount, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { state.amount = v; render(); } });
  const angle = new Slider({ min: 0, max: 180, value: 0, label: 'Angle', format: (v) => Math.round(v) + '°', onInput: (v) => { state.angle = (v * Math.PI) / 180; render(); } });
  const sync = () => {
    state.effect = select.value as EffectId;
    amount.setLabel(EFFECT_INFO[state.effect].amount);
    angle.el.hidden = !EFFECT_INFO[state.effect].angle;
    render();
    place();
  };
  select.addEventListener('change', sync);
  const bar = h('div.effect-bar', { role: 'dialog', 'aria-label': 'Layer effects' },
    h('div.effect-row', {},
      h('span.opt-title', {}, 'Effect'), select, amount.el, angle.el,
      h('button.icon-btn', { type: 'button', title: 'Apply', 'aria-label': 'Apply', html: icon('check', 20), onclick: () => { close(); apply(); } }),
      h('button.icon-btn', { type: 'button', title: 'Cancel', 'aria-label': 'Cancel', html: icon('x', 20), onclick: () => close() })),
    h('div.effect-note', {}, (sel ? 'Only the selection changes. ' : '') + 'Bakes into the layer; undo works until it leaves the history.'));

  const place = () => {
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let x = (vp.w - bw) / 2, y = 12;
    if (selBox) {
      const s = transformRect(vp.matrix(), selBox);
      x = s.x + s.w / 2 - bw / 2;
      y = s.y + s.h + 14;
      if (y + bh > vp.h - 8) y = s.y - bh - 44;
    }
    bar.style.left = `${Math.round(Math.max(8, Math.min(vp.w - bw - 8, x)))}px`;
    bar.style.top = `${Math.round(Math.max(8, y))}px`;
  };
  const onView = vp.onChange;
  vp.onChange = () => { onView(); place(); render(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    e.stopPropagation();
    e.preventDefault();
    close();
    if (e.key === 'Enter') apply();
  };
  /** Bakes it in: the pixels are worked out in the worker, then land as one op. */
  const apply = () => ed.applyPrepared(op());
  const onDraw = (e: PointerEvent) => { if (!bar.contains(e.target as Node)) close(); };
  document.addEventListener('keydown', onKey, true);
  view.canvas.addEventListener('pointerdown', onDraw, true);
  // Strokes landing on this layer (other people's too) re-render the preview; the bar only closes when the layer or document goes.
  const unsub = ed.on((w) => {
    if (w === 'doc' || (w === 'layers' && !ed.doc.layer(layer.props.id))) close();
    else if (w === 'pixels:' + layer.props.id) render();
  });
  const close = () => {
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    view.canvas.removeEventListener('pointerdown', onDraw, true);
    unsub();
    vp.onChange = onView;
    view.live = null;
    view.invalidate(null);
    bar.remove();
    closeOpen = null;
  };
  closeOpen = close;
  stage.append(bar);
  sync();
}
