import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const api = 'http://localhost:' + (process.env.PORT || 8787);

// `npm run build:single` produces one self-contained HTML file (used for previews).
export default defineConfig(({ mode }) => ({
  base: mode === 'single' ? './' : '/',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist', target: 'es2020' },
  server: {
    // The room server runs separately in development; forward its routes.
    proxy: {
      '/api': api,
      '/auth': api,
      '/avatars': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
}));
