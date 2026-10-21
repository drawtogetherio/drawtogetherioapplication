import { db } from './db.ts';
import { premiumWarnings } from './notify.ts';
import { isOnline } from './social.ts';

// Housekeeping every few minutes: expired sessions go, and guests go once their session has run out
// and they are no longer connected. Guests are never kept longer than a few hours after they leave.

export function sweep(): { guests: number } {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  const gone = (db.prepare(`SELECT id FROM users WHERE provider = 'guest' AND id NOT IN (SELECT user_id FROM sessions)`).all() as { id: string }[])
    .map((r) => r.id).filter((id) => !isOnline(id));
  const del = db.prepare('DELETE FROM users WHERE id = ?');
  for (const id of gone) del.run(id);
  db.prepare('DELETE FROM notices WHERE user_id NOT IN (SELECT id FROM users)').run();
  premiumWarnings();
  return { guests: gone.length };
}
