// Canvases the desktop app keeps as plain files: <userData>/canvases/<id>/{meta.json, ops.jsonl, thumb}.
const fs = require('node:fs/promises');
const path = require('node:path');

const ID_RE = /^[a-z0-9]{6,32}$/;

class CanvasStore {
  constructor(root) { this.root = root; }

  dir(id) {
    if (!ID_RE.test(id)) throw new Error('bad canvas id');
    return path.join(this.root, id);
  }

  async list(user) {
    let ids = [];
    try { ids = await fs.readdir(this.root); } catch { return []; }
    const out = [];
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const c = await this.get(id).catch(() => null);
      if (c && c.user === user) out.push(c);
    }
    return out;
  }

  async get(id) {
    const d = this.dir(id);
    let meta;
    try { meta = JSON.parse(await fs.readFile(path.join(d, 'meta.json'), 'utf8')); } catch { return null; }
    const { thumbType, ...rest } = meta;
    let thumb = null;
    if (thumbType) {
      const bytes = await fs.readFile(path.join(d, 'thumb')).catch(() => null);
      if (bytes) thumb = { type: thumbType, bytes: new Uint8Array(bytes) };
    }
    return { ...rest, thumb };
  }

  async put(c) {
    const d = this.dir(c.id);
    await fs.mkdir(d, { recursive: true });
    const { thumb, ...meta } = c;
    if (thumb) await fs.writeFile(path.join(d, 'thumb'), Buffer.from(thumb.bytes));
    meta.thumbType = thumb ? thumb.type : null;
    await fs.writeFile(path.join(d, 'meta.json.tmp'), JSON.stringify(meta));
    await fs.rename(path.join(d, 'meta.json.tmp'), path.join(d, 'meta.json'));
  }

  async loadOps(id) {
    let text;
    try { text = await fs.readFile(path.join(this.dir(id), 'ops.jsonl'), 'utf8'); } catch { return []; }
    const ops = [];
    for (const line of text.split('\n')) if (line) { try { ops.push(JSON.parse(line)); } catch { /* a cut-off last line */ } }
    return ops;
  }

  async appendOps(id, ops) {
    if (!ops.length) return;
    await fs.mkdir(this.dir(id), { recursive: true });
    await fs.appendFile(path.join(this.dir(id), 'ops.jsonl'), ops.map((op) => JSON.stringify(op) + '\n').join(''));
  }

  async replaceOps(id, ops) {
    const d = this.dir(id);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'ops.jsonl.tmp'), ops.map((op) => JSON.stringify(op) + '\n').join(''));
    await fs.rename(path.join(d, 'ops.jsonl.tmp'), path.join(d, 'ops.jsonl'));
  }

  async delete(id) {
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }
}

module.exports = { CanvasStore };
