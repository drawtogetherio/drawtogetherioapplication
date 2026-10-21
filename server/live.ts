import type { ServerResponse } from 'node:http';

// One event stream (Server-Sent Events) per open app tab: friends' presence and invites.

export type LiveEvent =
  | { type: 'friends' }
  | { type: 'notices' }
  | { type: 'invite'; room: { id: string; name: string }; from: { id: string; displayName: string } };

const streams = new Map<string, Set<ServerResponse>>();
const HEARTBEAT_MS = 25_000;

export function streamCount(userId: string) { return streams.get(userId)?.size ?? 0; }
export function isConnected(userId: string) { return streamCount(userId) > 0; }
export const connectedIds = () => [...streams.keys()];

export function closeStreams(userId: string) { for (const res of streams.get(userId) ?? []) res.end(); }

export function sendTo(userId: string, e: LiveEvent) {
  const set = streams.get(userId);
  if (!set) return;
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of set) res.write(line);
}

export function openStream(userId: string, res: ServerResponse, changed: (connected: boolean) => void) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  let set = streams.get(userId);
  if (!set) streams.set(userId, (set = new Set()));
  set.add(res);
  if (set.size === 1) changed(true);
  const beat = setInterval(() => res.write(': \n\n'), HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(beat);
    set.delete(res);
    if (!set.size) { streams.delete(userId); changed(false); }
  });
}

export function closeAllStreams() {
  for (const set of streams.values()) for (const res of set) res.end();
}
