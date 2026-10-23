import { ctx2d, makeCanvas } from '../core/geom';
import { TILE, TiledSurface } from '../core/tiles';
import { saveFile } from '../io/platform';
import { safeFileName } from '../io/hivecanvas';
import { LapseSource, hiveLapseBlob, lapse, loadLapse, recordingOn, setRecording } from '../io/lapse';
import { HIVELAPSE_EXT } from '../shared/hivecanvas';
import { modal } from './dialogs';
import { h } from './dom';
import { icon } from './icons';

// Timelapse videos, made on this device from the recorded frames. Frames stay full size and
// lossless; only the video is scaled to fit 1080p or 4K.

const FPS = 30, HOLD_S = 2, MIN_S = 6, MAX_S = 90;
const SIZES = { '1080p': { edge: 1920, bps: 16e6 }, '4k': { edge: 3840, bps: 45e6 } } as const;
type Size = keyof typeof SIZES;
const MIMES = ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

const videoMime = () => typeof MediaRecorder === 'undefined' ? null : MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;

function lapseBounds(src: LapseSource) {
  const s = src.settings;
  if (!s.infinite) return { x: 0, y: 0, w: s.width, h: s.height };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of src.frames) for (const k of f.tiles.keys()) {
    const [tx, ty] = TiledSurface.parse(k);
    x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
  }
  return x1 < x0 ? null : { x: x0 * TILE, y: y0 * TILE, w: (x1 - x0 + 1) * TILE, h: (y1 - y0 + 1) * TILE };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function lapseVideo(src: LapseSource, size: Size, onProgress: (f: number) => void): Promise<{ blob: Blob; ext: string }> {
  const mime = videoMime();
  if (!mime) throw new Error('This browser can’t make videos. Save the .hivelapse and open it in the Doodlehive app.');
  const b = lapseBounds(src);
  if (!b || !src.frames.length) throw new Error('Nothing recorded yet. Draw for a bit first.');
  const k = Math.min(1, SIZES[size].edge / Math.max(b.w, b.h));
  const W = even(b.w * k), H = even(b.h * k), sx = W / b.w, sy = H / b.h;
  const art = makeCanvas(W, H), actx = ctx2d(art);
  const out = makeCanvas(W, H), octx = ctx2d(out);
  actx.imageSmoothingQuality = 'high';
  const stream = out.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: SIZES[size].bps });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });

  // Tiles land on whole pixels at their scaled place, so no seams show between them.
  const place = async (key: string, blob: Blob | null) => {
    const [tx, ty] = TiledSurface.parse(key);
    const x0 = Math.round((tx * TILE - b.x) * sx), y0 = Math.round((ty * TILE - b.y) * sy);
    const x1 = Math.round(((tx + 1) * TILE - b.x) * sx), y1 = Math.round(((ty + 1) * TILE - b.y) * sy);
    actx.clearRect(x0, y0, x1 - x0, y1 - y0);
    if (!blob) return;
    const img = await createImageBitmap(blob);
    actx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
    img.close();
  };
  const paint = () => {
    octx.fillStyle = src.settings.background ?? '#ffffff';
    octx.fillRect(0, 0, W, H);
    octx.drawImage(art, 0, 0);
    track.requestFrame();
  };

  const n = src.frames.length, seconds = Math.min(MAX_S, Math.max(MIN_S, n / FPS)), total = Math.round(seconds * FPS);
  rec.start(1000);
  let next = 0, clock = performance.now();
  const tick = async () => { clock += 1000 / FPS; const wait = clock - performance.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); };
  for (let v = 0; v < total; v++) {
    const upto = Math.min(n, Math.ceil(((v + 1) * n) / total));
    for (; next < upto; next++) for (const [key, blob] of src.frames[next].tiles) await place(key, blob);
    paint();
    onProgress((v + 1) / (total + HOLD_S * FPS));
    await tick();
  }
  for (let v = 0; v < HOLD_S * FPS; v++) { paint(); onProgress((total + v + 1) / (total + HOLD_S * FPS)); await tick(); }
  rec.stop();
  await stopped;
  track.stop();
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
}

const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** The open canvas's timelapse, or one from a .hivelapse file. */
export async function timelapseDialog(file?: LapseSource) {
  if (!file) await lapse.flush();
  const key = lapse.key;
  const src = file ?? (key ? await loadLapse(key).catch(() => null) : null);
  let size: Size = '1080p';
  const seg = h('div.segmented');
  for (const [s, label] of [['1080p', '1080p'], ['4k', '4K']] as const) {
    seg.append(h('button', { 'data-s': s, onclick: () => { size = s; for (const b of seg.children) b.classList.toggle('active', (b as HTMLElement).dataset.s === s); } }, label));
  }
  (seg.firstElementChild as HTMLElement).classList.add('active');
  const frames = src?.frames.length ?? 0;
  const span = frames > 1 ? src!.frames[frames - 1].t - src!.frames[0].t : 0;
  const summary = frames
    ? `${frames} frame${frames === 1 ? '' : 's'} recorded over ${duration(span)}. Frames are kept at full size on this device and never uploaded.`
    : 'Nothing recorded yet. Timelapses record on this device while you draw.';
  const status = h('p.muted', { role: 'status' });
  const err = h('p.error', { role: 'alert' });
  const record = h('input', { type: 'checkbox' }) as HTMLInputElement;
  record.checked = recordingOn();
  record.addEventListener('change', () => setRecording(record.checked));
  const body = h('div.modal-body', {},
    h('p.muted', {}, summary),
    h('label.row', {}, 'Video size', seg),
    file ? null : h('label.row.check', {}, record, 'Record timelapses on this device'),
    status, err,
  );
  const name = safeFileName(src?.name || 'timelapse');
  const saveLapse = h('button.btn', { html: icon('file', 16) + `<span>Save ${HIVELAPSE_EXT}</span>` });
  const saveVideo = h('button.btn.primary', { html: icon('download', 18) + '<span>Save video</span>' });
  if (!frames) { saveLapse.setAttribute('disabled', ''); saveVideo.setAttribute('disabled', ''); }
  const busy = (on: boolean) => { for (const b of [saveLapse, saveVideo]) b.toggleAttribute('disabled', on || !frames); };
  saveLapse.addEventListener('click', async () => {
    if (!src) return;
    busy(true); err.textContent = '';
    try { await saveFile(await hiveLapseBlob(src), name + HIVELAPSE_EXT); }
    catch (e) { err.textContent = (e as Error).message || 'Saving failed.'; }
    busy(false);
  });
  saveVideo.addEventListener('click', async () => {
    if (!src) return;
    busy(true); err.textContent = '';
    try {
      const v = await lapseVideo(src, size, (f) => { status.textContent = `Making the video… ${Math.round(f * 100)}% (keep this window open)`; });
      status.textContent = '';
      await saveFile(v.blob, `${name}-timelapse.${v.ext}`);
    } catch (e) { status.textContent = ''; err.textContent = (e as Error).message || 'The video couldn’t be made.'; }
    busy(false);
  });
  modal('Timelapse', body, [saveLapse, saveVideo]);
}
