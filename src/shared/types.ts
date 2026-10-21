// Gemeinsame Typen für Hauptprozess und Oberfläche.
import type { BeatInfo } from './beats';

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
  pixFmt?: string;       // z. B. yuv420p (8 Bit) oder yuv420p10le (10 Bit)
  recordedAt?: number;   // Beginn der Aufnahme (ms, aus Metadaten bzw. Dateiname)
  recordedEnd?: number;  // Ende der Aufnahme (ms, Änderungszeit der Datei)
  timelapseFactor?: number; // aus der Kamera bekannt (Insta360-Zeitstempel je Bild)
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
  /** Weiche Naht (Grad, 0 = hart). Fehlt = hart (ältere Projekte). */
  blend?: number;
  /** Je Linse: Bildkreis, Drehkorrektur, Farbe (siehe shared/stitchModel.ts). [0] = hinten/links, [1] = vorne/rechts */
  lens?: [Partial<LensCalSettings>, Partial<LensCalSettings>];
  /** Aus den Kameradaten übernommen (Anzeige) */
  calibrated?: 'camera' | 'auto' | 'camera+auto';
}

export interface LensCalSettings {
  dx: number; dy: number; r: number; yaw: number; pitch: number; roll: number; gain: [number, number, number];
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
  companion?: string;      // Kamera-Vorschaudatei (DJI .LRF, GoPro/Insta360 .LRV), dient als Vorschau-Datei
  companionSwap?: boolean;
  proxyStitchKey?: string;
  seam?: { file: string; rate: number; start: number; frames: number; key: string; enabled: boolean };  // bewegte Naht (Versatz naher Dinge), gilt für stitchKey = key
  imu?: { file: string; rate: number; start: number; score: number; model: string };  // eingemessene Bewegungsdaten (Lage-Spur) // 360°: mit welchen Zusammensetz-Einstellungen die Vorschau-Datei erstellt wurde // 360°: Linsen in der Kamera-Vorschaudatei andersherum als im Original
  proxyReversed?: string;  // rückwärts laufende Vorschau-Datei
  waveform?: string;       // Wellenform-Bild (Audio)
  stitch?: StitchSettings; // nur 360°-Videos
  proxyStabilized?: string; // stabilisierte Vorschau-Datei (wird bei Bedarf erzeugt)
  hasAlpha?: boolean;      // Video mit Transparenz (freigestelltes Objekt, WebM/VP9)
  isObject?: boolean;      // gehört zur Objekt-Mediathek des Projekts
  vfx?: VfxSpec;           // erzeugter Effekt (kann neu gerendert werden)
  vfxRole?: 'effect' | 'light';  // Effekt selbst oder sein Lichtschein
  beats?: BeatInfo;        // erkannter Takt (Auto-Musik-Schnitt)
  bbox?: { x: number; y: number; w: number; h: number };  // freigestelltes Objekt: typische Lage im Bild (0..1)
  model3d?: Model3DSpec;   // gerendertes 3D-Modell (kann neu gerendert werden)
  prep?: MediaPrep;        // laufende Vorbereitung (nur zur Anzeige, wird nicht gespeichert)
  addedAt: number;
}

/** Fortschritt der Vorbereitung einer Datei (Vorschaubilder, Vorschau-Datei, 360°-Zusammensetzen). */
export interface MediaPrep {
  stage: 'waiting' | 'thumbs' | 'proxy' | 'stitch' | 'wave';
  percent: number;        // 0..100
  etaSec?: number;        // geschätzte Restzeit
  startedAt?: number;
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
  ease?: MoveEase;             // Art der Fahrt (fehlt = smooth ? 'smooth' : 'linear')
}

/** Wie eine Kamerafahrt zwischen zwei Markierungen beschleunigt. */
export type MoveEase = 'smooth' | 'linear' | 'in' | 'out';

