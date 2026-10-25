import { db } from './db.ts';
import { mediaOn, newMediaKey, putMedia } from './media.ts';

// Once R2 is set up, pictures still in the database move there in the background, one at a time.
// Each row is only switched over if nobody changed that picture meanwhile.

const SLOTS = [
  { kind: 'avatar', blob: 'avatar', key: 'avatar_key', version: 'avatar_version', type: 'avatar_type' },
  { kind: 'anim', blob: 'avatar_anim', key: 'avatar_anim_key', version: 'avatar_anim_version', type: `'image/gif'` },
  { kind: 'banner', blob: 'banner', key: 'banner_key', version: 'banner_version', type: 'banner_type' },
] as const;

export async function movePicturesToMedia() {
  if (!mediaOn) return;
  let moved = 0;
  for (const s of SLOTS) {
    const next = db.prepare(`SELECT id, ${s.blob} AS data, ${s.version} AS v, ${s.type} AS type FROM users WHERE ${s.blob} IS NOT NULL LIMIT 1 OFFSET ?`);
    const done = db.prepare(`UPDATE users SET ${s.blob} = NULL, ${s.key} = ? WHERE id = ? AND ${s.version} = ? AND ${s.blob} IS NOT NULL`);
    let skipped = 0;
    for (;;) {
      const row = next.get(skipped) as { id: string; data: Uint8Array; v: number; type: string | null } | undefined;
      if (!row) break;
      const key = newMediaKey(s.kind, row.id);
      await putMedia(key, Buffer.from(row.data), row.type || 'image/png');
      if (Number(done.run(key, row.id, row.v).changes)) moved++;
      else skipped++; // changed while uploading; its new picture went through the normal path or is next time's
    }
  }
  if (moved) console.log(`Moved ${moved} pictures to R2.`);
}
