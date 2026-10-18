import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

function unpacked(p: string): string {
  // Native Binaries liegen außerhalb des asar-Archivs.
  return p.replace('app.asar', 'app.asar.unpacked');
}

let ffmpegPath: string | null = null;
let ffprobePath: string | null = null;

export function getFfmpegPath(): string {
  if (ffmpegPath) return ffmpegPath;
  const envPath = process.env.PANOCUT_FFMPEG;
  if (envPath && fs.existsSync(envPath)) return (ffmpegPath = envPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const p = require('ffmpeg-static') as string | null;
  if (!p) throw new Error('FFmpeg wurde nicht gefunden.');
  ffmpegPath = unpacked(p);
  return ffmpegPath;
}

export function getFfprobePath(): string {
  if (ffprobePath) return ffprobePath;
  const envPath = process.env.PANOCUT_FFPROBE;
  if (envPath && fs.existsSync(envPath)) return (ffprobePath = envPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('ffprobe-static') as { path: string };
  ffprobePath = unpacked(mod.path);
  return ffprobePath;
}

export function getCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getProjectsDir(): string {
  const dir = path.join(app.getPath('videos'), 'PanoCut');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignorieren */ }
  return dir;
}

export function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Eindeutiger Cache-Ordner pro Mediendatei (Pfad + Größe + Änderungsdatum). */
export function mediaCacheDir(filePath: string): string {
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(filePath); } catch { /* Datei fehlt */ }
  const key = `${filePath}|${stat?.size ?? 0}|${stat?.mtimeMs ?? 0}`;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const dir = path.join(getCacheDir(), hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileExists(p: string | undefined): p is string {
  return !!p && fs.existsSync(p);
}
