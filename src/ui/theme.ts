import { DEFAULT_THEME, Theme, findTheme } from '../shared/themes';
import type { Mode } from '../shared/prefs';

const KEY = 'doodlehive.theme';
let current: Theme = findTheme(DEFAULT_THEME);

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

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

export function initTheme() {
  let id: string | null = null;
  try { id = localStorage.getItem(KEY); } catch { /* ignore */ }
  applyTheme(id);
}

const dark = matchMedia('(prefers-color-scheme: dark)');
let mode: Mode = 'dark';
const MODE_KEY = 'doodlehive.mode';
const paint = () => {
  const m = mode === 'system' ? (dark.matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.mode = m;
  // app.html reads this before anything loads, so the loading screen matches.
  try { localStorage.setItem(MODE_KEY, m); } catch { /* storage may be blocked */ }
};
dark.addEventListener('change', paint);

export function applyMode(m: Mode) { mode = m; paint(); }

export const theme = () => current;
export const accentColor = () => current.accent;
