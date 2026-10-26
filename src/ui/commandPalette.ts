// Ctrl+K: type to find any command, with its shortcut.
import type { App } from './app';
import { commands } from './commands';
import { h } from './dom';
import { icon } from './icons';

export function commandPalette(app: App) {
  if (document.querySelector('.cmdk')) return;
  const all = commands(app).filter((c) => c.id !== 'commands');
  const input = h('input.cmdk-input', { type: 'search', placeholder: 'Type a command…', 'aria-label': 'Search commands', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div.cmdk-list', { role: 'listbox' });
  const back = h('div.cmdk', {}, h('div.panel.cmdk-panel', {}, input, list));
  let rows: { el: HTMLElement; run: () => void }[] = [], active = 0;
  const close = () => { back.remove(); window.removeEventListener('keydown', onKey, true); };
  const run = (i: number) => { const r = rows[i]; if (!r) return; close(); r.run(); };
  const mark = () => rows.forEach((r, i) => { r.el.classList.toggle('active', i === active); r.el.setAttribute('aria-selected', String(i === active)); if (i === active) r.el.scrollIntoView({ block: 'nearest' }); });
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = all.filter((c) => { const l = c.label.toLowerCase(); return words.every((w) => l.includes(w)); });
    rows = hits.map((c, i) => {
      const el = h('button.cmdk-row', { role: 'option', html: icon(c.icon, 16) + `<span>${c.label}</span>` + (c.key ? `<kbd>${c.key}</kbd>` : ''), onclick: () => run(i) });
      el.addEventListener('pointermove', () => { if (active !== i) { active = i; mark(); } });
      return { el, run: c.run };
    });
    list.replaceChildren(...rows.map((r) => r.el), rows.length ? '' : h('div.cmdk-empty', {}, 'No matching command'));
    active = Math.min(active, Math.max(0, rows.length - 1));
    mark();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % Math.max(1, rows.length); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    else if (e.key === 'Tab') e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => { active = 0; render(); });
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  render();
  input.focus();
}
