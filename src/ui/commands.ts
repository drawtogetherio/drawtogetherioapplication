// Everything the quick menu and the command palette can run, with the shortcut each shows.
import type { App } from './app';
import { keyOf } from '../shared/prefs';
import type { KeyAction } from '../shared/prefs';
import { TOOLS } from '../editor';

export interface Command { id: string; label: string; icon: string; key?: string; run: () => void }

const show = (k: string) => (k.length === 1 ? k.toUpperCase() : k);

export function commands(app: App): Command[] {
  const ed = app.ed, p = ed.prefs;
  const key = (a: KeyAction) => keyOf(p, a) ? show(keyOf(p, a)) : undefined;
  const list: Command[] = [
    ...TOOLS.map((t) => ({ id: t.id, label: t.label, icon: t.id, key: key(t.id as KeyAction), run: () => ed.setTool(t.id) })),
    { id: 'undo', label: 'Undo', icon: 'undo', key: 'Ctrl+Z', run: () => ed.undo() },
    { id: 'redo', label: 'Redo', icon: 'redo', key: 'Ctrl+Y', run: () => ed.redo() },
    { id: 'flipH', label: 'Flip canvas horizontally', icon: 'flipH', key: key('flipH'), run: () => ed.view.viewport.flip(true) },
    { id: 'flipV', label: 'Flip canvas vertically', icon: 'flipV', key: key('flipV'), run: () => ed.view.viewport.flip(false) },
    { id: 'fit', label: 'Fit to screen', icon: 'fit', key: key('fit'), run: () => ed.fitView() },
    { id: 'zoomIn', label: 'Zoom in', icon: 'plus', key: key('zoomIn'), run: () => app.zoomCenter(1.25) },
    { id: 'zoomOut', label: 'Zoom out', icon: 'fit', key: key('zoomOut'), run: () => app.zoomCenter(0.8) },
    { id: 'focus', label: 'Focus mode', icon: 'fit', key: key('focus'), run: () => app.toggleFocus() },
    { id: 'hideUI', label: 'Hide or show the UI', icon: 'eyeOff', key: 'Tab', run: () => app.toggleUI() },
    { id: 'layers', label: 'Layers panel', icon: 'layers', key: key('layers'), run: () => app.layersBtn.click() },
    { id: 'colour', label: 'Colour picker', icon: 'eyedropper', run: () => app.colorBtn.click() },
    { id: 'effects', label: 'Effects…', icon: 'sparkle', run: () => app.effectsBtn.click() },
    { id: 'guides', label: 'Guides: symmetry, grid, reference…', icon: 'grid', run: () => app.guidesBtn.click() },
    { id: 'selectAll', label: 'Select all', icon: 'selAll', key: 'Ctrl+A', run: () => { ed.setTool('select'); app.select.selectAll(); } },
    { id: 'deselect', label: 'Deselect', icon: 'x', key: 'Ctrl+D', run: () => app.select.deselect() },
    { id: 'invert', label: 'Invert selection', icon: 'selRect', run: () => app.select.invert() },
    { id: 'fillLayer', label: 'Fill layer or selection', icon: 'fill', key: 'Alt+Backspace', run: () => app.fillArea('fill') },
    { id: 'recolour', label: 'Recolour layer or selection', icon: 'lassoFill', key: 'Shift+Alt+Backspace', run: () => app.fillArea('recolour') },
    { id: 'clear', label: 'Clear selection', icon: 'clear', key: 'Delete', run: () => app.fillArea('erase') },
    { id: 'newLayer', label: 'New layer', icon: 'plus', run: () => ed.addLayer() },
    { id: 'duplicateLayer', label: 'Duplicate layer', icon: 'copy', run: () => ed.duplicateLayer() },
    { id: 'mergeDown', label: 'Merge down', icon: 'merge', run: () => app.layers.merge() },
    { id: 'deleteLayer', label: 'Delete layer', icon: 'trash', run: () => app.layers.removeLayer() },
    { id: 'export', label: 'Export…', icon: 'download', key: 'Ctrl+Shift+E', run: () => app.export() },
    { id: 'preferences', label: 'Preferences…', icon: 'settings', run: () => app.preferences() },
    { id: 'quickMenu', label: 'Quick menu', icon: 'more', key: key('quickMenu'), run: () => app.quickMenu.open() },
    { id: 'commands', label: 'Command palette', icon: 'search', key: 'Ctrl+K', run: () => app.commandPalette() },
  ];
  return ed.readOnly ? list.filter((c) => ['flipH', 'flipV', 'fit', 'zoomIn', 'zoomOut', 'focus', 'hideUI', 'preferences', 'commands'].includes(c.id)) : list;
}

export const findCommand = (list: Command[], id: string) => list.find((c) => c.id === id);
