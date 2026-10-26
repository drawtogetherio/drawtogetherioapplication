import { DEFAULT_KEYS, KEY_ACTIONS, KeyAction, MODES, Mode, PANELS, REMOTE_EVERY, actionFor, keyOf } from '../shared/prefs';
import { DEFAULT_CURVE } from '../shared/curve';
import type { App } from './app';
import { curveEditor } from './curveEditor';
import { modal } from './dialogs';
import { clear, h } from './dom';
import { Slider } from './slider';
import { native } from '../io/native';
import { LOGO_SVG, WORDMARK_SVG } from '../site/brand';
import { describe } from './memory';
import { penTestPad } from './penTest';

const MODE_LABELS: Record<Mode, string> = { dark: 'Dark', light: 'Light', system: 'System' };
const GROUPS = ['Appearance', 'Layout', 'Canvas', 'Pressure', 'Performance', 'Shortcuts', 'About'] as const;

export function preferencesDialog(app: App, open: (typeof GROUPS)[number] = 'Appearance') {
  const ed = app.ed, p = ed.prefs;
  const changed = () => { app.applyPrefs(); app.savePrefs(); };
  const row = (label: string, control: HTMLElement) => h('div.pref-row', {}, h('span', {}, label), control);
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = h('input', { type: 'checkbox', role: 'switch' });
    box.checked = get();
    box.addEventListener('change', () => { set(box.checked); changed(); });
    return h('label.switch-row', {}, h('span', {}, label), box);
  };
  const segmented = <T extends string | number>(items: T[], label: (v: T) => string, get: () => T, set: (v: T) => void) => {
    const el = h('div.segmented');
    const render = () => {
      clear(el);
      for (const v of items) el.append(h(`button${v === get() ? '.active' : ''}` as 'button', { type: 'button', onclick: () => { set(v); changed(); render(); } }, label(v)));
    };
    render();
    return el;
  };

  const appearance = () => [app.themeRow(), row('Mode', segmented(MODES, (m) => MODE_LABELS[m], () => p.mode, (m) => { p.mode = m; }))];

  const layout = () => {
    const panels = h('div.pref-stack');
    const render = () => {
      panels.hidden = p.layout !== 'studio';
      panels.replaceChildren(
        h('small.muted', {}, 'Drag a panel by its title to move it; drop it on an edge to dock it. Studio panels:'),
        ...PANELS.map((pn) => toggle(pn.label, () => p.panels[pn.id].show, (v) => { p.panels[pn.id].show = v; })),
        h('div.row', {}, h('button.btn.small', { type: 'button', onclick: () => { app.resetLayout(); } }, 'Reset layout')),
      );
    };
    render();
    return [row('Layout', segmented(['classic', 'studio'] as const, (v) => (v === 'classic' ? 'Simple' : 'Studio'), () => p.layout, (v) => { p.layout = v; render(); })), panels,
      toggle('Show the canvas overview (minimap)', () => p.minimap, (v) => { p.minimap = v; }),
      toggle('Left-handed: tools on the left, sliders on the right', () => p.leftHanded, (v) => { p.leftHanded = v; })];
  };

  const canvas = () => [
    toggle('Brush outline on hover', () => p.hoverPreview, (v) => { p.hoverPreview = v; }),
    toggle('Name bubbles', () => p.showBubbles, (v) => { p.showBubbles = v; }),
    toggle('Chime when mentioned', () => p.chime, (v) => { p.chime = v; }),
    toggle('Draw with a finger', () => p.fingerDraws, (v) => { p.fingerDraws = v; }),
  ];

  const pressure = () => {
    const body = h('div.pref-stack');
    const render = () => {
      clear(body);
      if (p.pressureMode === 'simple') {
        body.append(new Slider({
          min: 0.4, max: 2.5, value: p.pressureGamma, label: 'Pressure curve',
          format: (v) => (v < 0.95 ? 'Light ' : v > 1.05 ? 'Firm ' : 'Linear ') + v.toFixed(2),
          onInput: (v) => { p.pressureGamma = v; changed(); },
        }).el);
      } else {
        body.append(
          curveEditor(p.pressureCurve, (pts) => { p.pressureCurve = pts; changed(); }),
          h('div.row', {}, h('small.muted', {}, 'Drag points. Click to add one, drag it off the graph to remove.'),
            h('button.btn.small', { type: 'button', onclick: () => { p.pressureCurve = [...DEFAULT_CURVE]; changed(); render(); } }, 'Reset')),
        );
      }
    };
    render();
    return [row('Editor', segmented(['simple', 'advanced'] as const, (v) => (v === 'simple' ? 'Simple' : 'Advanced'), () => p.pressureMode, (v) => { p.pressureMode = v; render(); })), body, penTestPad(ed)];
  };

  const shortcuts = () => {
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
    return [keyRows, h('div.row', {}, h('small.muted', {}, 'Click a key, then press a new one. Backspace clears.'),
      h('button.btn.small', { type: 'button', onclick: () => { p.keys = {}; changed(); renderKeys(); } }, 'Reset')),
      h('div.shortcuts', { html: '<strong>Ctrl+K</strong> every command, searchable · <strong>Tab</strong> hide the UI · <strong>F6</strong> move keyboard focus between bars · <strong>Ctrl+Z / Y</strong> undo, redo · <strong>Ctrl+A / D</strong> select all, deselect · <strong>Alt+Backspace</strong> fill' })];
  };

  const performance = () => [
    h('small.muted', {}, 'For slow devices in busy rooms. Your own drawing is never delayed.'),
    toggle('Show others’ strokes as they draw', () => p.showLive, (v) => { p.showLive = v; }),
    row('Others’ edits land', segmented([...REMOTE_EVERY], (v) => (v ? `every ${v}s` : 'at once'), () => p.remoteEvery, (v) => { p.remoteEvery = v; })),
    toggle('Low-latency canvas', () => p.lowLatency, (v) => { p.lowLatency = v; }),
    h('small.muted', {}, 'Low latency puts the line on screen a frame sooner. Turn it off if the canvas tears or flickers.'),
    row('Canvas memory', memoryText()),
    h('small.muted', {}, 'Pixels and undo history held in memory. Undo history is kept shorter as it climbs; past the limit, Safari may drop the page.'),
  ];
  const memoryText = () => {
    const el = h('span.muted', {}, describe(app.memory.reading));
    const off = app.memory.on((r) => { if (!el.isConnected) { off(); return; } el.textContent = describe(r); });
    return el;
  };

  const about = () => {
    const rows = [
      h('div.about-brand', { html: LOGO_SVG + WORDMARK_SVG }),
      row('Doodlehive', h('span.muted', {}, `v${__APP_VERSION__}`)),
    ];
    if (native) rows.push(row(native.version === 'ipad' ? 'iPad app' : 'Desktop app', h('span.muted', {}, native.version === 'ipad' ? 'installed' : `v${native.version || '?'}`)));
    rows.push(row('Logo design', h('a.about-link', { href: 'https://www.fiverr.com/logocraftz', target: '_blank', rel: 'noopener noreferrer' }, 'Logocraftz')));
    return rows;
  };

  const pages = { Appearance: appearance, Layout: layout, Canvas: canvas, Pressure: pressure, Performance: performance, Shortcuts: shortcuts, About: about };
  const page = h('div.pref-page');
  const nav = h('nav.pref-nav', { 'aria-label': 'Preference groups' });
  const show = (g: (typeof GROUPS)[number]) => {
    for (const b of nav.children) b.classList.toggle('active', (b as HTMLElement).dataset.group === g);
    page.replaceChildren(h('h3', {}, g), ...pages[g]());
  };
  for (const g of GROUPS) nav.append(h('button.pref-group', { type: 'button', 'data-group': g, onclick: () => show(g) }, g));
  show(open);
  modal('Preferences', h('div.modal-body.prefs', {}, nav, page), []);
}
