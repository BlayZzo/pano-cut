import { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import log from 'electron-log';
import { IPC } from '@shared/ipc';
import type { AppInfo, ExportOptions, ExportProgress, MediaItem, Project, ProjectFile, Settings, UpdateStatus } from '@shared/types';
import { installMediaProtocol, registerMediaScheme } from './protocol';
import { getCacheDir, getProjectsDir } from './paths';
import { mediaTypeFor, prepareMedia, probeMedia, SUPPORTED_EXTENSIONS } from './media';
import { defaultProjectPath, loadSettings, PROJECT_EXT, readProject, rememberProject, saveSettings, writeProject } from './project';
import { ExportJob } from './exporter';
import { killAll } from './ffmpeg';
import { buildMenu } from './menu';
import { checkForUpdates, downloadUpdate, initUpdater, installUpdate } from './updater';

log.transports.file.level = 'info';
log.initialize();

let mainWindow: BrowserWindow | null = null;
let dirty = false;
let forceQuit = false;
const exportJobs = new Map<string, ExportJob>();
const DEV_URL = process.env.PANOCUT_DEV_URL;

// Nur eine Instanz zulassen
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

registerMediaScheme();
app.setName('PanoCut');
if (process.platform === 'win32') app.setAppUserModelId('de.blayzzo.panocut');

function sendToWindow(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function createWindow(): void {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1218',
    title: 'PanoCut',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (e) => {
    if (forceQuit || !dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      buttons: ['Speichern', 'Nicht speichern', 'Abbrechen'],
      defaultId: 0,
      cancelId: 2,
      message: 'Ungespeicherte Änderungen',
      detail: 'Möchtest du dein Projekt speichern, bevor PanoCut geschlossen wird?',
    });
    if (choice === 2) return;
    if (choice === 0) {
      sendToWindow(IPC.menuAction, 'saveAndQuit');
      return;
    }
    forceQuit = true;
    mainWindow?.close();
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

function refreshMenu(): void {
  buildMenu(() => mainWindow, () => loadSettings().recentProjects.filter((p) => fs.existsSync(p)), () => {});
}

// ---------------- IPC ----------------

ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  userData: app.getPath('userData'),
  cacheDir: getCacheDir(),
  projectsDir: getProjectsDir(),
  isPackaged: app.isPackaged,
}));

ipcMain.handle(IPC.getSettings, () => loadSettings());
ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => saveSettings(patch));
ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url));
ipcMain.handle(IPC.showInFolder, (_e, p: string) => shell.showItemInFolder(p));
ipcMain.on(IPC.setDirty, (_e, d: boolean) => {
  dirty = d;
  mainWindow?.setDocumentEdited(d);
});

ipcMain.handle(IPC.importToPhotos, async (_e, p: string) => {
  if (process.platform !== 'darwin') return { ok: false, message: 'Nur auf dem Mac verfügbar.' };
  return new Promise<{ ok: boolean; message?: string }>((resolve) => {
    const script = `tell application "Photos"\n import POSIX file "${p.replace(/"/g, '\\"')}"\n activate\nend tell`;
    execFile('osascript', ['-e', script], (err, _out, stderr) => {
      if (err) resolve({ ok: false, message: stderr || err.message });
      else resolve({ ok: true });
    });
  });
});

ipcMain.handle(IPC.uninstall, async () => {
  const res = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    buttons: ['Deinstallieren', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    message: 'PanoCut vollständig entfernen?',
    detail: process.platform === 'darwin'
      ? 'Die App wird in den Papierkorb gelegt, Vorschau-Cache und Einstellungen werden gelöscht. Deine Videos und Projektdateien bleiben erhalten.'
      : 'Der Windows-Deinstaller wird gestartet. Vorschau-Cache und Einstellungen werden entfernt. Deine Videos und Projektdateien bleiben erhalten.',
  });
  if (res.response !== 0) return;
  forceQuit = true;
  const userData = app.getPath('userData');
  if (process.platform === 'darwin') {
    const appBundle = path.resolve(app.getPath('exe'), '..', '..', '..');
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { log.warn(e); }
    if (appBundle.endsWith('.app')) {
      try { await shell.trashItem(appBundle); } catch (e) { log.warn('App konnte nicht in den Papierkorb gelegt werden', e); }
    }
    app.quit();
  } else if (process.platform === 'win32') {
    const uninstaller = path.join(path.dirname(app.getPath('exe')), 'Uninstall PanoCut.exe');
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { log.warn(e); }
    if (fs.existsSync(uninstaller)) {
      const child = execFile(uninstaller, [], { windowsHide: false });
      child.unref();
    } else {
      await shell.openExternal('ms-settings:appsfeatures');
    }
    app.quit();
  } else {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { log.warn(e); }
    app.quit();
  }
});

// ---- Medien ----

