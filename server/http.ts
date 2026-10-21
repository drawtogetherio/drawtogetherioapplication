import type http from 'node:http';

export type Req = http.IncomingMessage;
export type Res = http.ServerResponse;

export class HttpError extends Error {
  constructor(public status: number, message: string, public field?: string) { super(message); }
}

export function json(res: Res, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function body(req: Req, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'That file is too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function jsonBody(req: Req): Promise<Record<string, unknown>> {
  try { return JSON.parse((await body(req, 64 * 1024)).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
}