/** Ausschnitt-Fahrt für normale Videos/Bilder (Zoomen und Schwenken aus dem vollen Bild – ohne Qualitätsverlust). */
export interface ReframeKeyframe {
  t: number;      // Zeit im Clip (Timeline-Sekunden ab Clip-Anfang)
  zoom: number;   // 1 = ganzes Bild (füllend), 2 = halb so großer Ausschnitt
  x: number;      // Lage des Ausschnitts 0 = ganz links … 1 = ganz rechts
  y: number;      // 0 = ganz oben … 1 = ganz unten
}
export interface ReframeSettings {
  keyframes: ReframeKeyframe[];  // nach t sortiert, mindestens einer
  ease: MoveEase;
}

export type TransitionType =
  | 'fade' | 'fadeblack' | 'fadewhite' | 'dissolve'
  | 'wipeleft' | 'wiperight' | 'wipeup' | 'wipedown'
  | 'slideleft' | 'slideright' | 'slideup' | 'slidedown'
  | 'circleopen' | 'circleclose' | 'smoothleft' | 'smoothright'
  | 'zoomin' | 'pixelize' | 'radial' | 'hblur'
  // dynamisch (mit Stärke): shared/transitions.ts
  | 'zoomthrough' | 'whipleft' | 'whipright' | 'whipup' | 'whipdown' | 'spin' | 'flash' | 'shake' | 'glitch'
  | 'blurdissolve' | 'punchin' | 'rollleft' | 'rollright'
  // weitere FFmpeg-xfade-Arten (ab FFmpeg 6.1)
  | 'smoothup' | 'smoothdown' | 'vertopen' | 'vertclose' | 'horzopen' | 'horzclose'
  | 'diagtl' | 'diagtr' | 'diagbl' | 'diagbr' | 'wipetl' | 'wipetr' | 'wipebl' | 'wipebr'
  | 'hlslice' | 'hrslice' | 'vuslice' | 'vdslice' | 'squeezeh' | 'squeezev' | 'fadegrays' | 'fadefast' | 'fadeslow'
  | 'coverleft' | 'coverright' | 'coverup' | 'coverdown' | 'revealleft' | 'revealright' | 'revealup' | 'revealdown'
  | 'circlecrop' | 'rectcrop' | 'distance' | 'hlwind' | 'hrwind' | 'vuwind' | 'vdwind';

export interface Transition {
  type: TransitionType;
  duration: number;  // Sekunden
  intensity?: number; // Stärke 0..2 (dynamische Übergänge), Standard 1
}

export type TitleAnimation = 'none' | 'fade' | 'slideup' | 'typewriter' | 'slidedown' | 'slideleft' | 'slideright' | 'pop' | 'zoom' | 'drop';
export type TitleAnimationOut = 'auto' | 'none' | 'fade' | 'slideup' | 'slidedown' | 'slideleft' | 'slideright' | 'shrink' | 'zoom';

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
  animationOut?: TitleAnimationOut;  // Ausblenden (Standard: passend zum Einblenden)
  outlineColor?: string;             // Randfarbe (Standard: Schwarz)
  glow?: string;                     // Leuchten in dieser Farbe ('' = aus)
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
  translation?: string;  // Übersetzung (wird darunter angezeigt)
  words?: SubWord[];     // Wort-Zeiten (für „Wort für Wort“ hervorheben)
}

export interface SubWord { start: number; end: number; text: string }

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
  phase: 'download' | 'extract' | 'transcribe' | 'translate' | 'done' | 'error';
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
  // ab 0.4 (optional, neutral = undefined)
  exposure?: number;     // Blenden -3..3
  temperature?: number;  // -100..100 (kalt ↔ warm)
  tint?: number;         // -100..100 (grün ↔ magenta)
  highlights?: number;   // -100..100
  shadows?: number;      // -100..100
  whites?: number;       // -100..100
  blacks?: number;       // -100..100
  vibrance?: number;     // -100..100
  gamma?: number;        // 0.3..3 (Mitteltöne)
  fade?: number;         // 0..100 (verblasst/matt)
  dehaze?: number;       // 0..100 (Dunst entfernen)
  splitShadow?: number;  // -100..100 (Tiefen einfärben)
  splitHighlight?: number; // -100..100 (Lichter einfärben)
  look?: string;         // Look-ID (siehe LOOKS)
  lookStrength?: number; // 0..1
  lut?: string;          // Pfad zu einer eigenen .cube-Datei
  lutStrength?: number;  // 0..1
  profile?: CameraProfile;  // Kamera-Profil (Log → normale Farben)
  exposureCurve?: Array<{ t: number; ev: number }>;  // Belichtung über die Zeit (Clip-lokal, Blenden), vom Bild-Assistenten
}

