type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}` | `${K}#${string}`, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const [tagAndId, ...classes] = sel.split('.');
  const [tag, id] = tagAndId.split('#');
  const el = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'title') el.dataset.tip = String(v); // shown by tooltip.ts, not the browser
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  // An icon-only control is named by its tooltip.
  if (attrs.title && !attrs['aria-label'] && (attrs.html || !el.textContent?.trim())) el.setAttribute('aria-label', String(attrs.title));
  return el;
}

export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

export function dismissOnOutside(pop: HTMLElement, toggles: HTMLElement[], close: () => void) {
  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden) return;
    const t = e.target as Element;
    // A dialog opened from the popover sits above it and shouldn't close it.
    if (pop.contains(t) || toggles.some((b) => b.contains(t)) || t.closest?.('.modal-overlay')) return;
    close();
  }, true);
}