ipcMain.handle(IPC.selectMediaFiles, async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Medien importieren',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Alle Medien', extensions: SUPPORTED_EXTENSIONS },
      { name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'mts', 'm2ts', 'mxf', 'insv', '360', 'lrv'] },
      { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'aif', 'aiff'] },
      { name: 'Bilder', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'insp'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle(IPC.importMedia, async (_e, paths: string[]) => {
  const items: MediaItem[] = [];
  for (const p of paths) {
    if (!mediaTypeFor(p)) continue;
    try {
      items.push(await probeMedia(p));
    } catch (err) {
      log.warn('Import fehlgeschlagen', p, err);
    }
  }
  return items;
});

// Vorbereitung läuft nacheinander (Warteschlange), damit der Rechner nicht überlastet wird.
let prepareQueue: Promise<void> = Promise.resolve();
ipcMain.handle(IPC.prepareMedia, (_e, item: MediaItem, options?: { reversed?: boolean }) => {
  const run = async () => {
    const settings = loadSettings();
    await prepareMedia(item, (updated) => sendToWindow(IPC.mediaUpdate, updated), settings.proxyHeight, options);
  };
  prepareQueue = prepareQueue.then(run, run);
  return prepareQueue;
});

// ---- Projekt ----

ipcMain.handle(IPC.saveProject, async (_e, project: Project, filePath?: string) => {
  let target = filePath;
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: 'Projekt speichern',
      defaultPath: defaultProjectPath(getProjectsDir(), project.name),
      filters: [{ name: 'PanoCut-Projekt', extensions: [PROJECT_EXT] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  writeProject(project, target);
  dirty = false;
  mainWindow?.setDocumentEdited(false);
  mainWindow?.setRepresentedFilename(target);
  refreshMenu();
  return target;
});

ipcMain.handle(IPC.openProject, async (): Promise<ProjectFile | null> => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Projekt öffnen',
    defaultPath: getProjectsDir(),
    properties: ['openFile'],
    filters: [{ name: 'PanoCut-Projekt', extensions: [PROJECT_EXT] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const p = res.filePaths[0];
  const project = readProject(p);
  mainWindow?.setRepresentedFilename(p);
  refreshMenu();
  return { path: p, project };
});

ipcMain.handle(IPC.loadProject, async (_e, p: string): Promise<ProjectFile | null> => {
  if (!fs.existsSync(p)) {
    dialog.showErrorBox('Projekt nicht gefunden', `Die Datei existiert nicht mehr:\n${p}`);
    return null;
  }
  try {
    const project = readProject(p);
    rememberProject(p);
    mainWindow?.setRepresentedFilename(p);
    refreshMenu();
    return { path: p, project };
  } catch (err) {
    dialog.showErrorBox('Projekt konnte nicht geöffnet werden', (err as Error).message);
    return null;
  }
});

ipcMain.handle(IPC.newProjectDialog, async () => {
  if (!dirty) return true;
  const res = await dialog.showMessageBox(mainWindow!, {
    type: 'question',
    buttons: ['Verwerfen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    message: 'Ungespeicherte Änderungen verwerfen?',
    detail: 'Das aktuelle Projekt hat ungespeicherte Änderungen.',
  });
  return res.response === 0;
});

// ---- Export ----

ipcMain.handle(IPC.selectExportPath, async (_e, defaultName: string, ext: string) => {
  const res = await dialog.showSaveDialog(mainWindow!, {
    title: 'Video exportieren',
    defaultPath: path.join(app.getPath('videos'), `${defaultName}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return res.canceled || !res.filePath ? null : res.filePath;
});

ipcMain.handle(IPC.startExport, async (_e, project: Project, options: ExportOptions) => {
  const jobId = `job_${Date.now()}`;
  const job = new ExportJob(project, options, (p) => sendToWindow(IPC.exportProgress, { ...p, jobId } satisfies ExportProgress));
  exportJobs.set(jobId, job);
  job.run().catch((err) => log.warn('Export beendet mit Fehler', err?.message)).finally(() => exportJobs.delete(jobId));
  return jobId;
});

ipcMain.handle(IPC.cancelExport, (_e, jobId: string) => {
  exportJobs.get(jobId)?.cancel();
});

// ---- Updates ----

ipcMain.handle(IPC.checkForUpdates, () => checkForUpdates());
ipcMain.handle(IPC.downloadUpdate, () => downloadUpdate());
ipcMain.handle(IPC.installUpdate, () => installUpdate());

// ---------------- App-Lebenszyklus ----------------

app.whenReady().then(async () => {
  if (process.argv.includes('--smoke-test')) {
    const { runSmokeTest } = await import('./smoke');
    const code = await runSmokeTest();
    app.exit(code);
    return;
  }
  installMediaProtocol();
  createWindow();
  refreshMenu();
  initUpdater((s: UpdateStatus) => sendToWindow(IPC.updateStatus, s));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on(IPC.quitApp, () => {
  forceQuit = true;
  dirty = false;
  app.quit();
});

app.on('window-all-closed', () => {
  killAll();
  app.quit();
});
