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

export function defaultProjectPath(dir: string, name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Projekt';
  return path.join(dir, `${safe}.${PROJECT_EXT}`);
}
