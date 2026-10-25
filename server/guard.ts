import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';

// Request limits and browser security headers. Client addresses stay in memory, keyed for rate
// limiting only; they are never stored, logged or sent anywhere.

const buckets = new Map<string, { n: number; reset: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

/** True while `key` is under `limit` hits per `windowMs`. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n <= limit;
}

export function clientIp(req: IncomingMessage): string {
  if (config.production) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',').pop()!.trim();
  }
  return req.socket.remoteAddress ?? '';
}

const ORIGINS = new Set([config.publicUrl, config.clientUrl]);

/** Cross-site requests can't change anything, whatever cookies they carry. */
export function sameSite(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin) return ORIGINS.has(origin);
  const site = req.headers['sec-fetch-site'];
  return site !== 'cross-site';
}

const wsOrigin = config.publicUrl.replace(/^http/, 'ws');
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", `img-src 'self' data: blob:${config.media ? ' ' + new URL(config.media.publicUrl).origin : ''}`,
  `connect-src 'self' ${wsOrigin}`, "font-src 'self' data:", "worker-src 'self' blob:", "object-src 'none'",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');

export function securityHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (config.beta) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
