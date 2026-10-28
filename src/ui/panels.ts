import type { Editor } from '../editor';
import { DEFAULT_PANELS, Dock, PANELS, PanelId, PanelState } from '../shared/prefs';
import { h } from './dom';
import { icon } from './icons';

const SIDES: Exclude<Dock, 'float'>[] = ['left', 'right', 'top', 'bottom'];
const SNAP = 40; // px from the edge that docks a dragged panel

/** Studio layout: panels that float over the canvas or dock to its sides, with their places kept in prefs. */
export class Studio {
  readonly el: HTMLElement;
  private docks = {} as Record<Exclude<Dock, 'float'>, HTMLElement>;
  private frames = new Map<PanelId, HTMLElement>();
  private hint = h('div.dock-hint', { hidden: true });

  constructor(private ed: Editor, private stage: HTMLElement) {
    for (const s of SIDES) this.docks[s] = h(`div.dock.dock-${s}` as 'div');
    this.el = h('div.studio', { hidden: true }, this.docks.top, this.docks.left, this.docks.right, this.docks.bottom, this.hint);
    // Chat, the room bar and the overview sit in the canvas's corners, not on top of docked panels.
    new ResizeObserver(() => {
      const r = this.stage.getBoundingClientRect(), s = document.body.style;
      s.setProperty('--stage-l', `${Math.round(r.left)}px`);
      s.setProperty('--stage-r', `${Math.round(window.innerWidth - r.right)}px`);
      s.setProperty('--stage-b', `${Math.round(window.innerHeight - r.bottom)}px`);
    }).observe(stage);
  }

  private get state() { return this.ed.prefs.panels; }

  /** Builds a panel's frame once; `body` gets the content on each apply(). */
  frame(id: PanelId, ...content: HTMLElement[]): HTMLElement {
    let f = this.frames.get(id);
    if (!f) {
      const title = PANELS.find((p) => p.id === id)!.label;
      const head = h('div.sp-head', {}, h('span', {}, title),
        h('button.icon-btn.small', { title: 'Close', 'aria-label': `Close ${title}`, html: icon('x', 14), onclick: () => this.show(id, false) }));
      const grip = h('div.sp-resize', { 'aria-hidden': 'true' });
      f = h(`div.sp.sp-${id}.edit-only` as 'div', { 'data-panel': id, role: 'region', 'aria-label': title }, head, h('div.sp-body'), grip);
      head.addEventListener('pointerdown', (e) => this.drag(e, id, f!));
      grip.addEventListener('pointerdown', (e) => this.resize(e, id, f!));
      this.frames.set(id, f);
    }
    f.querySelector('.sp-body')!.replaceChildren(...content);
    return f;
  }

  show(id: PanelId, on: boolean) {
    this.state[id].show = on;
    this.changed();
  }

  /** After the docks change shape, so the canvas stays in view. */
  private changed() {
    this.apply();
    this.ed.emit('prefs');
    this.ed.fitView();
  }

  reset() {
    this.ed.prefs.panels = structuredClone(DEFAULT_PANELS);
    this.changed();
  }

  /** Puts every frame where prefs say, and the stage in the middle. */
  apply() {
    if (this.stage.parentElement !== this.el) this.el.insertBefore(this.stage, this.docks.right);
    const byDock = new Map<Dock, [PanelId, PanelState][]>();
    for (const { id } of PANELS) {
      const st = this.state[id], f = this.frames.get(id);
      if (!f) continue;
      f.hidden = !st.show;
      if (!st.show) continue;
      const list = byDock.get(st.dock) ?? [];
      list.push([id, st]);
      byDock.set(st.dock, list);
    }
    // A docked panel never takes more than 45% of the workspace.
    const maxW = this.el.clientWidth * 0.45, maxH = this.el.clientHeight * 0.45;
    for (const [dock, list] of byDock) {
      list.sort((a, b) => a[1].order - b[1].order);
      list.forEach(([id, st], i) => {
        const f = this.frames.get(id)!;
        f.className = `sp sp-${id} edit-only ${dock}`;
        st.order = i;
        f.style.width = (dock === 'left' || dock === 'right' ? Math.min(st.w, maxW) : st.w) + 'px';
        f.style.height = (dock === 'top' || dock === 'bottom' ? Math.min(st.h, maxH) : st.h) + 'px';
        if (dock === 'float') {
          f.style.left = st.x + 'px';
          f.style.top = st.y + 'px';
          f.style.zIndex = String(10 + i);
          if (f.parentElement !== this.el) this.el.append(f);
        } else {
          f.style.left = f.style.top = f.style.zIndex = '';
          const d = this.docks[dock];
          if (d.children[i] !== f) d.insertBefore(f, d.children[i] ?? null);
        }
      });
    }
  }

  private drag(e: PointerEvent, id: PanelId, f: HTMLElement) {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const st = this.state[id], box = this.el.getBoundingClientRect(), r = f.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top, from = st.dock;
    let moved = false, zone: Dock = 'float';
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moved) {
        moved = true;
        st.dock = 'float';
        f.classList.add('dragging');
        this.apply();
        this.el.append(f);
      }
      st.x = Math.round(Math.max(0, Math.min(box.width - 40, ev.clientX - box.left - ox)));
      st.y = Math.round(Math.max(0, Math.min(box.height - 40, ev.clientY - box.top - oy)));
      f.style.left = st.x + 'px'; f.style.top = st.y + 'px';
      zone = this.zoneAt(ev.clientX - box.left, ev.clientY - box.top, box);
      this.hint.hidden = zone === 'float';
      this.hint.className = `dock-hint ${zone}`;
    };
    track(e, move, (ev) => {
      f.classList.remove('dragging');
      this.hint.hidden = true;
      if (!moved) return;
      if (zone !== 'float') {
        st.dock = zone;
        // Slot it in by where it was dropped among the panels already on that side.
        const along = zone === 'left' || zone === 'right' ? ev.clientY : ev.clientX;
        const others = [...this.docks[zone].children].filter((c) => c !== f) as HTMLElement[];
        const i = others.findIndex((c) => { const cr = c.getBoundingClientRect(); return along < (zone === 'left' || zone === 'right' ? cr.top + cr.height / 2 : cr.left + cr.width / 2); });
        st.order = (i < 0 ? others.length : i) - 0.5;
      }
      if (from === 'float' && zone === 'float') { this.apply(); this.ed.emit('prefs'); } else this.changed();
    });
  }

  private zoneAt(x: number, y: number, box: DOMRect): Dock {
    if (x < SNAP) return 'left';
    if (x > box.width - SNAP) return 'right';
    if (y < SNAP) return 'top';
    if (y > box.height - SNAP) return 'bottom';
    return 'float';
  }

  private resize(e: PointerEvent, id: PanelId, f: HTMLElement) {
    e.preventDefault();
    const st = this.state[id], w0 = st.w, h0 = st.h;
    const sx = st.dock === 'right' ? -1 : 1, sy = st.dock === 'bottom' ? -1 : 1;
    track(e, (ev) => {
      st.w = Math.round(Math.max(48, Math.min(1600, w0 + (ev.clientX - e.clientX) * sx)));
      st.h = Math.round(Math.max(48, Math.min(2400, h0 + (ev.clientY - e.clientY) * sy)));
      f.style.width = st.w + 'px'; f.style.height = st.h + 'px';
    }, () => this.ed.emit('prefs'));
  }
}

/** Follows one pointer on the document, so a frame that moves in the DOM mid-drag keeps getting events. */
export function track(e: PointerEvent, move: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void) {
  const onMove = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) move(ev); };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    up(ev);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}
