// node desktop/test-store.mjs — the file store round-trips canvases, ops and thumbnails.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { CanvasStore } = createRequire(import.meta.url)('./store.cjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-store-'));
const s = new CanvasStore(root);
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const meta = { id: 'cabc123xyz', user: 'u1', name: 'Fox', settings: { width: 1, height: 1, infinite: true, background: null }, share: { visibility: 'private' }, room: null, createdAt: 1, updatedAt: 2, thumb: { type: 'image/webp', bytes: new Uint8Array([1, 2, 3]) } };
await s.put(meta);
await s.appendOps('cabc123xyz', [{ t: 'a' }, { t: 'b' }]);
await s.appendOps('cabc123xyz', [{ t: 'c' }]);
check((await s.loadOps('cabc123xyz')).map((o) => o.t).join('') === 'abc', 'ops append in order');
await s.replaceOps('cabc123xyz', [{ t: 'z' }]);
check((await s.loadOps('cabc123xyz')).map((o) => o.t).join('') === 'z', 'replaceOps starts over');
const got = await s.get('cabc123xyz');
check(got.name === 'Fox' && got.thumb.type === 'image/webp' && [...got.thumb.bytes].join() === '1,2,3', 'meta and thumbnail round-trip');
await s.put({ ...meta, id: 'cother00001', user: 'u2', thumb: null });
check((await s.list('u1')).length === 1 && (await s.list('u2'))[0].thumb === null, 'list is per account');
check((await s.get('nope00')) === null && (await s.loadOps('cabc123xyz'.replace('c', 'd'))).length === 0, 'missing canvases read as empty');
let threw = false; try { await s.get('../etc'); } catch { threw = true; }
check(threw, 'ids outside the folder are refused');
await s.delete('cabc123xyz');
check((await s.list('u1')).length === 0, 'delete removes the folder');
await fs.rm(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
