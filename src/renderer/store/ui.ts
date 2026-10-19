import { create } from 'zustand';
import type { AppInfo, ExportProgress, Settings, UpdateStatus, ViewSettings } from '@shared/types';
import { DEFAULT_SETTINGS, DEFAULT_VIEW } from '@shared/types';

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
  libraryTab: 'media' | 'effects' | 'transitions' | 'titles' | 'objects';
  aiPanel: boolean;
  aiBusy: { percent: number; message: string } | null;
  pickColor: boolean;   // Green-Screen-Farbe in der Vorschau wählen
  vfxPanel: boolean;    // Effekt-Studio offen
  imagePanel: boolean;  // Bild-Assistent offen
  vfxPreset: string | null;  // vorgewählte Effektart (aus der Bibliothek)
  maskBrush: { clipId: string; trackId: string; size: number; all: boolean } | null;  // Masken-Pinsel aktiv
  showBeats: boolean;   // Taktmarken in der Timeline
  multicamPanel: string | null;  // geöffnete Mehrkamera-Gruppe
  modelPanel: { file?: string; mediaId?: string } | null;  // 3D-Objekt-Fenster (neue Datei oder bestehendes Modell)
  beatJobs: string[];   // Medien-IDs, deren Takt gerade erkannt wird
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
  setAiPanel(open: boolean): void;
  setAiBusy(b: UiState['aiBusy']): void;
  setPickColor(p: boolean): void;
  setVfxPanel(open: boolean, preset?: string | null): void;
  setImagePanel(open: boolean): void;
  setMaskBrush(b: UiState['maskBrush']): void;
  setShowBeats(v: boolean): void;
  setMulticamPanel(id: string | null): void;
  setModelPanel(p: UiState['modelPanel']): void;
  setBeatJob(mediaId: string, busy: boolean): void;
  setDirty(d: boolean): void;
  bumpHistory(): void;
}

/** Timeline-Zoom in Pixel pro Sekunde: 0,2 = gut 2 Stunden auf einem Bildschirm, 2000 = einzelne Bilder. */
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 2000;

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
  aiPanel: false,
  aiBusy: null,
  pickColor: false,
  vfxPanel: false,
  imagePanel: false,
  vfxPreset: null,
  maskBrush: null,
  showBeats: true,
  multicamPanel: null,
  modelPanel: null,
  beatJobs: [],
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
  setZoom: (zoom) => set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) }),
  setScrollX: (scrollX) => set({ scrollX: Math.max(0, scrollX) }),
  setSnapping: (snapping) => set({ snapping }),
  setDrag: (drag) => set({ drag }),
  openDialog: (dialog) => set({ dialog }),
  setRange: (rangeIn, rangeOut) => set({ rangeIn, rangeOut }),
  toast: (text, kind = 'info') => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => get().dismissToast(id), Math.max(kind === 'error' ? 8000 : 3500, text.length * 55));
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setExportProgress: (exportProgress) => set({ exportProgress }),
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setLibraryTab: (libraryTab) => set({ libraryTab }),
  setAiPanel: (aiPanel) => set({ aiPanel }),
  setAiBusy: (aiBusy) => set({ aiBusy }),
  setPickColor: (pickColor) => set({ pickColor }),
  setVfxPanel: (vfxPanel, preset) => set({ vfxPanel, vfxPreset: preset ?? null }),
  setImagePanel: (imagePanel) => set({ imagePanel }),
  setMaskBrush: (maskBrush) => set({ maskBrush }),
  setShowBeats: (showBeats) => set({ showBeats }),
  setMulticamPanel: (multicamPanel) => set({ multicamPanel }),
  setModelPanel: (modelPanel) => set(modelPanel ? { modelPanel, vfxPanel: false, imagePanel: false } : { modelPanel }),
  setBeatJob: (id, busy) => set((s) => ({ beatJobs: busy ? [...s.beatJobs.filter((x) => x !== id), id] : s.beatJobs.filter((x) => x !== id) })),
  setDirty: (dirty) => set({ dirty }),
  bumpHistory: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),
}));

/**
 * Abspielkopf für Bedienfelder: im Stillstand genau, während der Wiedergabe nur in groben Schritten
 * (`step` Sekunden). So zeichnen sich Inspektor & Co. nicht 30-mal pro Sekunde neu – die Vorschau bleibt flüssig.
 */
export function usePlayheadCoarse(step = 0.5, live = false): number {
  return useUi((s) => (s.playing && !live ? Math.floor(s.playhead / step) * step : s.playhead));
}

/** Ansicht-Einstellungen mit Standardwerten. */
export function useView(): ViewSettings {
  const v = useUi((s) => s.settings.view);
  return { ...DEFAULT_VIEW, ...v };
}
export function getView(): ViewSettings {
  return { ...DEFAULT_VIEW, ...useUi.getState().settings.view };
}
/** Ansicht ändern (sofort sichtbar, gespeichert). `persist: false` z. B. während eines Ziehvorgangs. */
export function updateView(patch: Partial<ViewSettings>, persist = true): void {
  const st = useUi.getState();
  const view = { ...st.settings.view, ...patch };
  st.setSettings({ ...st.settings, view });
  if (persist) void window.panocut.setSettings({ view });
}
