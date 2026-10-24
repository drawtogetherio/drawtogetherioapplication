import type { ViewTurn } from '../editor';

// Each canvas remembers how it was last held on this device, like a sheet left turned on the desk.
// Per device, not per room, so one person's rotation never turns anyone else's view.

const KEY = 'dh.turns', MAX = 200;

function load(): Record<string, ViewTurn> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
}

export function savedTurn(id: string): ViewTurn | undefined { return load()[id]; }

export function saveTurn(id: string, t: ViewTurn) {
  const all = load();
  delete all[id];
  if (Math.abs(t.rot) > 1e-3 || t.flipX !== 1 || t.flipY !== 1) all[id] = { rot: Math.round(t.rot * 1000) / 1000, flipX: t.flipX, flipY: t.flipY };
  const ids = Object.keys(all).slice(-MAX);
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(ids.map((k) => [k, all[k]])))); } catch { /* storage blocked */ }
}
