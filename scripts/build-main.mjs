// Bündelt den Electron-Hauptprozess und das Preload-Skript mit esbuild.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  // Diese Pakete dürfen nicht gebündelt werden (native Binaries / Electron-API).
  external: ['electron', 'ffmpeg-static', 'ffprobe-static', 'electron-updater', 'electron-log'],
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'info',
};

const targets = [
  { entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(root, 'dist/main/main.js') },
  { entryPoints: [path.join(root, 'src/main/preload.ts')], outfile: path.join(root, 'dist/main/preload.js') },
];

for (const t of targets) {
  await build({ ...common, ...t });
}
if (!watch) console.log('Hauptprozess gebaut.');
