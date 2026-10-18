// 360°-Mathematik, Übergangs- und Titel-Definitionen – gemeinsam für Vorschau (WebGL/Canvas) und Export (FFmpeg).
import type { PanoKeyframe, PanoMode, PanoSettings, StitchSettings, TitleStyle, Transition, TransitionType } from './types';

export interface PanoView { yaw: number; pitch: number; roll: number; fov: number }

export function defaultPano(mode: PanoMode = 'flat'): PanoSettings {
  return { mode, keyframes: [{ t: 0, yaw: 0, pitch: 0, roll: 0, fov: mode === 'littleplanet' ? 250 : 100 }], smooth: true };
}

export function defaultStitch(mode: StitchSettings['mode']): StitchSettings {
  return { mode, fov: 195, yaw: 0, pitch: 0, roll: 0 };
}

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/** Kürzester Weg zwischen zwei Winkeln (Grad), damit 350° → 10° nicht rückwärts dreht. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

/** Ausrichtung zu einer Clip-Zeit (Sekunden ab Clip-Anfang) – linear oder weich interpoliert. */
export function panoViewAt(pano: PanoSettings, t: number): PanoView {
  const kfs = pano.keyframes;
  if (kfs.length === 0) return { yaw: 0, pitch: 0, roll: 0, fov: 100 };
  if (kfs.length === 1 || t <= kfs[0].t) return pick(kfs[0]);
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return pick(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = Math.max(1e-6, b.t - a.t);
      let u = (t - a.t) / span;
      if (pano.smooth) u = smoothstep(u);
      return {
        yaw: lerpAngle(a.yaw, b.yaw, u),
        pitch: a.pitch + (b.pitch - a.pitch) * u,
        roll: lerpAngle(a.roll, b.roll, u),
        fov: a.fov + (b.fov - a.fov) * u,
      };
    }
  }
  return pick(last);
}

function pick(k: PanoKeyframe): PanoView {
  return { yaw: k.yaw, pitch: k.pitch, roll: k.roll, fov: k.fov };
}

/** Keyframe an Zeit t setzen oder ersetzen (Toleranz 1/60 s). */
export function upsertKeyframe(pano: PanoSettings, kf: PanoKeyframe): PanoSettings {
  const kfs = pano.keyframes.filter((k) => Math.abs(k.t - kf.t) > 1 / 60);
  kfs.push(kf);
  kfs.sort((a, b) => a.t - b.t);
  return { ...pano, keyframes: kfs };
}

export function removeKeyframe(pano: PanoSettings, t: number): PanoSettings {
  if (pano.keyframes.length <= 1) return pano;
  return { ...pano, keyframes: pano.keyframes.filter((k) => Math.abs(k.t - t) > 1 / 60) };
}

export function keyframeAt(pano: PanoSettings, t: number): PanoKeyframe | undefined {
  return pano.keyframes.find((k) => Math.abs(k.t - t) <= 1 / 60);
}

/** Vertikales Sichtfeld aus horizontalem und Seitenverhältnis (wie FFmpeg v360 bei flat). */
export function verticalFov(hfov: number, width: number, height: number): number {
  const t = Math.tan((hfov * Math.PI) / 360) * (height / width);
  return (Math.atan(t) * 360) / Math.PI;
}

/** Vertikales Sichtfeld der Little-Planet-Ansicht (stereografisch) bei gegebenem Seitenverhältnis. */
export function stereographicVfov(hfov: number, width: number, height: number): number {
  return (Math.atan(Math.tan((hfov * Math.PI) / 720) * (height / width)) * 720) / Math.PI;
}

/**
 * Rotations-Quaternion wie in FFmpeg v360 (Reihenfolge yaw → pitch → roll).
 * Rückgabe [w, x, y, z].
 */
export function panoQuaternion(yaw: number, pitch: number, roll: number): [number, number, number, number] {
  const y = (yaw * Math.PI) / 360, p = (pitch * Math.PI) / 360, r = (roll * Math.PI) / 360;
  const qy: Q = [Math.cos(y), 0, Math.sin(y), 0];
  const qp: Q = [Math.cos(p), Math.sin(p), 0, 0];
  const qr: Q = [Math.cos(r), 0, 0, Math.sin(r)];
  return qmul(qmul(qy, qp), qr);
}

