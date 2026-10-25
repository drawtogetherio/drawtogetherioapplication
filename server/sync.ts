import fs from 'node:fs';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

// Beta runs on a copy of the live database. Live hands out a snapshot to whoever has SYNC_SECRET,
// without sessions or Patreon tokens. Beta swaps it in before the database opens: on start when its
// copy is older than SYNC_HOURS, or when an admin asked for a fresh one. Only beta ever replaces its
// database, so a mistake in the variables can't overwrite live.

const marker = config.dbPath + '.synced';
const askFile = config.dbPath + '.sync-now';

/** Set before a shutdown that should come back up (with a fresh copy); Railway restarts on a non-zero exit. */
export const restart = { wanted: false };

export function lastSync(): number | null {
  try { return Number(fs.readFileSync(marker, 'utf8')) || null; } catch { return null; }
}
export const syncDue = () => !!config.sync.from && (lastSync() ?? 0) < Date.now() - config.sync.hours * 3600_000;
export function askForSync() { fs.writeFileSync(askFile, String(Date.now())); restart.wanted = true; }

/** Live side: a consistent copy of the database, scrubbed and gzipped. */
export function snapshot(db: DatabaseSync): Buffer {
  const tmp = `${config.dbPath}.snapshot-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(tmp);
    copy.exec('DELETE FROM sessions; UPDATE users SET patreon_tokens = NULL;');
    copy.close();
    return zlib.gzipSync(fs.readFileSync(tmp));
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function pull() {
  const res = await fetch(config.sync.from + '/api/sync/snapshot', { headers: { authorization: 'Bearer ' + config.sync.secret }, signal: AbortSignal.timeout(30_000) }); // well inside Railway's 60 s health check
  if (!res.ok) throw new Error(`${config.sync.from} answered ${res.status}`);
  const incoming = config.dbPath + '.incoming';
  fs.writeFileSync(incoming, zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
  const check = new DatabaseSync(incoming);
  const users = (check.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
  check.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
  fs.renameSync(incoming, config.dbPath);
  fs.writeFileSync(marker, String(Date.now()));
  fs.rmSync(askFile, { force: true });
  console.log(`Copied the live database from ${config.sync.from} (${users} accounts).`);
}

if (config.sync.from) {
  if (!config.sync.secret) console.warn('  WARNING: SYNC_FROM is set but SYNC_SECRET is missing or shorter than 24 characters; beta keeps its own data.');
  else if (fs.existsSync(askFile) || syncDue()) {
    fs.mkdirSync(config.dbPath.replace(/[^/\\]+$/, ''), { recursive: true });
    await pull().catch((e) => console.warn('  WARNING: couldn’t copy the live database, keeping beta’s own:', String(e)));
  }
}
