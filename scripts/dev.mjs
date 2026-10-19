// Entwicklungsmodus: Vite-Dev-Server für die Oberfläche + Electron mit Live-Reload des Hauptprozesses.
import { createServer } from 'vite';
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = require('electron');

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;
console.log(`[dev] Oberfläche läuft auf ${url}`);

let child = null;
function startElectron() {
  if (child) child.kill();
  child = spawn(electronPath, [root], {
    stdio: 'inherit',
    env: { ...process.env, PANOCUT_DEV_URL: url, NODE_ENV: 'development' },
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0 && code !== 15) console.log(`[dev] Electron beendet (${code})`);
  });
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'ffmpeg-static', 'electron-updater', 'electron-log', 'onnxruntime-node'],
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'silent',
};

let first = true;
const mainCtx = await context({
  ...common,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(root, 'dist/main/main.js'),
  plugins: [{
    name: 'restart',
    setup(b) {
      b.onEnd((r) => {
        if (r.errors.length) { console.error(r.errors); return; }
        if (first) { first = false; } else { console.log('[dev] Hauptprozess neu gebaut – Electron startet neu'); }
        startElectron();
      });
    },
  }],
});
const preloadCtx = await context({
  ...common,
  entryPoints: [path.join(root, 'src/main/preload.ts')],
  outfile: path.join(root, 'dist/main/preload.js'),
});
await preloadCtx.rebuild();
await preloadCtx.watch();
const workerCtx = await context({
  ...common,
  entryPoints: [path.join(root, 'src/main/audioWorker.ts')],
  outfile: path.join(root, 'dist/main/audioWorker.js'),
});
await workerCtx.rebuild();
await workerCtx.watch();
const mtCtx = await context({
  ...common,
  entryPoints: [path.join(root, 'src/main/mtWorker.ts')],
  outfile: path.join(root, 'dist/main/mtWorker.js'),
});
await mtCtx.rebuild();
await mtCtx.watch();
await mainCtx.watch();

process.on('SIGINT', async () => {
  if (child) child.kill();
  await server.close();
  process.exit(0);
});
