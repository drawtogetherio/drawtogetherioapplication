import './tooltip.css';

// One tooltip for the page, fed by data-tip (h() turns `title` into it). Unlike the browser's title
// bubble it also shows for a hovering pen, which iPads with Apple Pencil never get, and on keyboard focus.

const KEY = /^(.+?)\s*\(([A-Z0-9][\w+ ·]{0,14})\)$/;
const WARM_MS = 400;
let tip: HTMLElement, cur: Element | null = null, timer = 0, warmUntil = 0, pressed = false;

export function initTooltips() {
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  const target = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || pressed) return;
    aim(target(e), e.pointerType === 'pen' ? 250 : 500);
  });
  document.addEventListener('pointerout', (e) => { if (cur && !(e.relatedTarget instanceof Node && cur.contains(e.relatedTarget))) aim(null); });
  document.addEventListener('pointerdown', () => { pressed = true; hide(true); }, true);
  document.addEventListener('pointerup', () => { pressed = false; }, true);
  document.addEventListener('pointercancel', () => { pressed = false; }, true);
  document.addEventListener('focusin', (e) => { const t = target(e); if (t && t.matches(':focus-visible')) aim(t, 0); });
  document.addEventListener('focusout', () => { if (cur && !cur.matches(':hover')) aim(null); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(true); });
  document.addEventListener('scroll', () => hide(true), true);
  document.addEventListener('wheel', () => hide(true), { passive: true });
}

function aim(el: Element | null, delay = 0) {
  if (el === cur) return;
  cur = el;
  clearTimeout(timer);
  if (!el) { hide(); return; }
  if (performance.now() < warmUntil) show();
  else timer = window.setTimeout(show, delay);
}

function show() {
  const text = cur?.isConnected ? cur.getAttribute('data-tip') : '';
  if (!cur || !text) { hide(); return; }
  const m = KEY.exec(text);
  tip.textContent = m ? m[1] : text;
  if (m) { const k = document.createElement('kbd'); k.textContent = m[2]; tip.append(k); }
  tip.hidden = false;
  const r = cur.getBoundingClientRect(), w = tip.offsetWidth, hh = tip.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - 8 - w);
  const below = r.bottom + 8;
  const y = below + hh <= vh - 8 ? below : Math.max(8, r.top - 8 - hh);
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
  tip.classList.toggle('above', y < r.top);
}

function hide(cold = false) {
  clearTimeout(timer);
  if (!tip.hidden) warmUntil = cold ? 0 : performance.now() + WARM_MS;
  tip.hidden = true;
  if (cold) cur = null;
}
