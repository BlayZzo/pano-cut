import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Content-Security-Policy nur im fertigen Build setzen (im Dev-Modus braucht Vite Inline-Skripte).
const cspPlugin: Plugin = {
  name: 'panocut-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' pcmedia: data: blob:; media-src 'self' pcmedia: blob:; connect-src 'self' pcmedia:; font-src 'self' data:;";
    return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  },
};

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), cspPlugin],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
