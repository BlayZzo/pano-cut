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
import { downloadModel, transcribe, whisperStatus } from './whisper';
import { translateTexts } from './translate';
import { startRemote, stopRemote } from './remote';
import { vfxBegin, vfxCancel, vfxEnd, vfxFrame, type VfxBeginRequest } from './vfx';
import { analyzeBeats, audioEnvelope } from './audio';
import { MODEL_EXTENSIONS } from '@shared/model3d';
import { aiAvailable, aiModelStatus, detectObjects, segmentObject } from './ai';
import { maskDir, renderObject } from './objects';
import { cloudDownload, cloudList, cloudTest, cloudUpload } from './cloud';
import type { AiDetectModel, AiProgress, AiSegmentModel, CloudSettings } from '@shared/types';
import type { FramePayload } from '@shared/ipc';
import type { WhisperModel, WhisperProgress } from '@shared/types';

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

/** Fernsteuerung (Stream Deck) je nach Einstellung starten/stoppen. */
function applyRemoteSetting(): void {
  const st = loadSettings();
  if (st.remoteControl === false) { stopRemote(); return; }
  startRemote(st.remotePort ?? 51888, (action) => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    sendToWindow(IPC.menuAction, action);
  }, () => ({ version: app.getVersion() }));
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
ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => {
  const next = saveSettings(patch);
  if ('remoteControl' in patch || 'remotePort' in patch) applyRemoteSetting();
  return next;
});
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
      { name: 'Alle Medien', extensions: [...SUPPORTED_EXTENSIONS, ...MODEL_EXTENSIONS] },
      { name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'mts', 'm2ts', 'mxf', 'insv', '360', 'lrv'] },
      { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'aif', 'aiff'] },
      { name: 'Bilder', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'insp'] },
      { name: '3D-Modelle', extensions: MODEL_EXTENSIONS },
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
ipcMain.handle(IPC.prepareMedia, (_e, item: MediaItem, options?: { reversed?: boolean; stabilized?: number }) => {
  const run = async () => {
    const settings = loadSettings();
    await prepareMedia(item, (updated) => sendToWindow(IPC.mediaUpdate, updated), settings.proxyHeight, options);
  };
  prepareQueue = prepareQueue.then(run, run);
  return prepareQueue;
});

// ---- Untertitel ----

let transcribeController: AbortController | null = null;
ipcMain.handle(IPC.whisperStatus, () => whisperStatus());
ipcMain.handle(IPC.downloadWhisperModel, async (_e, model: WhisperModel) => {
  await downloadModel(model, (p: WhisperProgress) => sendToWindow(IPC.whisperProgress, p));
});
ipcMain.handle(IPC.transcribe, async (_e, req: { mediaPath: string; start: number; duration: number; language: string; model: WhisperModel; maxChars: number; translate?: boolean }) => {
  transcribeController?.abort();
  transcribeController = new AbortController();
  try {
    return await transcribe(req, (p) => sendToWindow(IPC.whisperProgress, p), transcribeController.signal);
  } catch (err) {
    sendToWindow(IPC.whisperProgress, { phase: 'error', percent: 0, message: (err as Error).message } satisfies WhisperProgress);
    throw err;
  } finally {
    transcribeController = null;
  }
});
ipcMain.handle(IPC.cancelTranscribe, () => { transcribeController?.abort(); });
ipcMain.handle(IPC.translateTexts, async (_e, texts: string[], source: string, target: string) => {
  const s = loadSettings();
  if (!s.translateUrl) throw new Error('Kein Übersetzungs-Server eingerichtet (Einstellungen → Übersetzung).');
  return translateTexts(texts, source, target, s.translateUrl, s.translateKey);
});
ipcMain.handle(IPC.readTextFile, (_e, p: string) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
});
ipcMain.handle(IPC.selectFile, async (_e, title: string, extensions: string[]) => {
  const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openFile'], filters: [{ name: extensions.join(', ').toUpperCase(), extensions }] });
  return res.canceled ? null : res.filePaths[0] ?? null;
});

