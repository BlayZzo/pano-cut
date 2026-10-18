import { create } from 'zustand';
import type { AppInfo, ExportProgress, Settings, UpdateStatus } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

export interface DragState {
  kind: 'move' | 'trimStart' | 'trimEnd';
  clipIds: string[];
  dt: number;            // Zeitversatz (Sekunden)
  trackId?: string;      // Zielspur beim Verschieben
  copy?: boolean;
  valid: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

export type Dialog = 'none' | 'export' | 'settings' | 'newProject' | 'shortcuts' | 'about';

export interface UiState {
  appInfo: AppInfo | null;
  settings: Settings;
  selection: string[];
  playhead: number;
  playing: boolean;
  loop: boolean;
  zoom: number;           // Pixel pro Sekunde
  scrollX: number;
  snapping: boolean;
  drag: DragState | null;
  dialog: Dialog;
  rangeIn: number | null;
  rangeOut: number | null;
  toasts: Toast[];
  exportProgress: ExportProgress | null;
  updateStatus: UpdateStatus;
  libraryTab: 'media' | 'effects' | 'transitions' | 'titles';
  dirty: boolean;
  historyVersion: number;

  setAppInfo(info: AppInfo): void;
  setSettings(s: Settings): void;
  select(ids: string[]): void;
  toggleSelect(id: string): void;
  clearSelection(): void;
  setPlayhead(t: number): void;
  setPlaying(p: boolean): void;
  setLoop(l: boolean): void;
  setZoom(z: number): void;
  setScrollX(x: number): void;
  setSnapping(s: boolean): void;
  setDrag(d: DragState | null): void;
  openDialog(d: Dialog): void;
  setRange(inT: number | null, outT: number | null): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  setExportProgress(p: ExportProgress | null): void;
  setUpdateStatus(s: UpdateStatus): void;
  setLibraryTab(tab: UiState['libraryTab']): void;
  setDirty(d: boolean): void;
  bumpHistory(): void;
}

let toastId = 0;

export const useUi = create<UiState>()((set, get) => ({
  appInfo: null,
  settings: DEFAULT_SETTINGS,
  selection: [],
  playhead: 0,
  playing: false,
  loop: false,
  zoom: 60,
  scrollX: 0,
  snapping: true,
  drag: null,
  dialog: 'none',
  rangeIn: null,
  rangeOut: null,
  toasts: [],
  exportProgress: null,
  updateStatus: { state: 'idle' },
  libraryTab: 'media',
  dirty: false,
  historyVersion: 0,

  setAppInfo: (appInfo) => set({ appInfo }),
  setSettings: (settings) => set({ settings }),
  select: (ids) => set({ selection: ids }),
  toggleSelect: (id) => set((s) => ({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] })),
  clearSelection: () => set({ selection: [] }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setLoop: (loop) => set({ loop }),
  setZoom: (zoom) => set({ zoom: Math.min(2000, Math.max(4, zoom)) }),
  setScrollX: (scrollX) => set({ scrollX: Math.max(0, scrollX) }),
  setSnapping: (snapping) => set({ snapping }),
  setDrag: (drag) => set({ drag }),
  openDialog: (dialog) => set({ dialog }),
  setRange: (rangeIn, rangeOut) => set({ rangeIn, rangeOut }),
  toast: (text, kind = 'info') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setExportProgress: (exportProgress) => set({ exportProgress }),
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setLibraryTab: (libraryTab) => set({ libraryTab }),
  setDirty: (dirty) => set({ dirty }),
  bumpHistory: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),
}));
