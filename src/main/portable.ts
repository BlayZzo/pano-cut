// Projekte zwischen Mac und Windows austauschen.
// Beim Speichern merkt sich das Projekt zu jedem Dateipfad zusätzlich den Weg RELATIV zur Projektdatei.
// Selbst erstellte Daten aus dem Programm-Ordner (gemalte Masken, Bewegungsdaten, Naht-Messung, Sounds, Effekte,
// Objekte) werden in einen Ordner „<Projekt> (PanoCut-Daten)“ neben die Projektdatei kopiert – so ist alles dabei,
// wenn Projekt + Ordner auf einem anderen Rechner liegen (USB-Platte, iCloud/OneDrive …).
// Vorschau-Dateien (Proxy, Bildstreifen, Wellenform) werden NICHT mitgenommen – die erzeugt PanoCut neu.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import type { Project } from '@shared/types';

export interface PortableInfo {
  version: 1;
  platform: string;
  /** Pfad beim Speichern → Weg relativ zur Projektdatei (immer mit „/“). */
  files: Record<string, string>;
}

/** Felder mit Vorschau-Dateien: werden auf dem anderen Rechner neu erzeugt. */
const REGENERATED_KEYS = new Set(['thumb', 'proxy', 'sprite', 'waveform', 'proxyReversed', 'proxyStabilized']);

const isAbs = (p: string) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
const toSlash = (p: string) => p.split(path.sep).join('/');
export const dataDirName = (projectFile: string) => `${path.basename(projectFile).replace(/\.panocut$/i, '')} (PanoCut-Daten)`;

function userData(): string {
  try { return app.getPath('userData'); } catch { return ''; }
}

/** Selbst erstellte Datei im Programm-Ordner, die mitgenommen werden muss? */
function isOwnData(p: string, ud: string): boolean {
  if (!ud || !p.startsWith(ud + path.sep)) return false;
  const rel = path.relative(ud, p);
  const first = rel.split(path.sep)[0];
  if (first === 'models' || first === 'logs' || first === 'Cache' || first === 'GPUCache') return false;
  if (first === 'cache') {
    // Im Medien-Cache nur die eigene Arbeit: Masken, Bewegungsdaten, Naht-Messung
    return /[\\/]masks[\\/]/.test(rel) || path.basename(p) === 'imu.bin' || /^seam_/.test(path.basename(p));
  }
  return true;   // sounds, effects, objects, vfx …
}

function walkStrings(o: unknown, key: string, fn: (s: string, key: string) => string | undefined): unknown {
  if (typeof o === 'string') return fn(o, key) ?? o;
  if (Array.isArray(o)) return o.map((x) => walkStrings(x, key, fn));
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) out[k] = k === 'portable' ? v : walkStrings(v, k, fn);
    return out;
  }
  return o;
}

function copyIfChanged(src: string, dst: string): boolean {
  try {
    const a = fs.statSync(src);
    try {
      const b = fs.statSync(dst);
      if (b.size === a.size && b.mtimeMs >= a.mtimeMs) return true;
    } catch { /* noch nicht da */ }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (e) {
    log.warn('Mitnehmen fehlgeschlagen', src, e);
    return false;
  }
}

/** Vor dem Speichern: relative Wege eintragen und eigene Daten neben das Projekt kopieren. */
export function makePortable(project: Project, projectFile: string): Project {
  const dir = path.dirname(projectFile);
  const ud = userData();
  const dataDir = path.join(dir, dataDirName(projectFile));
  const files: Record<string, string> = { ...(project.portable?.files ?? {}) };
  const seen = new Set<string>();
  walkStrings(project, '', (s, key) => {
    if (s.length < 3 || !isAbs(s) || seen.has(s) || REGENERATED_KEYS.has(key)) return undefined;
    seen.add(s);
    let exists = false;
    try { exists = fs.statSync(s).isFile(); } catch { /* fehlt */ }
    if (!exists) return undefined;   // bisherigen Eintrag (z. B. vom anderen Rechner) behalten
    if (isOwnData(s, ud)) {
      const dst = path.join(dataDir, path.relative(ud, s));
      if (copyIfChanged(s, dst)) files[s] = toSlash(path.relative(dir, dst));
    } else {
      files[s] = toSlash(path.relative(dir, s));
    }
    return undefined;
  });
  // Nur Einträge behalten, die noch im Projekt vorkommen
  for (const k of Object.keys(files)) if (!seen.has(k)) delete files[k];
  return { ...project, portable: { version: 1, platform: process.platform, files } };
}

/** Beim Öffnen: Pfade, die es hier nicht gibt, über den relativen Weg neben der Projektdatei auflösen. */
export function resolvePortable(project: Project, projectFile: string): Project {
  const files = project.portable?.files;
  if (!files) return project;
  const dir = path.dirname(projectFile);
  let fixed = 0;
  const out = walkStrings(project, '', (s) => {
    const rel = files[s];
    if (!rel || fs.existsSync(s)) return undefined;
    const cand = path.resolve(dir, ...rel.split('/'));
    if (!fs.existsSync(cand)) return undefined;
    fixed++;
    return cand;
  }) as Project;
  if (fixed) log.info('Projekt von anderem Rechner: Pfade angepasst', fixed);
  return out;
}
