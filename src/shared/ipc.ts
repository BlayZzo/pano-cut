import type { AppInfo, ExportOptions, ExportProgress, MediaItem, Project, ProjectFile, Settings, SubtitleSegment, UpdateStatus, WhisperModel, WhisperProgress } from './types';

/** Die API, die das Preload-Skript der Oberfläche als `window.panocut` bereitstellt. */
export interface PanoCutApi {
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
  prepareMedia(item: MediaItem, options?: { reversed?: boolean; stabilized?: number }): Promise<void>;
  onMediaUpdate(cb: (item: MediaItem) => void): () => void;

  // Untertitel
  whisperStatus(): Promise<{ available: boolean; models: Record<WhisperModel, boolean> }>;
  downloadWhisperModel(model: WhisperModel): Promise<void>;
  transcribe(req: { mediaPath: string; start: number; duration: number; language: string; model: WhisperModel; maxChars: number }): Promise<SubtitleSegment[]>;
  cancelTranscribe(): Promise<void>;
  onWhisperProgress(cb: (p: WhisperProgress) => void): () => void;

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
  prepareMedia: 'media:prepare',
  mediaUpdate: 'media:update',

  newProjectDialog: 'project:newDialog',
  saveProject: 'project:save',
  openProject: 'project:open',
  loadProject: 'project:load',
  menuAction: 'menu:action',

  whisperStatus: 'subs:status',
  downloadWhisperModel: 'subs:download',
  transcribe: 'subs:transcribe',
  cancelTranscribe: 'subs:cancel',
  whisperProgress: 'subs:progress',

  selectExportPath: 'export:selectPath',
  startExport: 'export:start',
  cancelExport: 'export:cancel',
  exportProgress: 'export:progress',

  checkForUpdates: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  updateStatus: 'update:status',
} as const;