type Q = [number, number, number, number];
function qmul(a: Q, b: Q): Q {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** 3×3-Rotationsmatrix (zeilenweise) aus dem Quaternion – für den Shader. */
export function panoMatrix(yaw: number, pitch: number, roll: number): number[] {
  const [w, x, y, z] = panoQuaternion(yaw, pitch, roll);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

// ---------- Übergänge ----------

export interface TransitionDef { type: TransitionType; name: string; group: string }

export const TRANSITIONS: TransitionDef[] = [
  { type: 'fade', name: 'Überblenden', group: 'Blenden' },
  { type: 'fadeblack', name: 'Über Schwarz', group: 'Blenden' },
  { type: 'fadewhite', name: 'Über Weiß', group: 'Blenden' },
  { type: 'dissolve', name: 'Auflösen', group: 'Blenden' },
  { type: 'wipeleft', name: 'Wischen links', group: 'Wischen' },
  { type: 'wiperight', name: 'Wischen rechts', group: 'Wischen' },
  { type: 'wipeup', name: 'Wischen hoch', group: 'Wischen' },
  { type: 'wipedown', name: 'Wischen runter', group: 'Wischen' },
  { type: 'smoothleft', name: 'Weich links', group: 'Wischen' },
  { type: 'smoothright', name: 'Weich rechts', group: 'Wischen' },
  { type: 'slideleft', name: 'Schieben links', group: 'Schieben' },
  { type: 'slideright', name: 'Schieben rechts', group: 'Schieben' },
  { type: 'slideup', name: 'Schieben hoch', group: 'Schieben' },
  { type: 'slidedown', name: 'Schieben runter', group: 'Schieben' },
  { type: 'circleopen', name: 'Kreis öffnen', group: 'Formen' },
  { type: 'circleclose', name: 'Kreis schließen', group: 'Formen' },
  { type: 'radial', name: 'Radial', group: 'Formen' },
  { type: 'zoomin', name: 'Zoom', group: 'Effekt' },
  { type: 'pixelize', name: 'Pixel', group: 'Effekt' },
  { type: 'hblur', name: 'Unschärfe', group: 'Effekt' },
];

export function defaultTransition(type: TransitionType = 'fade'): Transition {
  return { type, duration: 1 };
}

// ---------- Titel ----------

export interface FontDef { key: string; name: string; css: string; files: Partial<Record<'darwin' | 'win32' | 'linux', string[]>> }

export const FONTS: FontDef[] = [
  { key: 'sans', name: 'Standard (Helvetica/Arial)', css: 'Helvetica, Arial, sans-serif', files: { darwin: ['/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf'], win32: ['C:/Windows/Fonts/arial.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'] } },
  { key: 'sans-bold', name: 'Fett (Helvetica/Arial Bold)', css: 'Helvetica, Arial, sans-serif', files: { darwin: ['/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial Bold.ttf'], win32: ['C:/Windows/Fonts/arialbd.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'] } },
  { key: 'impact', name: 'Impact (Meme-Stil)', css: 'Impact, "Arial Black", sans-serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Impact.ttf', '/Library/Fonts/Impact.ttf'], win32: ['C:/Windows/Fonts/impact.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] } },
  { key: 'serif', name: 'Serif (Times/Georgia)', css: 'Georgia, "Times New Roman", serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Georgia.ttf', '/Library/Fonts/Georgia.ttf', '/System/Library/Fonts/Times.ttc'], win32: ['C:/Windows/Fonts/georgia.ttf', 'C:/Windows/Fonts/times.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'] } },
  { key: 'mono', name: 'Schreibmaschine (Courier/Menlo)', css: 'Menlo, "Courier New", monospace', files: { darwin: ['/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/Supplemental/Courier New.ttf'], win32: ['C:/Windows/Fonts/cour.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'] } },
];

export function fontDef(key: string): FontDef {
  return FONTS.find((f) => f.key === key) ?? FONTS[0];
}

export function defaultTitle(text = 'Dein Titel'): TitleStyle {
  return {
    text, font: 'sans-bold', size: 9, color: '#ffffff', bold: true, align: 'center', x: 50, y: 50,
    background: '', backgroundOpacity: 0.6, shadow: true, outline: false, animation: 'fade',
  };
}

export function defaultSubtitleStyle(): Omit<TitleStyle, 'text'> {
  return {
    font: 'sans-bold', size: 5.5, color: '#ffffff', bold: true, align: 'center', x: 50, y: 85,
    background: '#000000', backgroundOpacity: 0.55, shadow: true, outline: false, animation: 'none',
  };
}

export interface TitleTemplate { id: string; name: string; style: Partial<TitleStyle> }

export const TITLE_TEMPLATES: TitleTemplate[] = [
  { id: 'simple', name: 'Einfach', style: { text: 'Dein Titel', background: '', shadow: true, animation: 'fade' } },
  { id: 'box', name: 'Mit Kasten', style: { text: 'Dein Titel', background: '#000000', backgroundOpacity: 0.6, shadow: false, animation: 'fade' } },
  { id: 'lower', name: 'Bauchbinde', style: { text: 'Name · Ort', size: 5, x: 50, y: 85, background: '#000000', backgroundOpacity: 0.7, align: 'center', animation: 'slideup' } },
  { id: 'meme', name: 'Meme', style: { text: 'TEXT OBEN', font: 'impact', size: 10, y: 12, color: '#ffffff', outline: true, shadow: false, animation: 'none' } },
  { id: 'social', name: 'Social-Media-Untertitel', style: { text: 'So sieht es aus', font: 'sans-bold', size: 6, y: 80, color: '#ffe066', background: '#000000', backgroundOpacity: 0.55, animation: 'none' } },
  { id: 'typewriter', name: 'Schreibmaschine', style: { text: 'Kapitel 1', font: 'mono', size: 7, animation: 'typewriter', background: '', shadow: true } },
];

/** Deckkraft/Versatz einer Titel-Animation zu einer Clip-Zeit (für Vorschau und Export identisch). */
export function titleAnimationAt(style: Pick<TitleStyle, 'animation'>, t: number, duration: number): { alpha: number; dy: number; chars: number | null } {
  const inD = Math.min(0.6, duration / 3);
  const outD = Math.min(0.6, duration / 3);
  let alpha = 1, dy = 0;
  let chars: number | null = null;
  if (style.animation === 'fade' || style.animation === 'slideup') {
    if (t < inD) alpha = Math.max(0, t / inD);
    else if (t > duration - outD) alpha = Math.max(0, (duration - t) / outD);
    if (style.animation === 'slideup' && t < inD) dy = (1 - t / inD) * 6; // Prozent der Höhe
  } else if (style.animation === 'typewriter') {
    chars = Math.floor(t / 0.06);
    if (t > duration - outD) alpha = Math.max(0, (duration - t) / outD);
  }
  return { alpha, dy, chars };
}

export const TITLE_IN_DURATION = 0.6;
