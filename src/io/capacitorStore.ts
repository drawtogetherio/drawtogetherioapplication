import type { NativeBridge, NativeCanvas } from './native';

// The iPad app: canvases as files in the app's own storage, through Capacitor's Filesystem plugin.

interface Filesystem {
  readdir(o: { path: string; directory: string }): Promise<{ files: { name: string }[] }>;
  readFile(o: { path: string; directory: string; encoding?: string }): Promise<{ data: string | Blob }>;
  writeFile(o: { path: string; directory: string; data: string; encoding?: string; recursive?: boolean }): Promise<unknown>;
  appendFile(o: { path: string; directory: string; data: string; encoding?: string }): Promise<unknown>;
  rmdir(o: { path: string; directory: string; recursive: boolean }): Promise<unknown>;
  mkdir(o: { path: string; directory: string; recursive: boolean }): Promise<unknown>;
}

const DIR = 'DATA', ROOT = 'canvases', UTF8 = 'utf8';
const ID_RE = /^[a-z0-9]{6,32}$/;

const b64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const text = async (d: string | Blob) => (typeof d === 'string' ? d : d.text());

export function capacitorBridge(fs: Filesystem): NativeBridge {
  const dir = (id: string) => { if (!ID_RE.test(id)) throw new Error('bad canvas id'); return `${ROOT}/${id}`; };
  const read = (path: string, encoding?: string) => fs.readFile({ path, directory: DIR, encoding }).then((r) => r.data);
  const get = async (id: string): Promise<NativeCanvas | null> => {
    let meta: NativeCanvas & { thumbType?: string | null };
    try { meta = JSON.parse(await text(await read(`${dir(id)}/meta.json`, UTF8))); } catch { return null; }
    const { thumbType, ...rest } = meta;
    let thumb: NativeCanvas['thumb'] = null;
    if (thumbType) { const d = await read(`${dir(id)}/thumb`).catch(() => null); if (typeof d === 'string') thumb = { type: thumbType, bytes: unb64(d) }; }
    return { ...rest, thumb };
  };
  const lines = (ops: unknown[]) => ops.map((op) => JSON.stringify(op) + '\n').join('');
  return {
    platform: 'mac',
    version: 'ipad',
    canvases: {
      async list(user) {
        let names: string[] = [];
        try { names = (await fs.readdir({ path: ROOT, directory: DIR })).files.map((f) => f.name); } catch { return []; }
        const out: NativeCanvas[] = [];
        for (const id of names) { if (!ID_RE.test(id)) continue; const c = await get(id).catch(() => null); if (c && c.user === user) out.push(c); }
        return out;
      },
      get,
      async put(c) {
        const { thumb, ...meta } = c;
        await fs.mkdir({ path: dir(c.id), directory: DIR, recursive: true }).catch(() => {});
        if (thumb) await fs.writeFile({ path: `${dir(c.id)}/thumb`, directory: DIR, data: b64(thumb.bytes) });
        await fs.writeFile({ path: `${dir(c.id)}/meta.json`, directory: DIR, data: JSON.stringify({ ...meta, thumbType: thumb?.type ?? null }), encoding: UTF8 });
      },
      async loadOps(id) {
        let t = '';
        try { t = await text(await read(`${dir(id)}/ops.jsonl`, UTF8)); } catch { return []; }
        const ops = [];
        for (const line of t.split('\n')) if (line) { try { ops.push(JSON.parse(line)); } catch { /* a cut-off last line */ } }
        return ops;
      },
      async appendOps(id, ops) {
        if (!ops.length) return;
        await fs.mkdir({ path: dir(id), directory: DIR, recursive: true }).catch(() => {});
        await fs.appendFile({ path: `${dir(id)}/ops.jsonl`, directory: DIR, data: lines(ops), encoding: UTF8 });
      },
      async replaceOps(id, ops) {
        await fs.writeFile({ path: `${dir(id)}/ops.jsonl`, directory: DIR, data: lines(ops), encoding: UTF8, recursive: true });
      },
      async delete(id) {
        await fs.rmdir({ path: dir(id), directory: DIR, recursive: true }).catch(() => {});
      },
    },
  };
}