/** Kamera-Profile, deren flache Log-Aufnahmen in normale Farben umgerechnet werden. */
export type CameraProfile = 'bmdfilm5' | 'dlog' | 'log';

/** Bild-Effekte, die nicht nur die Farbe betreffen. */
export interface ImageFx {
  vignette: number;   // 0..1
  sharpen: number;    // 0..1
  denoise: number;    // 0..1
  blur: number;       // 0..1
  grain: number;      // 0..1
  glow?: number;        // 0..1 Glühen um helle Stellen (Bloom)
  trails?: number;      // 0..1 Leuchtspuren: helle Stellen ziehen Spuren (FFmpeg lagfun)
  trailsMode?: 'all' | 'lights' | 'marked';  // alles / nur helle Lichter / nur markierte (verfolgte) Lichter
  trailsThreshold?: number;  // 0..1 ab welcher Helligkeit etwas als Licht zählt (Standard 0,6)
  lights?: LightTrack[];     // markierte Lichter (Quell-Koordinaten 0..1, Quellzeit in Sekunden)
  motionBlur?: number;  // 0..1 Bewegungsunschärfe (mehrere Bilder gemittelt, FFmpeg tmix)
  mirror: boolean;    // horizontal spiegeln
  flip: boolean;      // vertikal spiegeln
}

/** Ein markiertes Licht, über das Video verfolgt: Mittelpunkt/Radius relativ zum Quellbild (r relativ zur Höhe). */
export interface LightTrack { id: string; keys: Array<{ t: number; x: number; y: number; r: number }> }

/** Zuschnitt in Prozent je Rand (vor dem Einpassen). */
export interface Crop { left: number; right: number; top: number; bottom: number }

export interface MotionKeyframe {
  t: number;         // Clip-lokale Zeit (Sekunden)
  x: number;         // zusätzliche Verschiebung in % der Bildbreite
  y: number;         // in % der Bildhöhe
  scale: number;     // Faktor (1 = unverändert)
  rotation: number;  // Grad
  opacity: number;   // 0..1
}

export type MotionPreset =
  | 'kenburns' | 'zoomin' | 'zoomout' | 'slidein-left' | 'slidein-right' | 'slidein-up' | 'slidein-down'
  | 'slideout-left' | 'slideout-right' | 'pop' | 'pulse' | 'shake' | 'spin' | 'fadein' | 'fadeout' | 'float' | 'custom'
  // Auftritte (Objekt ins Bild fallen lassen …): shared/effects.ts entranceKeyframes
  | 'dropin' | 'slam' | 'flyin-left' | 'flyin-right' | 'rise';

export interface Motion {
  preset: MotionPreset;
  intensity: number;   // 0..2
  smooth: boolean;
  keyframes: MotionKeyframe[];
  osc?: { kind: 'shake' | 'pulse' | 'float'; amp: number };  // gleichmäßige Schwingung (wird zu den Keyframes addiert)
  blur?: number;       // 0..1 Bewegungsunschärfe der Animation (schnelle Bewegung verwischt – Export: tmix nach perspective)
  curve?: boolean;     // Bewegungspfad als weiche Kurve durch alle Punkte (Catmull-Rom) statt gerader Linien
}

export interface Ducking {
  enabled: boolean;
  amount: number;      // 0..1 (wie stark leiser)
}

// ---------- Ebenen ----------

/** Mischmodus einer Ebene (wie in Photoshop). */
export type BlendMode = 'normal' | 'screen' | 'add' | 'multiply' | 'lighten' | 'darken';

