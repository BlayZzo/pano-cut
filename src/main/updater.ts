import { app, net, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import type { UpdateStatus } from '@shared/types';

const REPO = 'BlayZzo/pano-cut';

type StatusFn = (s: UpdateStatus) => void;

let emit: StatusFn = () => {};
let macRelease: { version: string; url: string; name: string; notes?: string } | null = null;
let macDownloaded: string | null = null;

export function initUpdater(onStatus: StatusFn): void {
  emit = onStatus;
  if (!app.isPackaged) return;
  if (process.platform !== 'darwin') {
    // Windows & Linux: vollautomatisch über electron-updater (GitHub Releases)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
      autoUpdater.logger = log;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }));
      autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined }));
      autoUpdater.on('update-not-available', () => emit({ state: 'not-available' }));
      autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent) }));
      autoUpdater.on('update-downloaded', (info) => emit({ state: 'downloaded', version: info.version }));
      autoUpdater.on('error', (err) => emit({ state: 'error', message: err?.message ?? String(err) }));
    } catch (err) {
      log.warn('Updater nicht verfügbar', err);
    }
  }
  // Beim Start leise prüfen
  setTimeout(() => { checkForUpdates().catch(() => {}); }, 8000);
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    emit({ state: 'not-available', message: 'Entwicklungsversion' });
    return;
  }
  if (process.platform !== 'darwin') {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    await autoUpdater.checkForUpdates();
    return;
  }
  // Mac: neueste Version auf GitHub nachschlagen
  emit({ state: 'checking' });
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}`);
    const data = await res.json() as { tag_name: string; body?: string; assets: Array<{ name: string; browser_download_url: string }> };
    const latest = data.tag_name.replace(/^v/, '');
    if (compareVersions(latest, app.getVersion()) <= 0) {
      emit({ state: 'not-available' });
      return;
    }
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const asset = data.assets.find((a) => a.name.endsWith('.dmg') && a.name.includes(arch))
      ?? data.assets.find((a) => a.name.endsWith('.dmg'));
    if (!asset) {
      emit({ state: 'not-available' });
      return;
    }
    macRelease = { version: latest, url: asset.browser_download_url, name: asset.name, notes: data.body };
    emit({ state: 'available', version: latest, downloadUrl: asset.browser_download_url, releaseNotes: data.body });
  } catch (err) {
    emit({ state: 'error', message: (err as Error).message });
  }
}

export async function downloadUpdate(): Promise<void> {
  if (process.platform !== 'darwin') {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    await autoUpdater.downloadUpdate();
    return;
  }
  if (!macRelease) return;
  emit({ state: 'downloading', percent: 0, version: macRelease.version });
  try {
    const res = await net.fetch(macRelease.url);
    if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const dest = path.join(app.getPath('downloads'), macRelease.name);
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      out.write(Buffer.from(value));
      if (total) emit({ state: 'downloading', percent: Math.round((received / total) * 100), version: macRelease.version });
    }
    await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.on('error', reject); });
    macDownloaded = dest;
    emit({ state: 'downloaded', version: macRelease.version, message: dest });
  } catch (err) {
    emit({ state: 'error', message: (err as Error).message });
  }
}

export async function installUpdate(): Promise<void> {
  if (process.platform !== 'darwin') {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.quitAndInstall(false, true);
    return;
  }
  if (macDownloaded) {
    await shell.openPath(macDownloaded);
    shell.showItemInFolder(macDownloaded);
  }
}
