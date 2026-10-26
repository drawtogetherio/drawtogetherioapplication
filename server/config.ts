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
/** The test site: BETA=1, a Railway environment named "beta", or a beta.* address. */
const beta = env.BETA ? env.BETA === '1' : (env.RAILWAY_ENVIRONMENT_NAME ?? '').toLowerCase() === 'beta' || /^https?:\/\/beta\./i.test(env.PUBLIC_URL ?? '');
const publicUrl = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)).replace(/\/$/, '');

/** Pictures on Cloudflare R2: on once the keys, the bucket and its public URL are all set. R2_ENDPOINT is for tests. */
// Values pasted into a dashboard with quotes, spaces or a trailing newline still work: a stray space in
// the secret would otherwise fail every upload with SignatureDoesNotMatch.
const val = (v: string | undefined) => (v ?? '').trim().replace(/^["']|["']$/g, '').trim();
/** R2_ACCOUNT_ID may also be the whole S3 endpoint Cloudflare shows (needed for EU buckets: <id>.eu.r2...). */
const r2Account = val(env.R2_ACCOUNT_ID);
const r2Endpoint = (val(env.R2_ENDPOINT) || (/r2\.cloudflarestorage\.com/i.test(r2Account)
  ? 'https://' + r2Account.replace(/^https?:\/\//i, '').split('/')[0]
  : r2Account ? `https://${r2Account}.r2.cloudflarestorage.com` : '')).replace(/\/$/, '');
const r2Key = val(env.R2_ACCESS_KEY_ID), r2Secret = val(env.R2_SECRET_ACCESS_KEY), r2Bucket = val(env.R2_MEDIA_BUCKET), mediaUrl = val(env.MEDIA_URL);
const media = r2Endpoint && r2Key && r2Secret && r2Bucket && mediaUrl ? {
  endpoint: r2Endpoint, accessKeyId: r2Key, secretAccessKey: r2Secret, bucket: r2Bucket,
  publicUrl: mediaUrl.replace(/\/$/, ''),
  /** Keeps one site's pictures apart from another's in a shared bucket, e.g. "beta/". */
  prefix: (env.MEDIA_PREFIX ?? (beta ? 'beta/' : '')).replace(/^\/+/, ''),
} : null;

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
  beta,
  clientUrl: (env.CLIENT_URL || (production || env.PUBLIC_URL ? publicUrl : 'http://localhost:5173')).replace(/\/$/, ''),
  discord: discordId && discordSecret ? { clientId: discordId, clientSecret: discordSecret } : null,
  /** Never on by default in production. */
  devLogin: env.DEV_LOGIN ? env.DEV_LOGIN === '1' : !(discordId && discordSecret) && !production,
  dbPath: env.DB_PATH || (env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'doodlehive.db') : defaultDbPath()),
  persistent: !onRailway || !!(env.RAILWAY_VOLUME_MOUNT_PATH || env.DB_PATH),
  media,
  /** Beta copies the live database from SYNC_FROM; live hands it out to whoever has SYNC_SECRET. */
  sync: {
    from: beta && env.SYNC_FROM ? env.SYNC_FROM.replace(/\/$/, '') : null,
    secret: (env.SYNC_SECRET ?? '').length >= 24 ? env.SYNC_SECRET! : null,
    hours: Number(env.SYNC_HOURS) || 24,
  },
  downloads: { mac: env.DOWNLOAD_MAC_URL || null, windows: env.DOWNLOAD_WINDOWS_URL || null },
  patreon: env.PATREON_URL || 'https://www.patreon.com/doodlehive',
  /** A Discord invite shown on the home screen; none hides the card. */
  discordInvite: env.DISCORD_INVITE_URL || '',
  /** OAuth client for linking Patreon accounts; PATREON_CAMPAIGN_ID limits which memberships count. PATREON_API is for tests. */
  patreonApp: patreonId && patreonSecret ? { clientId: patreonId, clientSecret: patreonSecret, campaignId: env.PATREON_CAMPAIGN_ID || '', api: (env.PATREON_API || 'https://www.patreon.com').replace(/\/$/, '') } : null,
  /** Handles made admin at startup, comma separated. */
  adminHandles: (env.ADMIN_HANDLES || '').split(',').map((h) => h.trim()).filter(Boolean),
  staticDir: env.STATIC_DIR || path.join(here, '..', 'dist'),
  /** How long a free host's room waits for them to come back before it closes. */
  ephemeralGraceMs: Number(env.EPHEMERAL_GRACE_MS) || 2 * 60_000,
  /** Edits since the last snapshot before a client is asked for a new one. */
  snapshotEvery: Number(env.SNAPSHOT_EVERY) || 400,
  secureCookies: publicUrl.startsWith('https://'),
};
