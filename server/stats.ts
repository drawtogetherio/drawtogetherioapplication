import { db } from './db.ts';

// Running totals (strokes, undos, messages…) batched in memory and written every few seconds.

export const STAT_KEYS = ['strokes', 'smudges', 'fills', 'shapes', 'undos', 'redos', 'messages', 'ops'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

const pending = new Map<StatKey, number>();
const startedAt = Date.now();

export function bump(key: StatKey, by = 1) { pending.set(key, (pending.get(key) ?? 0) + by); }

export function flushStats() {
  if (!pending.size) return;
  const up = db.prepare('INSERT INTO stats (key, n) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n');
  for (const [k, n] of pending) up.run(k, n);
  pending.clear();
}
setInterval(flushStats, 10_000).unref();

export function readStats(): Record<StatKey, number> & { uptime: number } {
  flushStats();
  const out = Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as Record<StatKey, number> & { uptime: number };
  for (const r of db.prepare('SELECT key, n FROM stats').all() as { key: StatKey; n: number }[]) if (r.key in out) out[r.key] = r.n;
  out.uptime = Date.now() - startedAt;
  return out;
}
