import { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import log from 'electron-log';
import { IPC } from '@shared/ipc';
import type { AppInfo, ExportOptions, ExportProgress, MediaItem, Project, ProjectFile, Settings, UpdateStatus } from '@shared/types';
import { installMediaProtocol, registerMediaScheme } from './protocol';
import { getCacheDir, getProjectsDir } from './paths';
import { attachCompanion, listMediaInFolder, mediaTypeFor, prepareMedia, probeMedia, SUPPORTED_EXTENSIONS } from './media';
import { dropCompanions } from '@shared/companion';
import { defaultProjectPath, loadSettings, PROJECT_EXT, readProject, rememberProject, saveSettings, writeProject } from './project';
import { ExportJob } from './exporter';
import { killAll } from './ffmpeg';
import { buildMenu } from './menu';
import { checkForUpdates, downloadUpdate, initUpdater, installUpdate } from './updater';
import { downloadModel, transcribe, whisperStatus } from './whisper';
import { translateTexts } from './translate';
import { stopTranslators, translateLocal, type MtLang } from './mt';
import { startRemote, stopRemote } from './remote';
import { vfxBegin, vfxCancel, vfxEnd, vfxFrame, type VfxBeginRequest } from './vfx';
import { analyzeBeats, audioEnvelope } from './audio';
import { renderSfxFile } from './sfx';
import { blurCurve, motionCurve, silences } from './analysis';
import { cleanStorage, storageInfo, watchFolder } from './storage';
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

const UI_TEST = process.argv.includes('--ui-test');

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
      additionalArguments: UI_TEST ? ['--pc-ui-test'] : [],
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

// Ordner (aus dem Dialog oder hereingezogen) durch die enthaltenen Medien-Dateien ersetzen
ipcMain.handle(IPC.expandMediaPaths, async (_e, paths: string[]) => {
  const recursive = loadSettings().folderRecursive !== false;
  const out: string[] = [];
  for (const p of paths) {
    let dir = false;
    try { dir = fs.statSync(p).isDirectory(); } catch { /* fehlt */ }
    if (dir) out.push(...await listMediaInFolder(p, recursive));
    else out.push(p);
  }
  return [...new Set(out)];
});

ipcMain.handle(IPC.importMedia, async (_e, paths: string[]) => {
  // Mehrere Dateien gleichzeitig untersuchen (je Datei nur ein kurzer Blick in den Dateikopf)
  // Kamera-Vorschaudateien (.LRF/.LRV) nicht als eigenes Video importieren, wenn das große Video dabei ist
  const list = dropCompanions(paths.filter((p) => mediaTypeFor(p)));
  const useCompanion = loadSettings().useCompanion !== false;
  const results: Array<MediaItem | null> = new Array(list.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        const item = await probeMedia(list[i]);
        results[i] = useCompanion ? await attachCompanion(item) : item;
      } catch (err) { log.warn('Import fehlgeschlagen', list[i], err); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return results.filter((x): x is MediaItem => !!x);
});

// Vorbereitung in zwei Warteschlangen: zuerst für alle Dateien die schnellen Vorschaubilder/Wellenformen,
// danach nacheinander die Proxys – so erscheinen beim Import vieler Dateien sofort alle Vorschaubilder.
// Vorbereitungs-Warteschlange mit Reihenfolge: zuerst die schnellen Vorschaubilder, dann die Vorschau-Dateien.
// Die Reihenfolge kann in der Oberfläche per Ziehen geändert werden (oben = als Nächstes).
interface PrepJob {
  id: string;                      // Medien-ID
  item: MediaItem;
  options?: { reversed?: boolean; stabilized?: number };
  stage: 'quick' | 'heavy';
  running: boolean;
  skip?: boolean;                  // Vorschau-Datei überspringen
  done: () => void;
}
const prepJobs: PrepJob[] = [];
const HEAVY_SLOTS = process.platform === 'darwin' ? 2 : 1;
let quickRunning = false;
let heavyRunning = 0;

function broadcastPrepQueue(): void {
  sendToWindow(IPC.prepQueue, prepJobs.map((j) => ({ id: j.id, stage: j.stage, running: j.running })));
}

function pumpPrep(): void {
  const settings = loadSettings();
  const proxyMode = settings.proxyMode ?? 'auto';
  // Schnelle Schritte: einer nach dem anderen
  if (!quickRunning) {
    const job = prepJobs.find((j) => j.stage === 'quick' && !j.running);
    if (job) {
      quickRunning = true;
      job.running = true;
      broadcastPrepQueue();
      void prepareMedia(job.item, (u) => { job.item = u; sendToWindow(IPC.mediaUpdate, u); }, settings.proxyHeight, { ...job.options, stage: 'quick', proxyMode })
        .finally(() => {
          quickRunning = false;
          job.running = false;
          const it = job.item;
          if (it.status === 'error' || it.type !== 'video' || it.status === 'ready') finishPrep(job);
          else {
            job.stage = 'heavy';
            sendToWindow(IPC.mediaUpdate, { ...it, prep: { stage: 'waiting', percent: 0 } });
          }
          broadcastPrepQueue();
          pumpPrep();
        });
    }
  }
  // Vorschau-Dateien: in der gewählten Reihenfolge, mit begrenzter Anzahl gleichzeitig
  while (heavyRunning < HEAVY_SLOTS) {
    const job = prepJobs.find((j) => j.stage === 'heavy' && !j.running);
    if (!job) break;
    heavyRunning++;
    job.running = true;
    broadcastPrepQueue();
    const mode = job.skip ? 'auto' : proxyMode;
    const item = job.skip ? { ...job.item, info: { ...job.item.info } } : job.item;
    void prepareMedia(item, (u) => { job.item = u; sendToWindow(IPC.mediaUpdate, u); }, settings.proxyHeight, { ...job.options, stage: 'heavy', proxyMode: mode, skipProxy: job.skip })
      .finally(() => {
        heavyRunning--;
        finishPrep(job);
        broadcastPrepQueue();
        pumpPrep();
      });
  }
}

function finishPrep(job: PrepJob): void {
  const i = prepJobs.indexOf(job);
  if (i >= 0) prepJobs.splice(i, 1);
  job.done();
}

ipcMain.handle(IPC.prepareMedia, (_e, item: MediaItem, options?: { reversed?: boolean; stabilized?: number }) => new Promise<void>((resolve) => {
  // Schon in der Warteschlange? Dann nur Optionen ergänzen
  const existing = prepJobs.find((j) => j.id === item.id);
  if (existing) { existing.options = { ...existing.options, ...options }; resolve(); return; }
  prepJobs.push({ id: item.id, item, options, stage: 'quick', running: false, done: resolve });
  broadcastPrepQueue();
  pumpPrep();
}));

/** Neue Reihenfolge (Medien-IDs, oben = zuerst). Laufende Aufträge bleiben, wo sie sind. */
ipcMain.handle(IPC.prepReorder, (_e, ids: string[]) => {
  const rank = new Map(ids.map((id, i) => [id, i]));
  prepJobs.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  broadcastPrepQueue();
});
/** Vorschau-Datei für eine Datei nicht erstellen (sofort benutzbar, Abspielen evtl. weniger flüssig). */
ipcMain.handle(IPC.prepSkip, (_e, id: string) => {
  const job = prepJobs.find((j) => j.id === id);
  if (job && !job.running) { job.skip = true; job.stage = 'heavy'; prepJobs.splice(prepJobs.indexOf(job), 1); prepJobs.unshift(job); }
  broadcastPrepQueue();
  pumpPrep();
});
ipcMain.handle(IPC.prepQueueGet, () => prepJobs.map((j) => ({ id: j.id, stage: j.stage, running: j.running })));

// ---- Sound-Effekte ----
ipcMain.handle(IPC.renderSfx, (_e, id: string, params: Record<string, number>) => renderSfxFile(id, params));

ipcMain.handle(IPC.motionCurve, (_e, p: string, s: number, d: number) => motionCurve(p, s, d));
ipcMain.handle(IPC.silences, (_e, p: string, s: number, d: number, th?: number, md?: number) => silences(p, s, d, th, md));
ipcMain.handle(IPC.blurCurve, (_e, p: string, s: number, d: number) => blurCurve(p, s, d));

// ---- Ordner beobachten & Speicher ----
const startWatch = (dir: string | null) => watchFolder(dir, (files) => sendToWindow(IPC.watchNew, files));
ipcMain.handle(IPC.setWatchFolder, (_e, dir: string | null) => startWatch(dir));
ipcMain.handle(IPC.selectFolder, async (_e, title: string) => {
  const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0] ?? null;
});
ipcMain.handle(IPC.storageInfo, () => storageInfo());
ipcMain.handle(IPC.cleanStorage, (_e, mode: 'old' | 'unused' | 'all', keep: string[]) => cleanStorage(mode, keep));

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
ipcMain.handle(IPC.translateLocal, (_e, texts: string[], from: MtLang, to: MtLang) =>
  translateLocal(texts, from, to, (p) => sendToWindow(IPC.whisperProgress, { phase: p.percent >= 100 ? 'translate' : 'download', percent: p.percent, message: p.message })));
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

// Export-Warteschlange: ein Auftrag nach dem anderen, im Hintergrund – man kann dabei weiterschneiden
const exportQueue: Array<{ jobId: string; project: Project; options: ExportOptions }> = [];
let exportRunning = false;
function pumpExports(): void {
  if (exportRunning) return;
  const next = exportQueue.shift();
  if (!next) return;
  exportRunning = true;
  const { jobId, project, options } = next;
  const job = new ExportJob(project, options, (p) => sendToWindow(IPC.exportProgress, { ...p, jobId, name: options.name } satisfies ExportProgress));
  exportJobs.set(jobId, job);
  job.run().catch((err) => log.warn('Export beendet mit Fehler', err?.message)).finally(() => {
    exportJobs.delete(jobId);
    exportRunning = false;
    pumpExports();
  });
}
ipcMain.handle(IPC.startExport, async (_e, project: Project, options: ExportOptions) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  exportQueue.push({ jobId, project, options });
  sendToWindow(IPC.exportProgress, { jobId, phase: 'queued', percent: 0, name: options.name, outputPath: options.outputPath } satisfies ExportProgress);
  pumpExports();
  return jobId;
});

ipcMain.handle(IPC.cancelExport, (_e, jobId: string) => {
  const i = exportQueue.findIndex((q) => q.jobId === jobId);
  if (i >= 0) {
    const [q] = exportQueue.splice(i, 1);
    sendToWindow(IPC.exportProgress, { jobId, phase: 'cancelled', percent: 0, name: q.options.name } satisfies ExportProgress);
    return;
  }
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
  if (UI_TEST) {
    const { runUiTest, waitForLoad } = await import('./uitest');
    await waitForLoad(mainWindow!);
    mainWindow!.show();
    const code = await runUiTest(mainWindow!);
    forceQuit = true; dirty = false;
    app.exit(code);
    return;
  }
  refreshMenu();
  applyRemoteSetting();
  { const st = loadSettings(); if (st.watchEnabled && st.watchFolder) startWatch(st.watchFolder); }
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
  stopTranslators();
  stopRemote();
  app.quit();
});
