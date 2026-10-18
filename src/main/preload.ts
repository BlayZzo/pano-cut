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
  prepareMedia: (item, options) => ipcRenderer.invoke(IPC.prepareMedia, item, options),
  onMediaUpdate: subscribe(IPC.mediaUpdate),

  newProjectDialog: () => ipcRenderer.invoke(IPC.newProjectDialog),
  saveProject: (project, p) => ipcRenderer.invoke(IPC.saveProject, project, p),
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  loadProject: (p) => ipcRenderer.invoke(IPC.loadProject, p),
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
};

contextBridge.exposeInMainWorld('panocut', api);
