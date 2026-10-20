// Admin commands. Usage:
//   npm run admin -- premium <handle> <days|forever|off>
//   npm run admin -- users
import { db, UserRow } from './db.ts';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'premium') {
  const [handle, length] = args;
  const u = db.prepare('SELECT * FROM users WHERE lower(handle) = lower(?)').get(handle ?? '') as UserRow | undefined;
  if (!u || !length) { console.error('Usage: premium <handle> <days|forever|off>'); process.exit(1); }
  if (length === 'off') db.prepare('UPDATE users SET premium = 0, premium_until = NULL WHERE id = ?').run(u.id);
  else if (length === 'forever') db.prepare('UPDATE users SET premium = 1, premium_until = NULL WHERE id = ?').run(u.id);
  else db.prepare('UPDATE users SET premium = 1, premium_until = ? WHERE id = ?').run(Date.now() + Number(length) * 864e5, u.id);
  console.log(`Updated @${u.handle}`);
} else if (cmd === 'users') {
  for (const u of db.prepare('SELECT handle, display_name, provider, premium, premium_until FROM users ORDER BY created_at').all() as unknown as UserRow[]) {
    console.log(`@${u.handle}  ${u.display_name}  (${u.provider})${u.premium ? '  premium' + (u.premium_until ? ' until ' + new Date(u.premium_until).toISOString().slice(0, 10) : '') : ''}`);
  }
} else {
  console.log('Commands: premium <handle> <days|forever|off>, users');
}