// ---- KI ----

let aiController: AbortController | null = null;
const aiProgress = (p: AiProgress) => sendToWindow(IPC.aiProgress, p);
ipcMain.handle(IPC.aiStatus, () => ({ available: aiAvailable(), models: aiModelStatus() }));
ipcMain.handle(IPC.aiDetect, async (_e, frame: FramePayload, model: AiDetectModel, minScore?: number) => {
  aiController = new AbortController();
  try {
    return await detectObjects({ data: new Uint8Array(frame.data), width: frame.width, height: frame.height }, model, aiProgress, minScore ?? 0.3, aiController.signal);
  } catch (err) {
    aiProgress({ phase: 'error', percent: 0, message: (err as Error).message });
    throw err;
  }
});
ipcMain.handle(IPC.aiSegment, async (_e, frame: FramePayload, model: AiSegmentModel, box: { x: number; y: number; w: number; h: number } | null) => {
  aiController = new AbortController();
  try {
    return await segmentObject({ data: new Uint8Array(frame.data), width: frame.width, height: frame.height }, model, box, aiProgress, aiController.signal);
  } catch (err) {
    aiProgress({ phase: 'error', percent: 0, message: (err as Error).message });
    throw err;
  }
});
ipcMain.handle(IPC.aiSaveMask, async (_e, mediaPath: string, trackId: string, index: number | string, png: Uint8Array) => {
  const name = typeof index === 'number' ? String(index).padStart(5, '0') : String(index).replace(/[^\w-]/g, '_');
  const file = path.join(maskDir(mediaPath, trackId), `${name}.png`);
  fs.writeFileSync(file, Buffer.from(png));
  return file;
});
ipcMain.handle(IPC.aiCancel, () => { aiController?.abort(); });
ipcMain.handle(IPC.renderObject, async (_e, req: { project: Project; clipId: string; trackId: string; name: string }) => {
  return renderObject(req.project, req.clipId, req.trackId, req.name, (percent) => aiProgress({ phase: 'run', percent, message: 'Objekt wird freigestellt …' }));
});

// ---- Effekt-Simulationen ----

ipcMain.handle(IPC.vfxBegin, (_e, req: VfxBeginRequest) => vfxBegin(req));
ipcMain.handle(IPC.vfxFrame, (_e, jobId: string, rgba: Uint8Array) => vfxFrame(jobId, rgba));
ipcMain.handle(IPC.vfxEnd, (_e, jobId: string) => vfxEnd(jobId));
ipcMain.handle(IPC.vfxCancel, (_e, jobId: string) => { vfxCancel(jobId); });
ipcMain.handle(IPC.analyzeBeats, (_e, p: string) => analyzeBeats(p));
ipcMain.handle(IPC.audioEnvelope, (_e, p: string, start?: number, duration?: number) => audioEnvelope(p, start, duration));

// ---- Cloud ----

const cloudProgress = (p: { percent: number; message?: string }) => sendToWindow(IPC.cloudProgress, p);
ipcMain.handle(IPC.cloudTest, (_e, s: CloudSettings) => cloudTest(s));
ipcMain.handle(IPC.cloudList, (_e, s: CloudSettings, dir: string) => cloudList(s, dir));
ipcMain.handle(IPC.cloudUpload, (_e, s: CloudSettings, l: string, r: string) => cloudUpload(s, l, r, cloudProgress));
ipcMain.handle(IPC.cloudDownload, (_e, s: CloudSettings, r: string, l: string) => cloudDownload(s, r, l, cloudProgress));

ipcMain.handle(IPC.readJsonFile, (_e, p: string) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
});
ipcMain.handle(IPC.writeJsonFile, (_e, p: string, data: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 1));
  return p;
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
  applyRemoteSetting();
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
  stopRemote();
  app.quit();
});
