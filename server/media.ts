import crypto from 'node:crypto';
import { config } from './config.ts';

// Profile pictures and banners on Cloudflare R2, served from its public domain (MEDIA_URL) so they
// load from Cloudflare's edge instead of this server. Requests are signed with AWS Signature V4,
// which R2 speaks. Without the R2 variables everything stays in the database, as before.

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

export const mediaOn = !!config.media;

/** Public URL of a stored object. */
export const mediaUrl = (key: string) => `${config.media?.publicUrl ?? ''}/${key}`;

/** Only keys this server made are ever deleted, so a beta running on a copy of live data can't remove live pictures. */
export const ownKey = (key: string | null | undefined): key is string => !!key && !!config.media && key.startsWith(config.media.prefix);

/** A new, never-reused key: new uploads get new URLs, so they can be cached forever. */
export const newMediaKey = (kind: string, userId: string) =>
  `${config.media!.prefix}u/${userId}/${kind}-${crypto.randomBytes(9).toString('base64url')}`;

async function send(method: 'PUT' | 'DELETE', key: string, body?: Buffer, type?: string) {
  const m = config.media!;
  const url = new URL(`${m.endpoint}/${m.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host, 'x-amz-content-sha256': sha256(body ?? ''), 'x-amz-date': now,
    ...(body ? { 'content-type': type ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' } : {}),
  };
  const names = Object.keys(headers).sort();
  const signed = names.join(';');
  const canonical = [method, url.pathname, '', ...names.map((n) => `${n}:${headers[n]}`), '', signed, headers['x-amz-content-sha256']].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  const signingKey = ['auto', 's3', 'aws4_request'].reduce<Buffer>((k, part) => hmac(k, part), hmac('AWS4' + m.secretAccessKey, day));
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  const { host: _host, ...rest } = headers;
  const res = await fetch(url, {
    method, body: body ? new Uint8Array(body) : undefined,
    headers: { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${m.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    const text = await res.text();
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    throw new Error(`R2 ${method} ${key}: ${res.status} ${code || text.slice(0, 200)}${HINTS[code] ? ` (${HINTS[code]})` : ''}`);
  }
}

/** What each R2 refusal usually means, for the deploy log. */
const HINTS: Record<string, string> = {
  SignatureDoesNotMatch: 'R2_SECRET_ACCESS_KEY does not belong to R2_ACCESS_KEY_ID',
  InvalidAccessKeyId: 'R2_ACCESS_KEY_ID is wrong, or the token was deleted, or it belongs to another Cloudflare account than R2_ACCOUNT_ID',
  AccessDenied: 'the API token is not allowed to write to this bucket: give it Object Read & Write on R2_MEDIA_BUCKET',
  Unauthorized: 'the API token is not allowed to write to this bucket: give it Object Read & Write on R2_MEDIA_BUCKET',
  NoSuchBucket: 'R2_MEDIA_BUCKET does not exist in this account (check the name, and for an EU bucket put the full EU endpoint in R2_ACCOUNT_ID)',
};

export const putMedia = (key: string, body: Buffer, type: string) => send('PUT', key, body, type);

/** Writes and removes a tiny object at startup so the deploy log says whether uploads will work, and why not. */
export async function checkMedia() {
  if (!config.media) return;
  const key = `${config.media.prefix}_check`;
  try {
    await send('PUT', key, Buffer.from('ok'), 'text/plain');
    await send('DELETE', key);
    console.log('  R2 check: uploads work.');
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    console.error(`  R2 check FAILED, picture uploads will fail: ${e instanceof Error ? e.message : String(e)}${cause ? ` [${cause}]` : ''}` +
      (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN' ? ` (no such host ${new URL(config.media.endpoint).host}: check R2_ACCOUNT_ID)` : ''));
  }
}

/** Best effort: a leftover object only costs storage. */
export function deleteMedia(...keys: (string | null | undefined)[]) {
  for (const key of keys) if (ownKey(key)) send('DELETE', key).catch((e) => console.warn(String(e)));
}
