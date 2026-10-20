import { DEFAULT_THEME, Theme, findTheme } from '../shared/themes';

const KEY = 'doodlehive.theme';
let current: Theme = findTheme(DEFAULT_THEME);

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Apply a theme to the whole UI (CSS variables) and remember it on this device. */
export function applyTheme(id: string | null | undefined) {
  current = findTheme(id);
  const s = document.documentElement.style;
  s.setProperty('--accent', current.accent);
  s.setProperty('--accent-hover', current.accentHover);
  s.setProperty('--accent-soft', rgba(current.accent, 0.18));
  s.setProperty('--accent-tint', current.accentTint);
  s.setProperty('--on-accent', current.onAccent);
  document.documentElement.dataset.theme = current.id;
  try { localStorage.setItem(KEY, current.id); } catch { /* storage may be blocked */ }
}

/** Theme from the last visit, until the account's saved theme arrives. */
export function initTheme() {
  let id: string | null = null;
  try { id = localStorage.getItem(KEY); } catch { /* ignore */ }
  applyTheme(id);
}

export const theme = () => current;
/** Accent colour for things drawn on the canvas (selection outlines, handles). */
export const accentColor = () => current.accent;
