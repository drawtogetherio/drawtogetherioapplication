import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

const api = 'http://localhost:' + (process.env.PORT || 8787);

/** In development, /app and /login (no trailing slash) should serve their pages, like the server does. */
const prettyUrls: Plugin = {
  name: 'pretty-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const m = /^\/(app|login)(\?.*)?$/.exec(req.url ?? '');
      if (m) req.url = `/${m[1]}/${m[2] ?? ''}`;
      next();
    });
  },
};

// Pages: / landing, /login, /app (the drawing app).
// `npm run build:single` produces one self-contained HTML file of the app (used for previews).
export default defineConfig(({ mode }) => ({
  base: mode === 'single' ? './' : '/',
  plugins: mode === 'single' ? [viteSingleFile()] : [prettyUrls],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2020',
    rollupOptions: {
      input: mode === 'single'
        ? { app: path.resolve(__dirname, 'app/index.html') }
        : {
          landing: path.resolve(__dirname, 'index.html'),
          login: path.resolve(__dirname, 'login/index.html'),
          app: path.resolve(__dirname, 'app/index.html'),
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
