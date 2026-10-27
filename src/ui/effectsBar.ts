import { type Adjustment, EFFECTS, EffectId, isAdjustment } from '../core/model';
import { ctx2d, rectFromPoints, rectIntersect, rectRoundOut, selPath, transformRect, uid } from '../core/geom';
import { ADJUST_DEFAULTS, EFFECT_INFO, EffectOp, effectReach } from '../engine/effects';
import type { Layer } from '../core/document';
import { curveEditor } from './curveEditor';
import { effectImage } from '../engine/offload';
import type { Editor } from '../editor';
import { h } from './dom';
import { icon } from './icons';
import { Slider } from './slider';

let closeOpen: (() => void) | null = null;

/**
 * Previews an effect on the canvas itself, from a bar under the selection (top centre for the whole layer), then bakes it in as one op.
 * On an adjustment layer it edits the layer's adjustment instead, live, and saves it on Apply.
 */
export function effectsBar(ed: Editor, initial: EffectId = 'blur', target?: Layer) {
  closeOpen?.();
  ed.commitPending();
  const layer = target ?? ed.layer;
  if (!layer || !ed.canEdit(layer.props.id)) { ed.toast('Pick a layer of yours first'); return; }
  const surface = ed.editSurface(layer), mask = ed.onMask;
  const view = ed.view, vp = view.viewport, stage = view.canvas.parentElement!;
  const sel = target ? null : ed.selection;
  const clip = sel ? selPath(sel) : null;
  const selBox = sel ? rectFromPoints(sel.pts) : null;
  const saved = target?.props.adjust ?? null;
  const state: { effect: EffectId; amount: number; angle: number; params?: number[]; colors?: string[] } = saved
    ? { effect: saved.effect, amount: saved.amount, angle: 0, params: saved.params, colors: saved.colors }
    : { effect: initial, amount: isAdjustment(initial) ? 1 : 0.3, angle: 0 };
  const adjustment = (): Adjustment => ({ effect: state.effect, amount: state.amount, params: state.params, colors: state.colors });
  const op = (): EffectOp => ({ t: 'effect', id: uid(), layer: layer.props.id, effect: state.effect, amount: state.amount, angle: state.effect === 'motion' ? state.angle : undefined, params: state.params, colors: state.colors, clip: sel ?? undefined, mask });

  let timer = 0, seq = 0;
  const render = () => {
    clearTimeout(timer);
    if (target) { target.props.adjust = adjustment(); view.invalidate(null); return; }
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

  const kinds = target ? EFFECTS.filter(isAdjustment) : EFFECTS;
  const select = h('select', { id: 'effect-kind', 'aria-label': 'Effect' }, ...kinds.map((e) => h('option', { value: e }, EFFECT_INFO[e].name)));
  select.value = state.effect;
  const amount = new Slider({ min: 0, max: 1, value: state.amount, label: EFFECT_INFO[state.effect].amount, format: (v) => Math.round(v * 100) + '%', onInput: (v) => { state.amount = v; render(); } });
  const angle = new Slider({ min: 0, max: 180, value: 0, label: 'Angle', format: (v) => Math.round(v) + '°', onInput: (v) => { state.angle = (v * Math.PI) / 180; render(); } });
  const controls = h('div.effect-row.adjust-row');
  /** The sliders, curve or colours an adjustment needs. */
  const buildControls = () => {
    controls.replaceChildren();
    const e = state.effect, d = ADJUST_DEFAULTS[e];
    controls.hidden = !d;
    if (!d) return;
    const p = state.params ?? (state.params = d.params ? [...d.params] : undefined);
    const sl = (label: string, i: number, min: number, max: number, fmt: (v: number) => string) =>
      new Slider({ min, max, value: p![i], label, format: fmt, onInput: (v) => { p![i] = Math.round(v * 1000) / 1000; render(); } }).el;
    const pct = (v: number) => Math.round(v * 100) + '%', signed = (v: number) => (v > 0 ? '+' : '') + Math.round(v * 100);
    if (e === 'hsb') controls.append(sl('Hue', 0, -1, 1, (v) => Math.round(v * 180) + '°'), sl('Saturation', 1, -1, 1, signed), sl('Brightness', 2, -1, 1, signed));
    else if (e === 'balance') controls.append(sl('Cyan – Red', 0, -1, 1, signed), sl('Magenta – Green', 1, -1, 1, signed), sl('Yellow – Blue', 2, -1, 1, signed));
    else if (e === 'levels') controls.append(sl('In black', 0, 0, 1, pct), sl('In white', 1, 0, 1, pct), sl('Gamma', 2, 0.1, 4, (v) => v.toFixed(2)), sl('Out black', 3, 0, 1, pct), sl('Out white', 4, 0, 1, pct));
    else if (e === 'curves') controls.append(curveEditor(p!, (pts) => { state.params = pts; render(); }));
    else if (e === 'gradientMap') {
      const cols = state.colors ?? (state.colors = [...d.colors!]);
      const row = h('div.swatch-row');
      const rebuild = () => {
        row.replaceChildren(...cols.map((c, i) => {
          const inp = h('input.swatch-input', { type: 'color', title: `Colour ${i + 1}` });
          inp.value = c;
          inp.addEventListener('input', () => { cols[i] = inp.value; render(); });
          return inp;
        }),
        h('button.btn.small', { type: 'button', title: 'Add a colour', onclick: () => { if (cols.length < 8) { cols.push(ed.color); rebuild(); render(); } } }, '+'),
        ...(cols.length > 2 ? [h('button.btn.small', { type: 'button', title: 'Remove the last colour', onclick: () => { cols.pop(); rebuild(); render(); } }, '−')] : []));
      };
      rebuild();
      controls.append(row);
    }
  };
  const sync = () => {
    const was = state.effect;
    state.effect = select.value as EffectId;
    if (was !== state.effect) { state.params = undefined; state.colors = undefined; if (isAdjustment(state.effect) !== isAdjustment(was)) amount.set(state.amount = isAdjustment(state.effect) ? 1 : 0.3); }
    amount.setLabel(EFFECT_INFO[state.effect].amount);
    angle.el.hidden = !EFFECT_INFO[state.effect].angle;
    buildControls();
    render();
    place();
  };
  select.addEventListener('change', sync);
  const bar = h('div.effect-bar', { role: 'dialog', 'aria-label': target ? 'Adjustment layer' : 'Layer effects' },
    h('div.effect-row', {},
      h('span.opt-title', {}, target ? 'Adjust' : 'Effect'), select, amount.el, angle.el,
      h('button.icon-btn', { type: 'button', title: 'Apply', 'aria-label': 'Apply', html: icon('check', 18), onclick: () => { close(); apply(); } }),
      h('button.icon-btn', { type: 'button', title: 'Cancel', 'aria-label': 'Cancel', html: icon('x', 18), onclick: () => close() })),
    controls,
    h('div.effect-note', {}, target ? 'Changes everything below this layer; paint its mask to limit where.' : (sel ? 'Only the selection changes. ' : '') + 'Bakes into the layer; undo works until it leaves the history.'));

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
  /** Bakes it in: the pixels are worked out in the worker, then land as one op. On an adjustment layer, saves the settings. */
  const apply = () => {
    if (!target) return ed.applyPrepared(op());
    ed.run([{ t: 'layer.props', id: uid(), layer: layer.props.id, props: { adjust: adjustment() } }], 'Adjustment');
  };
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
    if (target) { target.props.adjust = saved; view.invalidate(null); }
    view.live = null;
    view.invalidate(null);
    bar.remove();
    closeOpen = null;
  };
  closeOpen = close;
  stage.append(bar);
  sync();
}
