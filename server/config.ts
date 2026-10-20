import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite prints an "experimental" warning on every start; it is stable enough for us.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(w).includes('SQLite')) return;
  (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (server/.env), so no extra dependency is needed.
const envFile = path.join(here, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const port = Number(env.PORT || 8787);
const discordId = env.DISCORD_CLIENT_ID || '';
const discordSecret = env.DISCORD_CLIENT_SECRET || '';

/** server/data/doodlehive.db; an older database from before the rename is renamed to match. */
function defaultDbPath() {
  const dir = path.join(here, 'data');
  const file = path.join(dir, 'doodlehive.db');
  const old = path.join(dir, 'drawwithus.db');
  if (!fs.existsSync(file) && fs.existsSync(old)) {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(old + ext)) fs.renameSync(old + ext, file + ext);
  }
  return file;
}

export const config = {
  port,
  /** Public URL of this server (used for the Discord redirect). */
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  /** Where to send people after logging in (the Vite dev server in development). */
  clientUrl: (env.CLIENT_URL || env.PUBLIC_URL || `http://localhost:5173`).replace(/\/$/, ''),
  discord: discordId && discordSecret ? { clientId: discordId, clientSecret: discordSecret } : null,
  /** Fake logins for local testing. On by default until Discord is configured. */
  devLogin: env.DEV_LOGIN ? env.DEV_LOGIN === '1' : !(discordId && discordSecret),
  dbPath: env.DB_PATH || defaultDbPath(),
  staticDir: env.STATIC_DIR || path.join(here, '..', 'dist'),
  secureCookies: (env.PUBLIC_URL || '').startsWith('https://'),
};
