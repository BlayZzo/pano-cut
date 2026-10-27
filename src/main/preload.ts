import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type PanoCutApi } from '@shared/ipc';

const MEDIA_SCHEME = 'pcmedia';

function toMediaUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${MEDIA_SCHEME}://local/${encoded.replace(/^\//, '')}`;
}

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const api: PanoCutApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  showInFolder: (p) => ipcRenderer.invoke(IPC.showInFolder, p),
  importToPhotos: (p) => ipcRenderer.invoke(IPC.importToPhotos, p),
  uninstall: () => ipcRenderer.invoke(IPC.uninstall),
  quitApp: () => ipcRenderer.send(IPC.quitApp),
  toMediaUrl,
  getPathForFile: (file) => webUtils.getPathForFile(file),

  selectMediaFiles: () => ipcRenderer.invoke(IPC.selectMediaFiles),
  importMedia: (paths) => ipcRenderer.invoke(IPC.importMedia, paths),
  expandMediaPaths: (paths) => ipcRenderer.invoke(IPC.expandMediaPaths, paths),
  stitchAutoAlign: (item) => ipcRenderer.invoke(IPC.stitchAutoAlign, item),
  imuBuild: (item) => ipcRenderer.invoke(IPC.imuBuild, item),
  imuRead: (file) => ipcRenderer.invoke(IPC.imuRead, file),
  maskEditFrame: (item, t) => ipcRenderer.invoke(IPC.maskEditFrame, item, t),
  maskSegment: (item, t, prompt) => ipcRenderer.invoke(IPC.maskSegment, item, t, prompt),
  maskTrack: (req) => ipcRenderer.invoke(IPC.maskTrack, req),
  maskTrackCancel: () => ipcRenderer.invoke(IPC.maskTrackCancel),
  maskRead: (file, w, h) => ipcRenderer.invoke(IPC.maskRead, file, w, h),
  onMaskTrackProgress: subscribe(IPC.maskTrackProgress),
  seamBuild: (item) => ipcRenderer.invoke(IPC.seamBuild, item),
  seamRead: (file) => ipcRenderer.invoke(IPC.seamRead, file),
  onSeamProgress: subscribe(IPC.seamProgress),
  onImuProgress: subscribe(IPC.imuProgress),
  activityCurve: (p, s, d, dense) => ipcRenderer.invoke(IPC.activityCurve, p, s, d, dense),
  mediaTimes: (p) => ipcRenderer.invoke(IPC.mediaTimes, p),
  prepareMedia: (item, options) => ipcRenderer.invoke(IPC.prepareMedia, item, options),
  onMediaUpdate: subscribe(IPC.mediaUpdate),
  prepReorder: (ids) => ipcRenderer.invoke(IPC.prepReorder, ids),
  prepSkip: (id) => ipcRenderer.invoke(IPC.prepSkip, id),
  prepQueueGet: () => ipcRenderer.invoke(IPC.prepQueueGet),
  onPrepQueue: subscribe(IPC.prepQueue),

  whisperStatus: () => ipcRenderer.invoke(IPC.whisperStatus),
  downloadWhisperModel: (m) => ipcRenderer.invoke(IPC.downloadWhisperModel, m),
  translateLocal: (texts, from, to) => ipcRenderer.invoke(IPC.translateLocal, texts, from, to),
  transcribe: (req) => ipcRenderer.invoke(IPC.transcribe, req),
  cancelTranscribe: () => ipcRenderer.invoke(IPC.cancelTranscribe),
  translateTexts: (texts, source, target) => ipcRenderer.invoke(IPC.translateTexts, texts, source, target),
  readTextFile: (p) => ipcRenderer.invoke(IPC.readTextFile, p),
  selectFile: (title, ext) => ipcRenderer.invoke(IPC.selectFile, title, ext),
  onWhisperProgress: subscribe(IPC.whisperProgress),

  aiStatus: () => ipcRenderer.invoke(IPC.aiStatus),
  aiDetect: (frame, model, minScore) => ipcRenderer.invoke(IPC.aiDetect, frame, model, minScore),
  aiSegment: (frame, model, box) => ipcRenderer.invoke(IPC.aiSegment, frame, model, box),
  aiSaveMask: (mediaPath, trackId, index, png) => ipcRenderer.invoke(IPC.aiSaveMask, mediaPath, trackId, index, png),
  aiCancel: () => ipcRenderer.invoke(IPC.aiCancel),
  onAiProgress: subscribe(IPC.aiProgress),
  renderObject: (req) => ipcRenderer.invoke(IPC.renderObject, req),
  vfxBegin: (req) => ipcRenderer.invoke(IPC.vfxBegin, req),
  vfxFrame: (jobId, rgba) => ipcRenderer.invoke(IPC.vfxFrame, jobId, rgba),
  vfxEnd: (jobId) => ipcRenderer.invoke(IPC.vfxEnd, jobId),
  vfxCancel: (jobId) => ipcRenderer.invoke(IPC.vfxCancel, jobId),
  analyzeBeats: (p) => ipcRenderer.invoke(IPC.analyzeBeats, p),
  renderSfx: (id, params) => ipcRenderer.invoke(IPC.renderSfx, id, params),
  setWatchFolder: (dir) => ipcRenderer.invoke(IPC.setWatchFolder, dir),
  onWatchNew: subscribe(IPC.watchNew),
  selectFolder: (title) => ipcRenderer.invoke(IPC.selectFolder, title),
  storageInfo: () => ipcRenderer.invoke(IPC.storageInfo),
  cleanStorage: (mode, keep) => ipcRenderer.invoke(IPC.cleanStorage, mode, keep),
  motionCurve: (p, s, d) => ipcRenderer.invoke(IPC.motionCurve, p, s, d),
  silences: (p, s, d, th, md) => ipcRenderer.invoke(IPC.silences, p, s, d, th, md),
  blurCurve: (p, s, d) => ipcRenderer.invoke(IPC.blurCurve, p, s, d),
  audioEnvelope: (p, start, duration) => ipcRenderer.invoke(IPC.audioEnvelope, p, start, duration),

  cloudTest: (s) => ipcRenderer.invoke(IPC.cloudTest, s),
  cloudList: (s, dir) => ipcRenderer.invoke(IPC.cloudList, s, dir),
  cloudUpload: (s, l, r) => ipcRenderer.invoke(IPC.cloudUpload, s, l, r),
  cloudDownload: (s, r, l) => ipcRenderer.invoke(IPC.cloudDownload, s, r, l),
  onCloudProgress: subscribe(IPC.cloudProgress),
  readJsonFile: (p) => ipcRenderer.invoke(IPC.readJsonFile, p),
  writeJsonFile: (p, data) => ipcRenderer.invoke(IPC.writeJsonFile, p, data),

  newProjectDialog: () => ipcRenderer.invoke(IPC.newProjectDialog),
  saveProject: (project, p) => ipcRenderer.invoke(IPC.saveProject, project, p),
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  loadProject: (p) => ipcRenderer.invoke(IPC.loadProject, p),
  takePendingProject: () => ipcRenderer.invoke(IPC.takePendingProject),
  recentProjects: () => ipcRenderer.invoke(IPC.recentProjects),
  onMenuAction: subscribe(IPC.menuAction),
  setDirty: (d) => ipcRenderer.send(IPC.setDirty, d),

  selectExportPath: (name, ext) => ipcRenderer.invoke(IPC.selectExportPath, name, ext),
  startExport: (project, options) => ipcRenderer.invoke(IPC.startExport, project, options),
  cancelExport: (jobId) => ipcRenderer.invoke(IPC.cancelExport, jobId),
  onExportProgress: subscribe(IPC.exportProgress),

  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  onUpdateStatus: subscribe(IPC.updateStatus),
  testMode: process.argv.includes('--pc-ui-test'),
};

contextBridge.exposeInMainWorld('panocut', api);
