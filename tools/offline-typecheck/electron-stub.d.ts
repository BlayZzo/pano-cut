// Minimaler Electron-Typ-Stub nur für die lokale Typprüfung (die CI nutzt die echten Typen).
declare namespace Electron {
  interface IpcRendererEvent { sender: unknown }
  interface IpcMainInvokeEvent { sender: unknown }
  interface IpcMainEvent { sender: unknown }
  interface MenuItemConstructorOptions {
    label?: string; role?: string; type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
    accelerator?: string; click?: (...args: any[]) => void; submenu?: MenuItemConstructorOptions[] | Menu; enabled?: boolean; visible?: boolean;
  }
  class Menu { static setApplicationMenu(m: Menu | null): void; static buildFromTemplate(t: MenuItemConstructorOptions[]): Menu; }
  class NativeImage {}
  interface Stats {}
}
declare module 'electron' {
  export type IpcRendererEvent = Electron.IpcRendererEvent;
  export type IpcMainInvokeEvent = Electron.IpcMainInvokeEvent;
  export type MenuItemConstructorOptions = Electron.MenuItemConstructorOptions;
  export const Menu: typeof Electron.Menu;
  export type Menu = Electron.Menu;
  export const app: {
    getPath(name: string): string; getVersion(): string; getName(): string; setName(n: string): void; isPackaged: boolean;
    quit(): void; exit(code?: number): void; whenReady(): Promise<void>; on(ev: string, cb: (...a: any[]) => void): void;
    requestSingleInstanceLock(): boolean; setAppUserModelId(id: string): void; getAppPath(): string;
  };
  export class BrowserWindow {
    constructor(opts?: any);
    static getAllWindows(): BrowserWindow[];
    webContents: { send(ch: string, ...args: any[]): void; openDevTools(o?: any): void; setWindowOpenHandler(h: (d: { url: string }) => any): void; capturePage(r?: any): Promise<NativeImage>; isLoading(): boolean; once(ev: string, fn: (...a: any[]) => void): void; on(ev: string, fn: (...a: any[]) => void): void; executeJavaScript(code: string): Promise<any> };
    once(ev: string, cb: (...a: any[]) => void): void;
    on(ev: string, cb: (...a: any[]) => void): void;
    loadURL(u: string): Promise<void>;
    loadFile(f: string): Promise<void>;
    show(): void; close(): void; focus(): void; isMinimized(): boolean; restore(): void;
    setDocumentEdited(d: boolean): void; setRepresentedFilename(f: string): void;
  }
  export const dialog: {
    showOpenDialog(w: BrowserWindow, o: any): Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog(w: BrowserWindow, o: any): Promise<{ canceled: boolean; filePath?: string }>;
    showMessageBox(w: BrowserWindow, o: any): Promise<{ response: number }>;
    showMessageBoxSync(w: BrowserWindow, o: any): number;
    showErrorBox(title: string, content: string): void;
  };
  export const ipcMain: {
    handle(ch: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void;
    on(ch: string, fn: (e: Electron.IpcMainEvent, ...args: any[]) => void): void;
  };
  export const ipcRenderer: {
    invoke(ch: string, ...args: any[]): Promise<any>;
    send(ch: string, ...args: any[]): void;
    on(ch: string, fn: (e: Electron.IpcRendererEvent, ...args: any[]) => void): void;
    removeListener(ch: string, fn: (...a: any[]) => void): void;
  };
  export const contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  export const webUtils: { getPathForFile(f: File): string };
  export const shell: {
    openExternal(u: string): Promise<void>; showItemInFolder(p: string): void; openPath(p: string): Promise<string>; trashItem(p: string): Promise<void>;
  };
  export const nativeImage: { createFromPath(p: string): Electron.NativeImage };
  export const protocol: {
    registerSchemesAsPrivileged(s: Array<{ scheme: string; privileges: any }>): void;
    handle(scheme: string, handler: (req: Request) => Promise<Response> | Response): void;
  };
  export const net: { fetch(url: string, init?: any): Promise<Response> };
}
declare namespace NodeJS { interface Process { resourcesPath: string } }
declare module 'electron-log' {
  const log: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; debug(...a: any[]): void; transports: { file: { level: string } }; initialize(): void };
  export default log;
}
declare module 'electron-updater' {
  export const autoUpdater: {
    logger: unknown; autoDownload: boolean; autoInstallOnAppQuit: boolean;
    on(ev: string, cb: (...a: any[]) => void): void;
    checkForUpdates(): Promise<unknown>; downloadUpdate(): Promise<unknown>; quitAndInstall(a?: boolean, b?: boolean): void;
  };
}
declare module 'vite/client' {}
declare module '*.svg' { const src: string; export default src; }
declare module '*.png' { const src: string; export default src; }
declare module '*.css' {}
declare module 'onnxruntime-node' {
  export class Tensor { constructor(type: string, data: Float32Array | Uint8Array | number[], dims: number[]); data: Float32Array | Uint8Array; dims: readonly number[]; type: string; }
  export namespace InferenceSession {
    type SessionOptions = { executionProviders?: unknown; graphOptimizationLevel?: string };
    type OnnxValueMapType = { [name: string]: Tensor };
  }
  export class InferenceSession {
    static create(path: string, options?: InferenceSession.SessionOptions): Promise<InferenceSession>;
    run(feeds: { [name: string]: Tensor }): Promise<{ [name: string]: Tensor }>;
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
  }
}
