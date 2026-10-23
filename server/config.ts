import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Silence the node:sqlite "experimental" warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(w).includes('SQLite')) return;
  (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const here = path.dirname(fileURLToPath(import.meta.url));

// server/.env
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
const patreonId = env.PATREON_CLIENT_ID || '';
const patreonSecret = env.PATREON_CLIENT_SECRET || '';
const onRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
const production = env.NODE_ENV === 'production' || onRailway;
const publicUrl = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)).replace(/\/$/, '');

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
  publicUrl,
  production,
  clientUrl: (env.CLIENT_URL || (production || env.PUBLIC_URL ? publicUrl : 'http://localhost:5173')).replace(/\/$/, ''),
  discord: discordId && discordSecret ? { clientId: discordId, clientSecret: discordSecret } : null,
  /** Never on by default in production. */
  devLogin: env.DEV_LOGIN ? env.DEV_LOGIN === '1' : !(discordId && discordSecret) && !production,
  dbPath: env.DB_PATH || (env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'doodlehive.db') : defaultDbPath()),
  persistent: !onRailway || !!(env.RAILWAY_VOLUME_MOUNT_PATH || env.DB_PATH),
  downloads: { mac: env.DOWNLOAD_MAC_URL || null, windows: env.DOWNLOAD_WINDOWS_URL || null },
  patreon: env.PATREON_URL || 'https://www.patreon.com/doodlehive',
  /** OAuth client for linking Patreon accounts; PATREON_CAMPAIGN_ID limits which memberships count. PATREON_API is for tests. */
  patreonApp: patreonId && patreonSecret ? { clientId: patreonId, clientSecret: patreonSecret, campaignId: env.PATREON_CAMPAIGN_ID || '', api: (env.PATREON_API || 'https://www.patreon.com').replace(/\/$/, '') } : null,
  /** Handles made admin at startup, comma separated. */
  adminHandles: (env.ADMIN_HANDLES || '').split(',').map((h) => h.trim()).filter(Boolean),
  staticDir: env.STATIC_DIR || path.join(here, '..', 'dist'),
  /** How long a free host's room waits for them to come back before it closes. */
  ephemeralGraceMs: Number(env.EPHEMERAL_GRACE_MS) || 2 * 60_000,
  secureCookies: publicUrl.startsWith('https://'),
};
