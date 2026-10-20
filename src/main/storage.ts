// Ordner beobachten (neue Dateien melden – importiert wird nur auf Knopfdruck) und Speicher aufräumen.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { getCacheDir, mediaCacheDir } from './paths';
import { mediaTypeFor } from './media';

// ---------------------------------------------------------------- Ordner beobachten

let watcher: fs.FSWatcher | null = null;
let watchedDir: string | null = null;
const pending = new Map<string, NodeJS.Timeout>();
const reported = new Set<string>();

/** Startet (oder beendet mit null) das Beobachten eines Ordners. `onNew` bekommt fertig geschriebene Mediendateien. */
export function watchFolder(dir: string | null, onNew: (files: string[]) => void): { ok: boolean; message?: string } {
  if (watcher) { watcher.close(); watcher = null; }
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  watchedDir = null;
  if (!dir) return { ok: true };
  if (!fs.existsSync(dir)) return { ok: false, message: 'Ordner nicht gefunden' };
  const batch: string[] = [];
  let flush: NodeJS.Timeout | null = null;
  const report = (file: string) => {
    if (reported.has(file)) return;
    reported.add(file);
    batch.push(file);
    if (flush) clearTimeout(flush);
    flush = setTimeout(() => { onNew(batch.splice(0)); flush = null; }, 800);
  };
  // Erst melden, wenn die Datei nicht mehr wächst (Kamera/Handy kopiert noch)
  const settle = (file: string, lastSize = -1) => {
    const t = setTimeout(() => {
      pending.delete(file);
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return;
        if (st.size > 0 && st.size === lastSize) report(file);
        else settle(file, st.size);
      });
    }, 1500);
    pending.set(file, t);
  };
  try {
    watcher = fs.watch(dir, { recursive: process.platform !== 'linux' }, (_ev, name) => {
      if (!name) return;
      const file = path.join(dir, name.toString());
      if (!mediaTypeFor(file) || path.basename(file).startsWith('.') || pending.has(file) || reported.has(file)) return;
      settle(file);
    });
    watchedDir = dir;
    return { ok: true };
  } catch (e) {
    log.warn('Ordner beobachten fehlgeschlagen', e);
    return { ok: false, message: (e as Error).message };
  }
}

export function watchedFolder(): string | null { return watchedDir; }

// ---------------------------------------------------------------- Speicher

function dirSize(dir: string): { bytes: number; newest: number } {
  let bytes = 0, newest = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const st = fs.statSync(p); bytes += st.size; newest = Math.max(newest, st.mtimeMs); } catch { /* egal */ } }
    }
  };
  walk(dir);
  return { bytes, newest };
}

export interface StorageInfo {
  cacheBytes: number;     // Vorschau-Dateien, Vorschaubilder, Masken …
  cacheItems: number;
  oldBytes: number;       // davon älter als 30 Tage unbenutzt
  soundsBytes: number;
  effectsBytes: number;   // erzeugte Effekte/3D-Objekte
  modelsBytes: number;    // KI-/Sprach-/Übersetzungsmodelle
}

const OLD_MS = 30 * 24 * 3600 * 1000;

export function storageInfo(): StorageInfo {
  const cache = getCacheDir();
  let cacheBytes = 0, oldBytes = 0, cacheItems = 0;
  const now = Date.now();
  for (const name of safeList(cache)) {
    const d = path.join(cache, name);
    const s = dirSize(d);
    cacheBytes += s.bytes;
    cacheItems++;
    if (now - s.newest > OLD_MS) oldBytes += s.bytes;
  }
  const ud = app.getPath('userData');
  return {
    cacheBytes, cacheItems, oldBytes,
    soundsBytes: dirSize(path.join(ud, 'sounds')).bytes,
    effectsBytes: dirSize(path.join(ud, 'effects')).bytes,
    modelsBytes: dirSize(path.join(ud, 'models')).bytes,
  };
}

function safeList(d: string): string[] {
  try { return fs.readdirSync(d); } catch { return []; }
}

/**
 * Aufräumen. 'old' = Vorschau-Ordner älter als 30 Tage, 'unused' = alles, was das offene Projekt nicht braucht,
 * 'all' = alle Vorschau-Dateien. Dateien des offenen Projekts (`keepMediaPaths`) bleiben immer erhalten.
 */
export function cleanStorage(mode: 'old' | 'unused' | 'all', keepMediaPaths: string[]): { freedBytes: number } {
  const cache = getCacheDir();
  const keep = new Set(keepMediaPaths.map((p) => { try { return path.basename(mediaCacheDir(p)); } catch { return ''; } }));
  let freed = 0;
  const now = Date.now();
  for (const name of safeList(cache)) {
    if (keep.has(name)) continue;
    const d = path.join(cache, name);
    const s = dirSize(d);
    const drop = mode === 'all' || mode === 'unused' || (mode === 'old' && now - s.newest > OLD_MS);
    if (!drop) continue;
    try { fs.rmSync(d, { recursive: true, force: true }); freed += s.bytes; } catch (e) { log.warn('Aufräumen', d, e); }
  }
  if (mode === 'all') {
    const sounds = path.join(app.getPath('userData'), 'sounds');
    const s = dirSize(sounds);
    try { fs.rmSync(sounds, { recursive: true, force: true }); freed += s.bytes; } catch { /* egal */ }
  }
  return { freedBytes: freed };
}
