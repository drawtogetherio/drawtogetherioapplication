import type { BlendMode as PsdBlend, Layer as PsdLayer } from 'ag-psd';
import { DrawDoc } from '../core/document';
import { Rect, ctx2d, makeCanvas, rectIntersect } from '../core/geom';
import { BlendMode } from '../core/model';
import { renderRegion } from '../engine/compositor';
import { saveFile } from './platform';

export type ExportFormat = 'png' | 'jpg' | 'psd';

const PSD_BLEND: Record<BlendMode, PsdBlend> = {
  normal: 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color dodge', 'color-burn': 'color burn', 'hard-light': 'hard light', 'soft-light': 'soft light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color',
  luminosity: 'luminosity', add: 'linear dodge',
};

/**
 * The area that gets exported: the canvas for fixed sizes, or the bounds of the artwork for
 * unlimited canvases (so a whiteboard exports only what is drawn).
 */
export function exportRect(doc: DrawDoc): Rect | null {
  const b = doc.bounds();
  if (!b) return null;
  return doc.settings.infinite ? b : rectIntersect(b, { x: 0, y: 0, w: doc.settings.width, h: doc.settings.height });
}

export interface ExportOptions { format: ExportFormat; quality: number; transparent: boolean; name: string }

export async function exportDoc(doc: DrawDoc, o: ExportOptions) {
  const r = exportRect(doc);
  if (!r) throw new Error('Nothing to export yet. Draw something first.');
  const paper = !o.transparent || o.format === 'jpg';
  if (o.format === 'psd') {
    const blob = new Blob([await buildPsd(doc, r, paper)], { type: 'image/vnd.adobe.photoshop' });
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
  const blob = await new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), type, o.quality));
  return saveFile(blob, `${o.name}.${o.format}`);
}

async function buildPsd(doc: DrawDoc, r: Rect, paper: boolean): Promise<ArrayBuffer> {
  const { writePsd } = await import('ag-psd'); // loaded only when exporting PSD
  const children: PsdLayer[] = [];
  if (paper && doc.settings.background) {
    const bg = makeCanvas(r.w, r.h);
    const ctx = ctx2d(bg);
    ctx.fillStyle = doc.settings.background;
    ctx.fillRect(0, 0, r.w, r.h);
    children.push({ name: 'Background', canvas: bg, left: 0, top: 0 });
  }
  for (const l of doc.layers) {
    const canvas = renderRegion(doc, r, { paper: false, only: l.props.id, raw: true });
    children.push({
      name: l.props.name, canvas, left: 0, top: 0, opacity: l.props.opacity,
      blendMode: PSD_BLEND[l.props.blend], hidden: !l.props.visible,
      transparencyProtected: l.props.alphaLock,
    });
  }
  const composite = makeCanvas(r.w, r.h);
  const cctx = ctx2d(composite);
  if (paper && doc.settings.background) { cctx.fillStyle = doc.settings.background; cctx.fillRect(0, 0, r.w, r.h); }
  cctx.drawImage(renderRegion(doc, r, { paper: false }), 0, 0);
  return writePsd({ width: r.w, height: r.h, children, canvas: composite }, { generateThumbnail: true });
}
