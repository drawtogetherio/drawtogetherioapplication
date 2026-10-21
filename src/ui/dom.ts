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
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

export function dismissOnOutside(pop: HTMLElement, toggles: HTMLElement[], close: () => void) {
  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden) return;
    const t = e.target as Node;
    if (pop.contains(t) || toggles.some((b) => b.contains(t))) return;
    close();
  }, true);
}
