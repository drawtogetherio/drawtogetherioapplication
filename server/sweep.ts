import { db } from './db.ts';
import { premiumWarnings } from './notify.ts';
import { deleteRoom } from './rooms.ts';
import { isOnline } from './social.ts';

// Housekeeping every few minutes: expired sessions go, and guests go once their session has run out
// and they are no longer connected. Guests are never kept longer than a few hours after they leave.

export function sweep(): { guests: number; canvases: number } {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  const gone = (db.prepare(`SELECT id FROM users WHERE provider = 'guest' AND id NOT IN (SELECT user_id FROM sessions)`).all() as { id: string }[])
    .map((r) => r.id).filter((id) => !isOnline(id));
  const del = db.prepare('DELETE FROM users WHERE id = ?');
  for (const id of gone) del.run(id);
  db.prepare('DELETE FROM notices WHERE user_id NOT IN (SELECT id FROM users)').run();
  // Canvases a free account left on the server (from before, or after premium ended) go after 30 days unused.
  const old = db.prepare(`SELECT r.id FROM rooms r JOIN users u ON u.id = r.owner_id WHERE r.ephemeral = 0 AND coalesce(r.updated_at, r.created_at) < ?
    AND NOT (u.premium = 1 AND (u.premium_until IS NULL OR u.premium_until > ?))`).all(now - 30 * 864e5, now) as { id: string }[];
  for (const r of old) deleteRoom(r.id);
  premiumWarnings();
  return { guests: gone.length, canvases: old.length };
}