/** Schlagschatten einer Ebene. */
export interface LayerShadow {
  enabled: boolean;
  opacity: number;    // 0..1
  blur: number;       // Weichheit in % der Bildhöhe (0..10)
  distance: number;   // Abstand in % der Bildhöhe (0..20)
  angle: number;      // Richtung, in die der Schatten fällt (Grad, 0 = rechts, 90 = unten)
}

/** Verknüpfter Clip: folgt einem anderen Clip (Licht eines Effekts, Objekt-Kopie vor anderen Ebenen). */
export interface ClipLink {
  clipId: string;
  mode: 'light' | 'copy';
  scale?: number;     // nur 'light': Größe relativ zum Effekt
}

// ---------- Effekt-Simulationen (VFX) ----------

export type VfxKind = 'explosion' | 'fire' | 'smoke' | 'snow' | 'rain' | 'fog' | 'sparks' | 'lightning' | 'dust' | 'confetti' | 'impact'
  | 'flare' | 'bokeh' | 'speedlines' | 'leaks' | 'hearts' | 'glitter';

export interface VfxSpec {
  kind: VfxKind;
  prompt: string;       // ursprüngliche Beschreibung
  duration: number;     // Sekunden
  seed: number;         // Variante
  size: number;         // 0.4..2 (Größe bzw. Dichte der Teilchen)
  intensity: number;    // 0.2..2 (Stärke)
  speed: number;        // 0.3..2.5
  wind: number;         // -1..1 (links ↔ rechts)
  smoke: number;        // 0..2 (Rauchanteil bei Feuer/Explosion)
  color?: string;       // eigene Farbe (sonst natürlich)
  width: number;        // Render-Größe in Pixeln
  height: number;
  fps: number;
  fullFrame: boolean;   // ganzes Bild (Schnee, Regen, Nebel …) oder platzierbar (Explosion, Feuer …)
  loop: boolean;        // nahtlos wiederholbar
}

/** Eigener Effekt: gespeicherte Kombination aus Farbe, Bild-Effekten, Zuschnitt und Animation. */
export interface UserEffect {
  id: string;
  name: string;
  color?: ColorGrade;
  fx?: ImageFx;
  crop?: Crop;
  motion?: Motion;
  motionDuration?: number;  // Clip-Länge beim Speichern (Animationen werden auf neue Clips umgerechnet)
  createdAt: number;
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
  reframe?: ReframeSettings;    // Ausschnitt-Fahrt (normale Videos/Bilder)
  stab360?: { mode: 'off' | 'follow' | 'lock'; smooth: number; horizon: boolean };  // 360°-Stabilisierung mit Bewegungsdaten
  nadir?: { enabled: boolean; size: number; feather: number };  // 360°: unten ausblenden (Selfie-Stick/Hand), Grad ab unten
  transition?: Transition;      // Übergang VOM vorherigen Clip der Spur in diesen Clip
  stabilize?: Stabilization;
  subtitles?: {
    segments: SubtitleSegment[]; style: Omit<TitleStyle, 'text'>; enabled: boolean; attach?: Attachment;
    showTranslation?: boolean; translationColor?: string; translationOnly?: boolean;
    spoken?: 'de' | 'en';      // Sprache der Aufnahme
    highlight?: string;        // Farbe für das gerade gesprochene Wort (leer = aus)
    chunk?: number;            // höchstens so viele Wörter gleichzeitig (0 = ganze Zeile)
    uppercase?: boolean;       // GROSSBUCHSTABEN
  };
  fx?: ImageFx;                 // Vignette, Schärfen, Entrauschen, Weichzeichnen, Körnung, Spiegeln
  crop?: Crop;                  // Zuschnitt
  motion?: Motion;              // Animation (Bewegung/Zoom/Drehen/Deckkraft über die Zeit)
  ducking?: Ducking;            // Musik automatisch leiser, wenn gesprochen wird
  objects?: ObjectTrack[];      // erkannte/getrackte Objekte dieses Clips
  cutout?: Cutout;              // Freistellen anhand einer Objektmaske
  chroma?: ChromaKey;           // Green Screen
  attach?: Attachment;          // Titel-Clip an ein getracktes Objekt heften
  blend?: BlendMode;            // Mischmodus der Ebene (Standard: normal)
  shadow?: LayerShadow;         // Schlagschatten
  link?: ClipLink;              // folgt einem anderen Clip
  mc?: { groupId: string; angle: number };  // Stück einer Mehrkamera-Gruppe (angle −1 = Ton)
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
  letterbox?: number;   // Kino-Balken: Seitenverhältnis des sichtbaren Bilds (z. B. 2,39); 0/leer = aus
  background: string;
  is360?: boolean;   // Projekt als 360°-Panorama (Equirectangular) exportieren
}

