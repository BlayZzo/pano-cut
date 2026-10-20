import type { BeatInfo } from './beats';
import type { AiDetectModel, AiProgress, AiSegmentModel, AppInfo, CloudSettings, Detection, ExportOptions, ExportProgress, MediaItem, Model3DSpec, Project, ProjectFile, Settings, SubtitleSegment, UpdateStatus, VfxSpec, WhisperModel, WhisperProgress } from './types';

export interface FramePayload { data: Uint8Array; width: number; height: number }
export interface MaskPayload { width: number; height: number; alpha: Uint8Array }
export interface PrepQueueEntry { id: string; stage: 'quick' | 'heavy'; running: boolean }
export interface CloudEntry { name: string; path: string; size: number; isDir: boolean; modified?: string }

/** Die API, die das Preload-Skript der Oberfläche als `window.panocut` bereitstellt. */
export interface PanoCutApi {
  /** Nur im automatischen Oberflächen-Test gesetzt. */
  testMode?: boolean;
  // App
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  openExternal(url: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  importToPhotos(path: string): Promise<{ ok: boolean; message?: string }>;
  uninstall(): Promise<void>;
  quitApp(): void;
  toMediaUrl(path: string): string;
  getPathForFile(file: File): string;

  // Medien
  selectMediaFiles(): Promise<string[]>;
  importMedia(paths: string[]): Promise<MediaItem[]>;
  /** Ordner durch die darin enthaltenen Medien-Dateien ersetzen (Kamera-Vorschaudateien mit Hauptvideo fallen weg). */
  expandMediaPaths(paths: string[]): Promise<string[]>;
  prepareMedia(item: MediaItem, options?: { reversed?: boolean; stabilized?: number }): Promise<void>;
  onMediaUpdate(cb: (item: MediaItem) => void): () => void;
  /** Vorbereitungs-Warteschlange: Reihenfolge ändern, überspringen, beobachten */
  prepReorder(ids: string[]): Promise<void>;
  prepSkip(id: string): Promise<void>;
  prepQueueGet(): Promise<PrepQueueEntry[]>;
  onPrepQueue(cb: (q: PrepQueueEntry[]) => void): () => void;

  // Untertitel
  whisperStatus(): Promise<{ available: boolean; models: Record<WhisperModel, boolean> }>;
  downloadWhisperModel(model: WhisperModel): Promise<void>;
  transcribe(req: { mediaPath: string; start: number; duration: number; language: string; model: WhisperModel; maxChars: number; translate?: boolean }): Promise<{ segments: SubtitleSegment[]; language: string }>;
  /** Lokale Übersetzung Deutsch ↔ Englisch (Fortschritt über onWhisperProgress). */
  translateLocal(texts: string[], from: 'de' | 'en', to: 'de' | 'en'): Promise<string[]>;
  translateTexts(texts: string[], source: string, target: string): Promise<string[]>;
  readTextFile(path: string): Promise<string | null>;
  selectFile(title: string, extensions: string[]): Promise<string | null>;
  cancelTranscribe(): Promise<void>;
  onWhisperProgress(cb: (p: WhisperProgress) => void): () => void;

  // KI (Erkennen, Tracken, Freistellen)
  aiStatus(): Promise<{ available: boolean; models: Record<string, boolean> }>;
  aiDetect(frame: FramePayload, model: AiDetectModel, minScore?: number): Promise<Detection[]>;
  aiSegment(frame: FramePayload, model: AiSegmentModel, box: { x: number; y: number; w: number; h: number } | null): Promise<MaskPayload>;
  aiSaveMask(mediaPath: string, trackId: string, index: number | string, png: Uint8Array): Promise<string>;
  aiCancel(): Promise<void>;
  onAiProgress(cb: (p: AiProgress) => void): () => void;
  renderObject(req: { project: Project; clipId: string; trackId: string; name: string }): Promise<MediaItem>;

  // Effekt-Simulationen: Bilder aus der Oberfläche → Video
  vfxBegin(req: { projectId: string; spec?: VfxSpec; model?: Model3DSpec; fps?: number; role: 'effect' | 'light'; width: number; height: number; mediaId?: string; name?: string }): Promise<string>;
  vfxFrame(jobId: string, rgba: Uint8Array): Promise<void>;
  vfxEnd(jobId: string): Promise<MediaItem>;
  vfxCancel(jobId: string): Promise<void>;

  // Analysen (Hook-Finder, Grobschnitt) – nur auf Knopfdruck
  motionCurve(path: string, start: number, duration: number): Promise<{ values: number[]; hop: number }>;
  silences(path: string, start: number, duration: number, thresholdDb?: number, minDur?: number): Promise<Array<{ start: number; end: number }>>;
  blurCurve(path: string, start: number, duration: number): Promise<{ values: number[]; hop: number }>;

  // Ordner beobachten & Speicher
  setWatchFolder(dir: string | null): Promise<{ ok: boolean; message?: string }>;
  onWatchNew(cb: (files: string[]) => void): () => void;
  selectFolder(title: string): Promise<string | null>;
  storageInfo(): Promise<import('./types').StorageInfo>;
  cleanStorage(mode: 'old' | 'unused' | 'all', keepMediaPaths: string[]): Promise<{ freedBytes: number }>;

  // Sound-Effekte
  renderSfx(id: string, params: Partial<import('./sfx').SfxParams>): Promise<string>;

  // Ton-Analyse: Takt (Auto-Musik-Schnitt), Hüllkurve (Mehrkamera-Sync)
  analyzeBeats(path: string): Promise<BeatInfo>;
  audioEnvelope(path: string, start?: number, duration?: number): Promise<{ env: number[]; hop: number }>;

  // Cloud (WebDAV)
  cloudTest(settings: CloudSettings): Promise<{ ok: boolean; message?: string }>;
  cloudList(settings: CloudSettings, dir: string): Promise<CloudEntry[]>;
  cloudUpload(settings: CloudSettings, localPath: string, remotePath: string): Promise<void>;
  cloudDownload(settings: CloudSettings, remotePath: string, localPath: string): Promise<void>;
  onCloudProgress(cb: (p: { percent: number; message?: string }) => void): () => void;
  readJsonFile<T>(path: string): Promise<T | null>;
  writeJsonFile(path: string, data: unknown): Promise<string>;

  // Projekt
  newProjectDialog(): Promise<boolean>;
  saveProject(project: Project, path?: string): Promise<string | null>;
  openProject(): Promise<ProjectFile | null>;
  loadProject(path: string): Promise<ProjectFile | null>;
  onMenuAction(cb: (action: string) => void): () => void;
  setDirty(dirty: boolean): void;

  // Export
  selectExportPath(defaultName: string, ext: string): Promise<string | null>;
  startExport(project: Project, options: ExportOptions): Promise<string>;
  cancelExport(jobId: string): Promise<void>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;

  // Updates
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
}

export const IPC = {
  getAppInfo: 'app:info',
  getSettings: 'app:getSettings',
  setSettings: 'app:setSettings',
  openExternal: 'app:openExternal',
  showInFolder: 'app:showInFolder',
  importToPhotos: 'app:importToPhotos',
  uninstall: 'app:uninstall',
  setDirty: 'app:setDirty',
  quitApp: 'app:quit',

  selectMediaFiles: 'media:select',
  importMedia: 'media:import',
  expandMediaPaths: 'media:expand',
  prepareMedia: 'media:prepare',
  mediaUpdate: 'media:update',
  prepQueue: 'media:prepQueue',
  prepReorder: 'media:prepReorder',
  prepSkip: 'media:prepSkip',
  prepQueueGet: 'media:prepQueueGet',

  newProjectDialog: 'project:newDialog',
  saveProject: 'project:save',
  openProject: 'project:open',
  loadProject: 'project:load',
  menuAction: 'menu:action',

  whisperStatus: 'subs:status',
  downloadWhisperModel: 'subs:download',
  transcribe: 'subs:transcribe',
  translateLocal: 'subs:translateLocal',
  cancelTranscribe: 'subs:cancel',
  translateTexts: 'subs:translate',
  readTextFile: 'fs:readText',
  selectFile: 'fs:selectFile',
  whisperProgress: 'subs:progress',

  aiStatus: 'ai:status',
  aiDetect: 'ai:detect',
  aiSegment: 'ai:segment',
  aiSaveMask: 'ai:saveMask',
  aiCancel: 'ai:cancel',
  aiProgress: 'ai:progress',
  renderObject: 'ai:renderObject',
  vfxBegin: 'vfx:begin',
  vfxFrame: 'vfx:frame',
  vfxEnd: 'vfx:end',
  vfxCancel: 'vfx:cancel',
  analyzeBeats: 'audio:beats',
  renderSfx: 'sfx:render',
  setWatchFolder: 'watch:set',
  watchNew: 'watch:new',
  selectFolder: 'fs:selectFolder',
  storageInfo: 'storage:info',
  cleanStorage: 'storage:clean',
  motionCurve: 'an:motion',
  silences: 'an:silences',
  blurCurve: 'an:blur',
  audioEnvelope: 'audio:envelope',

  cloudTest: 'cloud:test',
  cloudList: 'cloud:list',
  cloudUpload: 'cloud:upload',
  cloudDownload: 'cloud:download',
  cloudProgress: 'cloud:progress',
  readJsonFile: 'fs:readJson',
  writeJsonFile: 'fs:writeJson',

  selectExportPath: 'export:selectPath',
  startExport: 'export:start',
  cancelExport: 'export:cancel',
  exportProgress: 'export:progress',

  checkForUpdates: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  updateStatus: 'update:status',
} as const;
