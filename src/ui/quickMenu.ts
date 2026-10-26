// A ring of eight shortcuts under the pointer: right click, pen barrel button, or the Q key.
import type { App } from './app';
import { commands, findCommand } from './commands';
import { h, clear } from './dom';
import { icon } from './icons';

const R = 72, SLOT = 44;

export class QuickMenu {
  el = h('div.quick-menu', { hidden: true, role: 'menu', 'aria-label': 'Quick menu' });
  private last = { x: 0, y: 0 };
  private editing = false;
  private pick: HTMLElement | null = null;

  constructor(private app: App) {
    document.addEventListener('pointermove', (e) => { this.last = { x: e.clientX, y: e.clientY }; }, { passive: true });
    // Capture phase: a press outside only dismisses the menu, it doesn't start a stroke.
    document.addEventListener('pointerdown', (e) => {
      if (this.el.hidden || this.el.contains(e.target as Node) || this.pick?.contains(e.target as Node)) return;
      this.close();
      if ((e.target as Element).closest('canvas')) e.stopPropagation();
    }, true);
    document.body.append(this.el);
  }

  get open_() { return !this.el.hidden; }

  /** Opens at a point, or at the pointer. */
  open(x = this.last.x, y = this.last.y) {
    const m = R + SLOT / 2 + 8;
    const cx = Math.min(innerWidth - m, Math.max(m, x)), cy = Math.min(innerHeight - m, Math.max(m, y));
    this.el.style.left = `${cx}px`;
    this.el.style.top = `${cy}px`;
    this.el.hidden = false;
    this.render();
    (this.el.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  close() {
    this.el.hidden = true;
    this.editing = false;
    this.pick?.remove(); this.pick = null;
  }

  private render() {
    clear(this.el);
    const app = this.app, all = commands(app), ids = app.ed.prefs.quickMenu;
    ids.forEach((id, i) => {
      const c = findCommand(all, id);
      const a = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      const b = h('button.quick-slot', {
        role: 'menuitem', title: c ? c.label + (c.key ? ` (${c.key})` : '') : 'Empty', 'aria-label': c?.label ?? 'Empty',
        html: c ? icon(c.icon, 20) : '', style: `left:${R + R * Math.cos(a)}px;top:${R + R * Math.sin(a)}px`,
      });
      if (this.editing) b.classList.add('editing');
      const act = () => (this.editing ? this.choose(i, b) : this.run(c?.run));
      b.addEventListener('pointerup', (e) => { e.stopPropagation(); act(); });
      b.addEventListener('click', (e) => { if (e.detail === 0) act(); }); // keyboard
      this.el.append(b);
    });
    const centre = h('button.quick-centre', {
      title: this.editing ? 'Done' : 'Customise', 'aria-label': this.editing ? 'Done customising' : 'Customise the quick menu',
      html: icon(this.editing ? 'check' : 'settings', 18), style: `left:${R}px;top:${R}px`,
    });
    centre.addEventListener('click', () => { this.editing = !this.editing; this.pick?.remove(); this.pick = null; this.render(); });
    this.el.append(centre);
  }

  private run(fn?: () => void) {
    this.close();
    fn?.();
  }

  /** In edit mode: a list of every command to put in slot `i`. */
  private choose(i: number, slot: HTMLElement) {
    this.pick?.remove();
    const app = this.app, items = commands(app).filter((c) => c.id !== 'quickMenu');
    const pick = this.pick = h('div.panel.quick-pick', { role: 'listbox' });
    for (const c of items) {
      pick.append(h('button.menu-item', {
        role: 'option', html: icon(c.icon, 16) + `<span>${c.label}</span>`,
        onclick: () => {
          const ids = [...app.ed.prefs.quickMenu];
          ids[i] = c.id;
          app.ed.prefs.quickMenu = ids;
          app.ed.emit('prefs');
          this.pick = null; pick.remove();
          this.render();
        },
      }));
    }
    document.body.append(pick); // outside the menu's transform, so fixed positioning works
    const r = this.el.getBoundingClientRect(), onRight = slot.offsetLeft < R;
    pick.style.left = onRight ? `${r.right + SLOT / 2 + 8}px` : 'auto';
    pick.style.right = onRight ? 'auto' : `${innerWidth - r.left + SLOT / 2 + 8}px`;
    (pick.firstElementChild as HTMLElement).focus();
  }
}
