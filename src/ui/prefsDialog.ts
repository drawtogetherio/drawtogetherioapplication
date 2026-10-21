import { DEFAULT_KEYS, KEY_ACTIONS, KeyAction, MODES, Mode, actionFor, keyOf } from '../shared/prefs';
import type { App } from './app';
import { modal } from './dialogs';
import { clear, h } from './dom';
import { Slider } from './slider';

const MODE_LABELS: Record<Mode, string> = { dark: 'Dark', light: 'Light', system: 'System' };

export function preferencesDialog(app: App) {
  const ed = app.ed, p = ed.prefs;
  const changed = () => { app.applyPrefs(); app.savePrefs(); };

  const keyRows = h('div.pref-keys');
  const renderKeys = () => {
    clear(keyRows);
    for (const a of KEY_ACTIONS) {
      const k = keyOf(p, a.id);
      const chip = h('button.key-chip', { type: 'button', 'aria-label': `Shortcut for ${a.label}`, 'data-action': a.id }, k ? k.toUpperCase() : '—');
      chip.addEventListener('click', () => listen(chip, a.id));
      keyRows.append(h('label.pref-row', {}, h('span', {}, a.label), chip));
    }
  };
  const listen = (chip: HTMLElement, action: KeyAction) => {
    chip.classList.add('listening');
    chip.textContent = '…';
    const done = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', done, true);
      if (e.key !== 'Escape') {
        const k = e.key === 'Backspace' || e.key === 'Delete' ? '' : e.key.length === 1 && e.key !== ' ' ? e.key.toLowerCase() : null;
        if (k !== null) {
          const other = k && actionFor(p, k);
          if (other && other !== action) p.keys[other] = '';
          if (k === DEFAULT_KEYS[action]) delete p.keys[action]; else p.keys[action] = k;
          changed();
        }
      }
      renderKeys();
    };
    window.addEventListener('keydown', done, true);
  };
  renderKeys();
  const resetKeys = h('button.btn.small', { type: 'button', onclick: () => { p.keys = {}; changed(); renderKeys(); } }, 'Reset');

  const modes = h('div.segmented');
  const renderModes = () => {
    clear(modes);
    for (const m of MODES) {
      modes.append(h(`button${m === p.mode ? '.active' : ''}` as 'button', { type: 'button', onclick: () => { p.mode = m; changed(); renderModes(); } }, MODE_LABELS[m]));
    }
  };
  renderModes();

  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h('input', { type: 'checkbox', role: 'switch' });
    box.checked = get();
    box.addEventListener('change', () => { set(box.checked); changed(); });
    return h('label.switch-row', {}, h('span', {}, label), box);
  };
  const gamma = new Slider({
    min: 0.4, max: 2.5, value: p.pressureGamma, label: 'Pressure curve',
    format: (v) => (v < 0.95 ? 'Light ' : v > 1.05 ? 'Firm ' : 'Linear ') + v.toFixed(2),
    onInput: (v) => { p.pressureGamma = v; changed(); },
  });

  const section = (title: string, ...kids: (HTMLElement | null)[]) => h('section.pref-section', {}, h('h3', {}, title), ...kids);
  const body = h('div.modal-body.prefs', {},
    section('Appearance', app.themeRow(), h('div.pref-row', {}, h('span', {}, 'Mode'), modes)),
    section('Canvas',
      toggle('Brush outline on hover', () => p.hoverPreview, (v) => { p.hoverPreview = v; }),
      toggle('Name bubbles', () => p.showBubbles, (v) => { p.showBubbles = v; }),
      gamma.el,
    ),
    section('Shortcuts', keyRows, h('div.row', {}, h('small.muted', {}, 'Click a key, then press a new one. Backspace clears.'), resetKeys)),
  );
  modal('Preferences', body, []);
}
