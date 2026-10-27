import { build, defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

const api = 'http://localhost:' + (process.env.PORT || 8787);

/** Built for the beta site: same test as the server's (server/config.ts). Canvas logs exist only there. */
const env = process.env;
const betaBuild = env.BETA ? env.BETA === '1' : (env.RAILWAY_ENVIRONMENT_NAME ?? '').toLowerCase() === 'beta' || /^https?:\/\/beta\./i.test(env.PUBLIC_URL ?? '');

/** In development, /app and /login (no trailing slash) should serve their pages, like the server does. */
const prettyUrls: Plugin = {
  name: 'pretty-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const m = /^\/(app|login|admin|404)\/?(\?.*)?$/.exec(req.url ?? '');
      if (m) req.url = `/${m[1]}.html${m[2] ?? ''}`;
      next();
    });
  },
};

/** After the build, compiles src/sw.ts to dist/sw.js with the list of files to keep offline. */
const serviceWorker: Plugin = {
  name: 'service-worker',
  apply: 'build',
  async closeBundle() {
    const dist = path.resolve(import.meta.dirname, 'dist');
    const files: string[] = [];
    for (const f of readdirSync(dist, { recursive: true }) as string[]) {
      if (/\.(html|js|css|svg|png|webmanifest)$/.test(f) && !/^(og\.png|sw\.js)$/.test(f)) files.push('/' + f.split(path.sep).join('/'));
    }
    const hash = createHash('sha1').update(files.join()).digest('hex').slice(0, 8);
    const out = await build({
      configFile: false, logLevel: 'warn',
      define: { __PRECACHE__: JSON.stringify(files.sort()), __VERSION__: JSON.stringify(`${version}-${hash}`) },
      build: { write: false, minify: true, target: 'es2020', lib: { entry: path.resolve(import.meta.dirname, 'src/sw.ts'), formats: ['es'], fileName: () => 'sw.js' } },
    });
    const chunk = (Array.isArray(out) ? out[0] : out as { output: { code: string }[] }).output[0];
    writeFileSync(path.join(dist, 'sw.js'), chunk.code);
    console.log(`  sw.js keeps ${files.length} files offline`);
  },
};

// Pages: / landing (index.html), /login (login.html), /app (app.html, the drawing app), /admin (admin.html), 404.html for everything else.
// Keep page files at the top level: Railway builds in a folder called /app, so an app/ folder of pages
// makes Vite resolve /app/index.html to the wrong file and silently drop the landing page.
// `npm run build:single` produces one self-contained HTML file of the app, for drawing offline.
export default defineConfig(({ mode, command }) => ({
  base: mode === 'single' ? './' : '/',
  define: { __APP_VERSION__: JSON.stringify(version), __CANVAS_LOG__: JSON.stringify(betaBuild || command === 'serve') },
  plugins: mode === 'single' ? [viteSingleFile()] : [prettyUrls, serviceWorker],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2020',
    rollupOptions: {
      input: mode === 'single'
        ? { app: path.resolve(import.meta.dirname, 'app.html') }
        : {
          landing: path.resolve(import.meta.dirname, 'index.html'),
          login: path.resolve(import.meta.dirname, 'login.html'),
          app: path.resolve(import.meta.dirname, 'app.html'),
          admin: path.resolve(import.meta.dirname, 'admin.html'),
          notfound: path.resolve(import.meta.dirname, '404.html'),
        },
    },
  },
  server: {
    // The room server runs separately in development; forward its routes.
    proxy: {
      '/api': api,
      '/auth': api,
      '/avatars': api,
      '/thumbs': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
}));
