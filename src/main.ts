import './style.css';
import { DrawDoc } from './core/document';
import { App } from './ui/app';
import { initTheme } from './ui/theme';
import { setSaveHandler } from './io/platform';
import { zipSingle } from './io/zip';

initTheme();
const root = document.getElementById('app')!;
// Start with an unlimited canvas behind the first dialog so the app is usable immediately.
const app = new App(root, DrawDoc.create({ width: 2048, height: 2048, infinite: true, background: '#ffffff' }));
// Logs in and joins a room when a server is available; otherwise shows the "New canvas" dialog.
app.session.start();

// Expose for debugging and automated tests.
(window as unknown as { doodlehive: App }).doodlehive = app;

// When running inside a claude.ai Artifact preview, downloads go through the host's save prompt.
type Downloads = { save(r: { filename: string; data: Blob }): Promise<unknown> };
const host = (window as unknown as { claude?: { use(name: string): Promise<Downloads | null> } }).claude;
host?.use('downloads').then((dl) => {
  if (!dl) return;
  setSaveHandler(async (blob, filename) => {
    try {
      await dl.save({ filename, data: blob });
    } catch (e) {
      // The preview host doesn't accept .psd directly, so wrap it in a .zip.
      if ((e as { code?: string }).code !== 'rejected_extension') throw e;
      await dl.save({ filename: filename.replace(/\.[^.]+$/, '') + '.zip', data: await zipSingle(filename, blob) });
    }
  });
});
