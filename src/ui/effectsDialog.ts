import { EFFECTS, EffectId } from '../core/model';
import { ctx2d, makeCanvas, polyPath, rectFromPoints, uid } from '../core/geom';
import { EFFECT_INFO, EffectOp, applyEffect } from '../engine/effects';
import type { Editor } from '../editor';
import { modal } from './dialogs';
import { h } from './dom';
import { Slider } from './slider';

const PW = 560, PH = 220;

/** Picks an effect for the active layer, previews it on a 1:1 crop, and bakes it in as one op. */
export function effectsDialog(ed: Editor, initial: EffectId = 'blur') {
  ed.commitPending();
  const layer = ed.layer;
  if (!layer || !ed.canEdit(layer.props.id)) { ed.toast('Pick a layer of yours first'); return; }
  const state = { effect: initial, amount: 0.3, angle: 0 };
  const select = h('select', { id: 'effect-kind', 'aria-label': 'Effect' }, ...EFFECTS.map((e) => h('option', { value: e, selected: e === initial ? 'selected' : null }, EFFECT_INFO[e].name)));
  select.value = initial;
  const preview = makeCanvas(PW, PH);
  preview.className = 'effect-preview';
  const amountLabel = h('span.opt-label');
  // Crop around the middle of the layer's content, or the selection.
  const focus = ed.selection ? rectFromPoints(ed.selection.pts) : layer.surface.contentBounds();
  const cx = focus ? focus.x + focus.w / 2 : 0, cy = focus ? focus.y + focus.h / 2 : 0;
  const crop = { x: Math.round(cx - PW / 2), y: Math.round(cy - PH / 2), w: PW, h: PH };
  const clipPath = ed.selection ? polyPath(ed.selection.pts) : null;
  const op = (): EffectOp => ({ t: 'effect', id: uid(), layer: layer.props.id, effect: state.effect, amount: state.amount, angle: state.effect === 'motion' ? state.angle : undefined, clip: ed.selection ?? undefined });
  let timer = 0;
  const render = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const src = layer.surface.extract(crop);
      const img = ctx2d(src, true).getImageData(0, 0, PW, PH);
      applyEffect(img, { ...op(), id: 'preview' }, crop.x, crop.y);
      const done = makeCanvas(PW, PH);
      ctx2d(done).putImageData(img, 0, 0);
      const c = ctx2d(preview);
      c.fillStyle = ed.doc.settings.background ?? '#ffffff';
      c.fillRect(0, 0, PW, PH);
      // Outside a selection the layer stays as it is; only the selected area shows the effect.
      if (clipPath) c.drawImage(src, 0, 0);
      c.save();
      c.translate(-crop.x, -crop.y);
      if (clipPath) c.clip(clipPath);
      c.drawImage(done, crop.x, crop.y);
      c.restore();
    }, 60);
  };
  const amount = new Slider({ min: 0, max: 1, value: state.amount, label: 'Amount', format: (v) => Math.round(v * 100) + '%', onInput: (v) => { state.amount = v; render(); } });
  const angle = new Slider({ min: 0, max: 180, value: 0, label: 'Angle', format: (v) => Math.round(v) + '°', onInput: (v) => { state.angle = (v * Math.PI) / 180; render(); } });
  const angleRow = h('div.row', { hidden: true }, angle.el);
  const sync = () => {
    state.effect = select.value as EffectId;
    amountLabel.textContent = EFFECT_INFO[state.effect].amount;
    angleRow.hidden = !EFFECT_INFO[state.effect].angle;
    render();
  };
  select.addEventListener('change', sync);
  const apply = h('button.btn.primary', { type: 'button', onclick: () => { close(); ed.apply(op(), {}); } }, 'Apply');
  const close = modal('Layer effects', h('div.modal-body.effects', {},
    h('div.row', {}, select, amountLabel),
    amount.el, angleRow,
    preview,
    h('p.muted.small', {}, (ed.selection ? 'Only the selected area changes. ' : '') + 'The effect is baked into the layer. Undo takes it back, but once it drops out of the undo history it can’t be undone.'),
  ), [apply]);
  sync();
}
