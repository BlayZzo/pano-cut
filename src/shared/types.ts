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

/** Wie ein 360°-Rohvideo zusammengesetzt werden muss. */
export type StitchMode = 'equirect' | 'dualfisheye-sbs' | 'dualfisheye-2streams';

export interface StitchSettings {
  mode: StitchMode;
  fov: number;        // Linsen-Sichtfeld in Grad (Dual-Fisheye), typ. 190–200
  yaw: number;        // Grund-Ausrichtung des Panoramas (Grad)
  pitch: number;
  roll: number;
}

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
  stitch?: StitchSettings; // nur 360°-Videos
  proxyStabilized?: string; // stabilisierte Vorschau-Datei (wird bei Bedarf erzeugt)
  hasAlpha?: boolean;      // Video mit Transparenz (freigestelltes Objekt, WebM/VP9)
  isObject?: boolean;      // gehört zur Objekt-Mediathek des Projekts
  addedAt: number;
}

/** 360°-Ansicht eines Clips (Reframing). */
export type PanoMode = 'flat' | 'equirect' | 'littleplanet';

export interface PanoKeyframe {
  t: number;      // Zeit innerhalb des Clips auf der Timeline (Sekunden)
  yaw: number;    // Grad, Blick nach links/rechts
  pitch: number;  // Grad, Blick nach oben/unten
  roll: number;   // Grad, Neigung
  fov: number;    // horizontales Sichtfeld in Grad
}

export interface PanoSettings {
  mode: PanoMode;
  keyframes: PanoKeyframe[];   // mindestens einer; nach t sortiert
  smooth: boolean;             // weiche Übergänge zwischen Keyframes
}

export type TransitionType =
  | 'fade' | 'fadeblack' | 'fadewhite' | 'dissolve'
  | 'wipeleft' | 'wiperight' | 'wipeup' | 'wipedown'
  | 'slideleft' | 'slideright' | 'slideup' | 'slidedown'
  | 'circleopen' | 'circleclose' | 'smoothleft' | 'smoothright'
  | 'zoomin' | 'pixelize' | 'radial' | 'hblur';

export interface Transition {
  type: TransitionType;
  duration: number;  // Sekunden
}

export type TitleAnimation = 'none' | 'fade' | 'slideup' | 'typewriter';

export interface TitleStyle {
  text: string;
  font: string;        // Schlüssel aus FONTS
  size: number;        // Prozent der Projekthöhe (z. B. 8)
  color: string;
  bold: boolean;
  align: 'left' | 'center' | 'right';
  x: number;           // Mittelpunkt in % der Breite (50 = Mitte)
  y: number;           // Mittelpunkt in % der Höhe
  background: string;  // Hintergrundfarbe oder '' für keine
  backgroundOpacity: number; // 0..1
  shadow: boolean;
  outline: boolean;
  animation: TitleAnimation;
}

export interface Stabilization {
  enabled: boolean;
  strength: number;   // 1..10 (Glättung)
  zoom: number;       // 0..30 % Zuschnitt zur Randvermeidung
}

export interface SubtitleSegment {
  id: string;
  start: number;   // Sekunden relativ zum Clip-Anfang (Timeline)
  end: number;
  text: string;
}

export type WhisperModel = 'base' | 'small';

// ---------- KI: Objekte erkennen, tracken, freistellen ----------

export interface TrackBox {
  t: number;   // Clip-lokale Zeit (Timeline-Sekunden)
  x: number;   // normiert 0..1 (relativ zum Quellbild)
  y: number;
  w: number;
  h: number;
}

export interface ObjectTrack {
  id: string;
  label: string;        // COCO-Klasse (englisch)
  labelDe: string;      // Anzeigename
  color: string;
  boxes: TrackBox[];    // nach t sortiert
  masks?: Array<{ t: number; path: string }>;  // Masken-PNGs (Alpha) pro Abtastzeit
  maskModel?: AiSegmentModel;
}

export interface Cutout {
  enabled: boolean;
  trackId: string;
  feather: number;   // Weichzeichnung des Maskenrands in Pixeln (0..40)
  grow: number;      // Maske vergrößern/verkleinern in Pixeln (-20..20)
  invert: boolean;   // Objekt entfernen statt freistellen
}

export interface ChromaKey {
  enabled: boolean;
  color: string;       // '#00ff00'
  similarity: number;  // 0.01..1
  blend: number;       // 0..1
  despill: boolean;
}

export interface Attachment {
  clipId: string;      // Clip, zu dem das getrackte Objekt gehört
  trackId: string;
  anchor: 'above' | 'center' | 'below';
  dx: number;          // zusätzlicher Versatz in % der Bildbreite/-höhe
  dy: number;
}

export type AiDetectModel = 'yolox-nano' | 'yolox-tiny' | 'yolox-s';
export type AiSegmentModel = 'u2netp' | 'u2net-human' | 'isnet';

export interface Detection {
  label: string;
  labelDe: string;
  score: number;
  x: number; y: number; w: number; h: number;  // normiert 0..1
}

export interface AiProgress {
  phase: 'download' | 'load' | 'run' | 'done' | 'error';
  percent: number;
  message?: string;
}

export interface ObjectAsset {
  id: string;
  name: string;
  path: string;        // WebM mit Alphakanal
  thumb?: string;
  duration: number;
  width: number;
  height: number;
  createdAt: number;
  sourceClip?: string;
}

export interface CloudSettings {
  type: 'webdav';
  url: string;         // z. B. https://cloud.example.de/remote.php/dav/files/NAME/PanoCut
  username: string;
  password: string;
}

export interface WhisperProgress {
  phase: 'download' | 'extract' | 'transcribe' | 'done' | 'error';
  percent: number;
  message?: string;
}

export interface TranscribeOptions {
  clipId: string;
  language: string;
  model: WhisperModel;
  maxChars: number;
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
  kind?: 'media' | 'title';     // undefined = Medien-Clip
  title?: TitleStyle;           // nur Titel-Clips
  pano?: PanoSettings;          // nur 360°-Clips
  transition?: Transition;      // Übergang VOM vorherigen Clip der Spur in diesen Clip
  stabilize?: Stabilization;
  subtitles?: { segments: SubtitleSegment[]; style: Omit<TitleStyle, 'text'>; enabled: boolean; attach?: Attachment };
  objects?: ObjectTrack[];      // erkannte/getrackte Objekte dieses Clips
  cutout?: Cutout;              // Freistellen anhand einer Objektmaske
  chroma?: ChromaKey;           // Green Screen
  attach?: Attachment;          // Titel-Clip an ein getracktes Objekt heften
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
  is360?: boolean;   // Projekt als 360°-Panorama (Equirectangular) exportieren
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
  maxSizeMB?: number;      // Ziel: Datei nicht größer als … (Bitrate wird berechnet)
  spherical?: boolean;     // 360°-Metadaten einfügen (YouTube/Facebook erkennen das Video als Panorama)
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
  cloud?: CloudSettings;
  aiDetectModel?: AiDetectModel;
  aiSegmentModel?: AiSegmentModel;
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
