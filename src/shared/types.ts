// Gemeinsame Typen für Hauptprozess und Oberfläche.

export type MediaType = 'video' | 'audio' | 'image';

export interface MediaInfo {
  duration: number;      // Sekunden (Bilder: 0)
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  rotation: number;      // Metadaten-Rotation in Grad
  is360: boolean;        // Equirectangular (2:1) erkannt
  fileSize: number;
}

export interface SpriteInfo {
  path: string;
  frames: number;
  frameWidth: number;
  frameHeight: number;
}

export type MediaStatus = 'analyzing' | 'processing' | 'ready' | 'error';

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  type: MediaType;
  info: MediaInfo;
  status: MediaStatus;
  error?: string;
  thumb?: string;          // Vorschaubild
  sprite?: SpriteInfo;     // Hover-Vorschau (Bildstreifen)
  proxy?: string;          // kleine Vorschau-Datei (Video)
  proxyReversed?: string;  // rückwärts laufende Vorschau-Datei
  waveform?: string;       // Wellenform-Bild (Audio)
  addedAt: number;
}

export interface Transform {
  x: number;        // Verschiebung in % der Projektbreite (-100..100)
  y: number;        // Verschiebung in % der Projekthöhe
  scale: number;    // 1 = 100 %
  rotation: number; // Grad
}

export interface ColorGrade {
  brightness: number;  // -1..1 (0 = neutral)
  contrast: number;    // 0..2 (1 = neutral)
  saturation: number;  // 0..3 (1 = neutral)
  hue: number;         // Grad -180..180
}

export type FitMode = 'contain' | 'cover' | 'stretch';

export interface Clip {
  id: string;
  trackId: string;
  mediaId: string;
  name: string;
  start: number;     // Position auf der Timeline (Sekunden)
  in: number;        // Startpunkt in der Quelle (Sekunden)
  out: number;       // Endpunkt in der Quelle (Sekunden)
  speed: number;     // 1 = normal, 0.5 = Zeitlupe, 4 = Zeitraffer
  reverse: boolean;
  volume: number;    // 0..2
  muted: boolean;
  fadeIn: number;    // Sekunden (Audio)
  fadeOut: number;
  opacity: number;   // 0..1
  fit: FitMode;
  transform: Transform;
  color: ColorGrade;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  background: string;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  settings: ProjectSettings;
  media: Record<string, MediaItem>;
  tracks: Track[];
  clips: Record<string, Clip>;
  createdAt: number;
  modifiedAt: number;
}

export interface ProjectFile {
  path: string;
  project: Project;
}

// ---------- Export ----------

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif';
export type ExportCodec = 'h264' | 'h265' | 'prores' | 'vp9' | 'gif';
export type ExportQuality = 'low' | 'medium' | 'high' | 'max';

export interface ExportOptions {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  format: ExportFormat;
  codec: ExportCodec;
  quality: ExportQuality;
  hardware: boolean;       // Hardware-Encoder verwenden, wenn verfügbar
  audioBitrate: number;    // kbit/s
  range?: { start: number; end: number };
}

export interface ExportProgress {
  jobId: string;
  phase: 'preparing' | 'rendering' | 'done' | 'error' | 'cancelled';
  percent: number;
  fps?: number;
  speed?: string;
  eta?: number;
  message?: string;
  outputPath?: string;
}

// ---------- Updates ----------

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
  downloadUrl?: string;   // Mac: Link zur neuen Version
  releaseNotes?: string;
}

export interface AppInfo {
  version: string;
  platform: 'darwin' | 'win32' | 'linux' | string;
  arch: string;
  userData: string;
  cacheDir: string;
  projectsDir: string;
  isPackaged: boolean;
}

export interface Settings {
  lastProject?: string;
  recentProjects: string[];
  proxyHeight: number;
  hardwareAccel: boolean;
  autosave: boolean;
  language: 'de';
}

export const DEFAULT_SETTINGS: Settings = {
  recentProjects: [],
  proxyHeight: 540,
  hardwareAccel: true,
  autosave: true,
  language: 'de',
};
