import type { TiledSurface } from '../core/tiles';
import type { BlendMode as PsdBlend, Layer as PsdLayer } from 'ag-psd';
import { DrawDoc } from '../core/document';
import { Rect, ctx2d, makeCanvas, rectIntersect } from '../core/geom';
import { BlendMode, FolderProps } from '../core/model';
import { renderRegion } from '../engine/compositor';
import { saveFile } from './platform';
import { hiveCanvasBlob } from './hivecanvas';
import { encodeImage } from '../engine/offload';

export type ExportFormat = 'png' | 'jpg' | 'psd' | 'hivecanvas';

const PSD_BLEND: Record<BlendMode, PsdBlend> = {
  normal: 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color dodge', 'color-burn': 'color burn', 'hard-light': 'hard light', 'soft-light': 'soft light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
  luminosity: 'luminosity', add: 'linear dodge',
};

/** The canvas, or the drawn area of an unlimited one. */
export function exportRect(doc: DrawDoc): Rect | null {
  const b = doc.bounds();
  if (!b) return null;
  return doc.settings.infinite ? b : rectIntersect(b, { x: 0, y: 0, w: doc.settings.width, h: doc.settings.height });
}

export interface ExportOptions {
  format: ExportFormat; quality: number; transparent: boolean; name: string;
  folderName?: (f: FolderProps) => string;
}

export async function exportDoc(doc: DrawDoc, o: ExportOptions) {
  if (o.format === 'hivecanvas') return saveFile(await hiveCanvasBlob(doc, o.name), `${o.name}.hivecanvas`);
  const r = exportRect(doc);
  if (!r) throw new Error('Nothing to export yet. Draw something first.');
  const paper = !o.transparent || o.format === 'jpg';
  if (o.format === 'psd') {
    const blob = new Blob([await buildPsd(doc, r, paper, o.folderName)], { type: 'image/vnd.adobe.photoshop' });
    return saveFile(blob, `${o.name}.psd`);
  }
  const c = renderRegion(doc, r, { paper: false });
  let out = c;
  if (paper) {
    out = makeCanvas(r.w, r.h);
    const ctx = ctx2d(out);
    ctx.fillStyle = (o.format === 'jpg' ? doc.settings.background ?? '#ffffff' : doc.settings.background) ?? 'transparent';
    if (doc.settings.background || o.format === 'jpg') ctx.fillRect(0, 0, r.w, r.h);
    ctx.drawImage(c, 0, 0);
  }
  const type = o.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await encodeImage(ctx2d(out, true).getImageData(0, 0, out.width, out.height), type, o.quality);
  if (!blob) throw new Error('Encoding failed');
  return saveFile(blob, `${o.name}.${o.format}`);
}

/** The mask as PSD expects it: white shows, black hides. */
function maskCanvas(mask: TiledSurface, r: Rect): HTMLCanvasElement {
  const c = makeCanvas(r.w, r.h), ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, r.w, r.h);
  const m = mask.extract(r), mc = ctx2d(m);
  mc.globalCompositeOperation = 'source-in';
  mc.fillStyle = '#000';
  mc.fillRect(0, 0, r.w, r.h);
  ctx.drawImage(m, 0, 0);
  return c;
}

async function buildPsd(doc: DrawDoc, r: Rect, paper: boolean, folderName?: (f: FolderProps) => string): Promise<ArrayBuffer> {
  const { writePsd } = await import('ag-psd'); // loaded only when exporting PSD
  const children: PsdLayer[] = [];
  if (paper && doc.settings.background) {
    const bg = makeCanvas(r.w, r.h);
    const ctx = ctx2d(bg);
    ctx.fillStyle = doc.settings.background;
    ctx.fillRect(0, 0, r.w, r.h);
    children.push({ name: 'Background', canvas: bg, left: 0, top: 0 });
  }
  const build = (parent: string | null): PsdLayer[] => doc.children(parent).map((id) => {
    const n = doc.node(id)!;
    if (n.kind === 'folder') {
      return { name: folderName?.(n.props) ?? n.props.name, hidden: !n.props.visible, opened: true, blendMode: 'pass through', children: build(id) };
    }
    const p = n.props;
    return {
      name: p.name, canvas: renderRegion(doc, r, { paper: false, only: p.id, raw: true }), left: 0, top: 0,
      opacity: p.opacity, blendMode: PSD_BLEND[p.blend], hidden: !p.visible, transparencyProtected: p.alphaLock,
      clipping: !!p.clip, mask: n.mask ? { canvas: maskCanvas(n.mask, r), left: 0, top: 0 } : undefined,
    };
  });
  children.push(...build(null));
  const composite = makeCanvas(r.w, r.h);
  const cctx = ctx2d(composite);
  if (paper && doc.settings.background) { cctx.fillStyle = doc.settings.background; cctx.fillRect(0, 0, r.w, r.h); }
  cctx.drawImage(renderRegion(doc, r, { paper: false }), 0, 0);
  return writePsd({ width: r.w, height: r.h, children, canvas: composite }, { generateThumbnail: true });
}
