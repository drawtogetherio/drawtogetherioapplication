import './style.css';
import { DrawDoc } from './core/document';
import { App } from './ui/app';
import { initTheme } from './ui/theme';
import { setSaveHandler } from './io/platform';
import { zipSingle } from './io/zip';
import { startIpad } from './ui/ipadApp';

initTheme();
const root = document.getElementById('app')!;
const app = new App(root, DrawDoc.create({ width: 2048, height: 2048, infinite: true, background: '#ffffff' }));
app.session.start();

(window as unknown as { doodlehive: App }).doodlehive = app;
startIpad(app);

// Inside an Artifact preview, downloads go through the host's save prompt.
type Downloads = { save(r: { filename: string; data: Blob }): Promise<unknown> };
const host = (window as unknown as { claude?: { use(name: string): Promise<Downloads | null> } }).claude;
host?.use('downloads').then((dl) => {
  if (!dl) return;
  setSaveHandler(async (blob, filename) => {
    try {
      await dl.save({ filename, data: blob });
    } catch (e) {
      if ((e as { code?: string }).code !== 'rejected_extension') throw e;
      await dl.save({ filename: filename.replace(/\.[^.]+$/, '') + '.zip', data: await zipSingle(filename, blob) });
    }
  });
});