/** Marker auf der Timeline (Zeit in Sekunden). `hit` = aus der Musik übernommener Höhepunkt. */
export interface Marker { id: string; t: number; kind?: 'user' | 'beat' | 'hit' }

export interface Project {
  version: 1;
  id: string;
  name: string;
  settings: ProjectSettings;
  defaults?: ProjectDefaults;
  media: Record<string, MediaItem>;
  tracks: Track[];
  clips: Record<string, Clip>;
  multicam?: Record<string, MulticamGroup>;   // Mehrkamera-Gruppen
  markers?: Marker[];                         // Marker auf der Timeline (Beat-Marker zum Einrasten/Schneiden)
  createdAt: number;
  modifiedAt: number;
}

// ---------- 3D-Modelle ----------

export type Model3DFormat = 'glb' | 'gltf' | 'obj' | 'fbx' | 'stl';
export type Model3DAnimation = 'none' | 'turntable' | 'swing' | 'float' | 'spinin' | 'flyby' | 'embedded';

/** Einstellungen eines 3D-Modells, das zu einem Video mit Transparenz gerendert wird. */
export interface Model3DSpec {
  file: string;            // Pfad der 3D-Datei
  format: Model3DFormat;
  name: string;
  duration: number;        // Sekunden
  fps: number;
  width: number;           // Render-Größe
  height: number;
  animation: Model3DAnimation;
  speed: number;           // Tempo der Bewegung (1 = normal)
  yaw: number;             // Ansicht: Drehung um die Hochachse (Grad)
  pitch: number;           // Blick von oben (Grad, 0 = von vorn)
  roll: number;            // Neigung (Grad)
  lightYaw: number;        // Richtung des Hauptlichts (Grad, 0 = von vorn)
  lightPitch: number;      // Höhe des Hauptlichts (Grad)
  lightColor: string;      // Farbe des Hauptlichts
  lightStrength: number;   // 0..3
  ambient: number;         // Umgebungslicht 0..2
  exposure: number;        // Belichtung (Blenden)
  shadow: number;          // Bodenschatten 0..1
  color?: string;          // Farbe für Modelle ohne Material (STL, OBJ)
  metal: number;           // 0..1 (nur ohne eigenes Material)
  clipIndex: number;       // eingebettete Animation (glTF/FBX)
}

// ---------- Mehrkamera ----------

export interface MulticamAngle {
  mediaId: string;
  name: string;
  shift: number;        // Beginn der Datei auf der Gruppen-Zeitachse (Sekunden, ≥ 0)
  template: Clip;       // Einstellungen (Farbe, Größe, 360°-Blick …), die jedes Stück dieser Kamera übernimmt
}

export interface MulticamGroup {
  id: string;
  name: string;
  trackId: string;       // Videospur mit dem geschnittenen Ergebnis
  audioTrackId: string;  // Tonspur
  start: number;         // Beginn auf der Timeline
  duration: number;      // Länge der Gruppe
  angles: MulticamAngle[];
  audioAngle: number;    // Ton von dieser Kamera
  cuts: Array<{ t: number; angle: number }>;  // Gruppen-Zeit → Kamera (erster Schnitt bei 0)
  confidence: number[];  // Sicherheit der Ton-Synchronisierung je Kamera (0..1)
}

export interface ProjectFile {
  path: string;
  project: Project;
}

