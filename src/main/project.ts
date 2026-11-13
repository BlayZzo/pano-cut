import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { DEFAULT_SETTINGS, type MediaItem, type Project, type Settings } from '@shared/types';
import { getSettingsPath } from './paths';

export const PROJECT_EXT = 'panocut';

let settingsCache: Settings | null = null;

export function loadSettings(): Settings {
  if (settingsCache) return settingsCache;
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    settingsCache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache!;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  settingsCache = next;
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    log.warn('Einstellungen konnten nicht gespeichert werden', err);
  }
  return next;
}

export function rememberProject(filePath: string): void {
  const s = loadSettings();
  const recent = [filePath, ...s.recentProjects.filter((p) => p !== filePath)].slice(0, 10);
  saveSettings({ lastProject: filePath, recentProjects: recent });
}

/** Speichert ein Projekt als JSON. Medienpfade werden absolut gespeichert. */
export function writeProject(project: Project, filePath: string): void {
  const data: Project = { ...project, modifiedAt: Date.now() };
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
  rememberProject(filePath);
}

export function readProject(filePath: string): Project {
  const raw = fs.readFileSync(filePath, 'utf8');
  const project = JSON.parse(raw) as Project;
  if (!project || project.version !== 1 || !project.tracks || !project.clips) {
    throw new Error('Die Datei ist kein gültiges PanoCut-Projekt.');
  }
  relinkMoved(project, [path.dirname(filePath)]);
  // Fehlende Cache-Dateien erkennen, damit sie neu erzeugt werden
  for (const m of Object.values(project.media) as MediaItem[]) {
    if (!fs.existsSync(m.path)) {
      m.status = 'error';
      m.error = 'Datei nicht gefunden: ' + m.path;
      continue;
    }
    if (m.companion && !fs.existsSync(m.companion)) { if (m.proxy === m.companion) delete m.proxy; delete m.companion; }
    const missing = [m.thumb, m.proxy, m.sprite?.path, m.waveform].some((p) => p && !fs.existsSync(p));
    if (missing || m.status === 'analyzing') m.status = 'processing';
    if (m.proxyReversed && !fs.existsSync(m.proxyReversed)) delete m.proxyReversed;
  }
  rememberProject(filePath);
  return project;
}

/**
 * Verschobene Videos/Sounds wiederfinden: gleicher Dateiname im Projektordner, in den Ordnern der anderen
 * (gefundenen) Dateien, in `extraDirs` und je eine Ebene darunter. Gibt die Zahl neu verknüpfter Dateien zurück.
 */
export function relinkMoved(project: Project, extraDirs: string[] = []): number {
  // Mehrere Runden: gefundene Dateien verraten den neuen Ordner, darunter liegen oft die übrigen (z. B. „Musik“)
  let total = 0;
  for (let round = 0; round < 3; round++) {
    const n = relinkRound(project, extraDirs);
    total += n;
    if (n === 0) break;
  }
  return total;
}

function relinkRound(project: Project, extraDirs: string[]): number {
  const media = Object.values(project.media) as MediaItem[];
  const missing = media.filter((m) => !fs.existsSync(m.path));
  if (missing.length === 0) return 0;
  const dirs = new Set<string>(extraDirs);
  for (const m of media) if (fs.existsSync(m.path)) dirs.add(path.dirname(m.path));
  // Alter Ordner wurde umbenannt/verschoben? Gleichnamige Ordner neben/unter den Kandidaten mit prüfen
  const oldDirs = new Set(missing.map((m) => path.basename(path.dirname(m.path))));
  for (const d of [...dirs]) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.slice(0, 400)) if (e.isDirectory() && !e.name.startsWith('.')) dirs.add(path.join(d, e.name));
    for (const name of oldDirs) { const sib = path.join(path.dirname(d), name); if (fs.existsSync(sib)) dirs.add(sib); }
  }
  let n = 0;
  for (const m of missing) {
    const base = path.basename(m.path);
    for (const d of dirs) {
      const cand = path.join(d, base);
      if (!fs.existsSync(cand)) continue;
      try { if (m.info?.fileSize && fs.statSync(cand).size !== m.info.fileSize) continue; } catch { continue; }
      const oldDir = path.dirname(m.path);
      m.path = cand;
      if (m.companion && !fs.existsSync(m.companion)) {
        const c = path.join(d, path.basename(m.companion));
        if (fs.existsSync(c)) { if (m.proxy === m.companion) m.proxy = c; m.companion = c; }
      }
      log.info('Datei wiedergefunden', path.join(oldDir, base), '→', cand);
      n++;
      break;
    }
  }
  return n;
}

export function defaultProjectPath(dir: string, name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Projekt';
  return path.join(dir, `${safe}.${PROJECT_EXT}`);
}
