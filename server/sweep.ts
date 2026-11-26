import { db } from './db.ts';
import { premiumWarnings } from './notify.ts';
import { isOnline } from './social.ts';
import { deleteMedia } from './media.ts';

// Housekeeping every few minutes: expired sessions go, and guests go once their session has run out
// and they are no longer connected. Guests are never kept longer than a few hours after they leave.

export function sweep(): { guests: number } {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  const gone = (db.prepare(`SELECT id, avatar_key, avatar_anim_key, banner_key FROM users WHERE provider = 'guest' AND id NOT IN (SELECT user_id FROM sessions)`).all() as
    { id: string; avatar_key: string | null; avatar_anim_key: string | null; banner_key: string | null }[]).filter((r) => !isOnline(r.id));
  const del = db.prepare('DELETE FROM users WHERE id = ?');
  for (const r of gone) { del.run(r.id); deleteMedia(r.avatar_key, r.avatar_anim_key, r.banner_key); }
  db.prepare('DELETE FROM notices WHERE user_id NOT IN (SELECT id FROM users)').run();
  // Free accounts' canvases on the server are their cloud storage now (capped, see needCloud), so they stay.
  // Live-only rooms (ephemeral) close on their own once the host has gone.
  premiumWarnings();
  return { guests: gone.length };
}
