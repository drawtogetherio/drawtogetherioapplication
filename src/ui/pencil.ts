import type { App } from './app';
import type { ToolId } from '../editor';
import { ipad, listen, PencilGesture, SystemPencilAction } from '../io/ipad';
import type { PencilAction } from '../shared/prefs';
import { dismissOnOutside, h } from './dom';
import { icon } from './icons';

// Apple Pencil double-tap and squeeze in the iPad app. Each follows its preference, and 'system' follows
// what the person picked in iPadOS Settings → Apple Pencil, so it behaves like it does in other drawing apps.

const FROM_SYSTEM: Record<SystemPencilAction, PencilAction> = {
  switchEraser: 'eraser', switchPrevious: 'previous', showColorPalette: 'color', showInkAttributes: 'brushes',
  showContextualPalette: 'palette', ignore: 'off', runSystemShortcut: 'off',
};

const PALETTE_TOOLS: { id: ToolId; label: string }[] = [
  { id: 'brush', label: 'Brush' }, { id: 'eraser', label: 'Eraser' }, { id: 'smudge', label: 'Smudge' },
  { id: 'fill', label: 'Fill' }, { id: 'select', label: 'Selection' }, { id: 'eyedropper', label: 'Eyedropper' },
];

export function pencilGestures(app: App) {
  const plugin = ipad.app;
  if (!plugin) return;
  const palette = h('div.popover.pencil-palette', { hidden: true, role: 'dialog', 'aria-label': 'Quick palette' });
  document.body.append(palette);
  dismissOnOutside(palette, [], () => { palette.hidden = true; });
  listen<PencilGesture>(plugin, 'pencilTap', (g) => run(app, palette, app.ed.prefs.pencilTap, g));
  listen<PencilGesture>(plugin, 'pencilSqueeze', (g) => run(app, palette, app.ed.prefs.pencilSqueeze, g));
}

function run(app: App, palette: HTMLElement, pref: PencilAction, g: PencilGesture) {
  const ed = app.ed;
  if (app.home.visible || ed.readOnly) return;
  const action = pref === 'system' ? FROM_SYSTEM[g.action] ?? 'off' : pref;
  if (action !== 'palette') palette.hidden = true;
  switch (action) {
    case 'eraser': {
      const back = ed.prevToolId === 'eraser' ? 'brush' : ed.prevToolId;
      ed.setTool(ed.toolId === 'eraser' ? back : 'eraser');
      app.toast(ed.toolId === 'eraser' ? 'Eraser' : PALETTE_TOOLS.find((t) => t.id === ed.toolId)?.label ?? 'Brush');
      break;
    }
    case 'previous': ed.setTool(ed.prevToolId); break;
    case 'color': app.toggleColor(); break;
    case 'brushes': app.toggleBrushLibrary(); break;
    case 'undo': ed.undo(); break;
    case 'palette': showPalette(app, palette, g); break;
  }
}

/** Tools, recent colours and undo/redo where the Pencil hovers, or in the middle of the screen. */
function showPalette(app: App, el: HTMLElement, g: PencilGesture) {
  if (!el.hidden) { el.hidden = true; return; }
  const ed = app.ed;
  const close = () => { el.hidden = true; };
  const tools = h('div.pp-row', {}, ...PALETTE_TOOLS.map((t) => h(`button.icon-btn${t.id === ed.toolId ? '.active' : ''}` as 'button', {
    type: 'button', title: t.label, 'aria-label': t.label, html: icon(t.id, 22), onclick: () => { ed.setTool(t.id); close(); },
  })));
  const colors = ed.recentColors.slice(0, 8);
  const swatches = colors.length ? h('div.pp-row.pp-colors', {}, ...colors.map((c) => h('button.pp-swatch', {
    type: 'button', title: c, 'aria-label': `Colour ${c}`, style: `background:${c}`, onclick: () => { ed.setColor(c, true); close(); },
  }))) : null;
  const history = h('div.pp-row', {},
    h('button.icon-btn', { type: 'button', title: 'Undo', 'aria-label': 'Undo', html: icon('undo', 22), disabled: !ed.doc.history.canUndo, onclick: () => ed.undo() }),
    h('button.icon-btn', { type: 'button', title: 'Redo', 'aria-label': 'Redo', html: icon('redo', 22), disabled: !ed.doc.history.canRedo, onclick: () => ed.redo() }),
    h('button.icon-btn', { type: 'button', title: 'Colour', 'aria-label': 'Colour', html: `<span class="pp-current" style="background:${ed.color}"></span>`, onclick: () => { close(); app.toggleColor(); } }),
    h('button.icon-btn', { type: 'button', title: 'Brush library', 'aria-label': 'Brush library', html: icon('brush', 22), onclick: () => { close(); app.toggleBrushLibrary(); } }),
  );
  el.replaceChildren(h('div.panel', {}, tools, swatches, history));
  el.hidden = false;
  const w = el.offsetWidth, hh = el.offsetHeight;
  const x = g.hover && g.x != null ? g.x : innerWidth / 2, y = g.hover && g.y != null ? g.y : innerHeight / 2;
  // Centred over the tip, kept on screen.
  el.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)))}px`;
  el.style.top = `${Math.round(Math.max(8, Math.min(innerHeight - hh - 8, y - hh / 2)))}px`;
}
