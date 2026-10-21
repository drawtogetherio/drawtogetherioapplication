import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

const api = 'http://localhost:' + (process.env.PORT || 8787);

/** In development, /app and /login (no trailing slash) should serve their pages, like the server does. */
const prettyUrls: Plugin = {
  name: 'pretty-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const m = /^\/(app|login)\/?(\?.*)?$/.exec(req.url ?? '');
      if (m) req.url = `/${m[1]}.html${m[2] ?? ''}`;
      next();
    });
  },
};

// Pages: / landing (index.html), /login (login.html), /app (app.html, the drawing app).
// Keep page files at the top level: Railway builds in a folder called /app, so an app/ folder of pages
// makes Vite resolve /app/index.html to the wrong file and silently drop the landing page.
// `npm run build:single` produces one self-contained HTML file of the app (used for previews).
export default defineConfig(({ mode }) => ({
  base: mode === 'single' ? './' : '/',
  plugins: mode === 'single' ? [viteSingleFile()] : [prettyUrls],
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