// ---------- Export ----------

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif' | 'jpg';
export type ExportCodec = 'h264' | 'h265' | 'prores' | 'vp9' | 'gif' | 'jpeg';
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
  loudness?: number;       // Ziel-Lautheit in LUFS (z. B. −14 für Social Media); leer = unverändert
  name?: string;           // Anzeigename in der Export-Warteschlange
}

export interface ExportProgress {
  jobId: string;
  phase: 'queued' | 'preparing' | 'rendering' | 'done' | 'error' | 'cancelled';
  percent: number;
  fps?: number;
  speed?: string;
  eta?: number;
  message?: string;
  outputPath?: string;
  name?: string;
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

/** Ansicht: Größe der Bereiche, Vorschau- und Timeline-Einstellungen (werden gemerkt). */
export interface ViewSettings {
  leftWidth: number;          // Mediathek (0 = ausgeblendet)
  rightWidth: number;         // Inspektor (0 = ausgeblendet)
  timelineHeight: number;
  previewQuality: 'auto' | 'full' | 'half' | 'quarter' | 'uhd';
  previewGuides: 'none' | 'thirds' | 'safe' | 'both';
  selectionFrame: 'always' | 'hover' | 'never';
  previewBackground: 'black' | 'checker';
  trackSize: 'small' | 'medium' | 'large';
  thumbnails: boolean;
  waveforms: boolean;
  followPlayhead: boolean;    // Timeline scrollt beim Abspielen mit
}

export const DEFAULT_VIEW: ViewSettings = {
  leftWidth: 300, rightWidth: 300, timelineHeight: 300,
  previewQuality: 'auto', previewGuides: 'none', selectionFrame: 'hover', previewBackground: 'black',
  trackSize: 'medium', thumbnails: true, waveforms: true, followPlayhead: true,
};

/** Vorgaben eines Projekts (aus einer Vorlage): neue Clips bekommen diesen Look, Untertitel diesen Stil. */
export interface ProjectDefaults {
  color?: Partial<ColorGrade>;
  fx?: Partial<ImageFx>;
  subtitlePreset?: string;          // id aus SUBTITLE_PRESETS
  subtitleSpoken?: 'de' | 'en' | 'auto';
  subtitleShow?: 'original' | 'both' | 'translation';
  exportPreset?: string;            // id aus EXPORT_PRESETS
}

/** Projekt-Vorlage: Format, Vorgaben und optional ein Intro (Clips am Anfang). */
export interface ProjectTemplate {
  id: string;
  name: string;
  createdAt: number;
  settings: ProjectSettings;
  defaults: ProjectDefaults;
  intro?: { clips: Clip[]; media: MediaItem[]; tracks: Track[]; duration: number };
}

export interface StorageInfo {
  cacheBytes: number; cacheItems: number; oldBytes: number;
  soundsBytes: number; effectsBytes: number; modelsBytes: number;
}

export interface Settings {
  view?: Partial<ViewSettings>;
  watchFolder?: string;        // beobachteter Ordner (neue Dateien werden gemeldet)
  watchEnabled?: boolean;
  templates?: ProjectTemplate[];
  cloud?: CloudSettings;
  translateUrl?: string;      // eigener LibreTranslate-Server (optional)
  translateKey?: string;
  remoteControl?: boolean;    // Fernsteuerung (Stream Deck) erlauben
  remotePort?: number;
  userEffects?: UserEffect[];  // eigene Effekte (Bibliothek „Effekte“ → „Eigene“)
  aiDetectModel?: AiDetectModel;
  aiSegmentModel?: AiSegmentModel;
  lastProject?: string;
  recentProjects: string[];
  proxyHeight: number;
  /** Vorschau-Dateien: 'auto' = nur wenn nötig (4K, HEVC, 10 Bit …), 'always' = immer */
  proxyMode?: 'auto' | 'always';
  /** Kamera-Vorschaudateien (.LRF/.LRV) als Vorschau nutzen (Standard: an) */
  useCompanion?: boolean;
  /** 360°-Rohvideos beim Import automatisch nahtlos ausrichten (Standard: an) */
  autoStitch?: boolean;
  /** Ordner-Import: Unterordner mit durchsuchen (Standard: an) */
  folderRecursive?: boolean;
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
