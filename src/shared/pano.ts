// 360°-Mathematik, Übergangs- und Titel-Definitionen – gemeinsam für Vorschau (WebGL/Canvas) und Export (FFmpeg).
import { ease, panoEase } from './reframe';
import type { TitleAnimation, TitleAnimationOut, PanoKeyframe, PanoMode, PanoSettings, StitchSettings, TitleStyle, Transition, TransitionType } from './types';

export interface PanoView { yaw: number; pitch: number; roll: number; fov: number }

export function defaultPano(mode: PanoMode = 'flat'): PanoSettings {
  return { mode, keyframes: [{ t: 0, yaw: 0, pitch: 0, roll: 0, fov: mode === 'littleplanet' ? 250 : 100 }], smooth: true };
}

export function defaultStitch(mode: StitchSettings['mode']): StitchSettings {
  // Zwei Fischaugen: weiche Naht (8°) als Standard
  return mode === 'equirect' ? { mode, fov: 195, yaw: 0, pitch: 0, roll: 0 } : { mode, fov: 195, yaw: 0, pitch: 0, roll: 0, blend: 8 };
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
      const u = ease(panoEase(pano), (t - a.t) / span);
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
  { type: 'fade', name: 'Überblenden', group: '🌫️ Blenden' },
  { type: 'dissolve', name: 'Auflösen', group: '🌫️ Blenden' },
  { type: 'fadeblack', name: 'Über Schwarz', group: '🌫️ Blenden' },
  { type: 'fadewhite', name: 'Über Weiß', group: '🌫️ Blenden' },
  { type: 'fadegrays', name: 'Über Grau', group: '🌫️ Blenden' },
  { type: 'fadefast', name: 'Schnell blenden', group: '🌫️ Blenden' },
  { type: 'fadeslow', name: 'Langsam blenden', group: '🌫️ Blenden' },
  { type: 'distance', name: 'Weiche Mischung', group: '🌫️ Blenden' },
  { type: 'blurdissolve', name: 'Kino-Unschärfe', group: '🌫️ Blenden' },
  { type: 'wipeleft', name: 'Wischen ←', group: '🧹 Wischen' },
  { type: 'wiperight', name: 'Wischen →', group: '🧹 Wischen' },
  { type: 'wipeup', name: 'Wischen ↑', group: '🧹 Wischen' },
  { type: 'wipedown', name: 'Wischen ↓', group: '🧹 Wischen' },
  { type: 'smoothleft', name: 'Weich ←', group: '🧹 Wischen' },
  { type: 'smoothright', name: 'Weich →', group: '🧹 Wischen' },
  { type: 'smoothup', name: 'Weich ↑', group: '🧹 Wischen' },
  { type: 'smoothdown', name: 'Weich ↓', group: '🧹 Wischen' },
  { type: 'wipetl', name: 'Ecke ↖', group: '🧹 Wischen' },
  { type: 'wipetr', name: 'Ecke ↗', group: '🧹 Wischen' },
  { type: 'wipebl', name: 'Ecke ↙', group: '🧹 Wischen' },
  { type: 'wipebr', name: 'Ecke ↘', group: '🧹 Wischen' },
  { type: 'diagtl', name: 'Diagonal ↖', group: '🧹 Wischen' },
  { type: 'diagtr', name: 'Diagonal ↗', group: '🧹 Wischen' },
  { type: 'diagbl', name: 'Diagonal ↙', group: '🧹 Wischen' },
  { type: 'diagbr', name: 'Diagonal ↘', group: '🧹 Wischen' },
  { type: 'hlwind', name: 'Wind ←', group: '🧹 Wischen' },
  { type: 'hrwind', name: 'Wind →', group: '🧹 Wischen' },
  { type: 'vuwind', name: 'Wind ↑', group: '🧹 Wischen' },
  { type: 'vdwind', name: 'Wind ↓', group: '🧹 Wischen' },
  { type: 'slideleft', name: 'Schieben ←', group: '➡️ Schieben' },
  { type: 'slideright', name: 'Schieben →', group: '➡️ Schieben' },
  { type: 'slideup', name: 'Schieben ↑', group: '➡️ Schieben' },
  { type: 'slidedown', name: 'Schieben ↓', group: '➡️ Schieben' },
  { type: 'coverleft', name: 'Drüberschieben ←', group: '➡️ Schieben' },
  { type: 'coverright', name: 'Drüberschieben →', group: '➡️ Schieben' },
  { type: 'coverup', name: 'Drüberschieben ↑', group: '➡️ Schieben' },
  { type: 'coverdown', name: 'Drüberschieben ↓', group: '➡️ Schieben' },
  { type: 'revealleft', name: 'Aufdecken ←', group: '➡️ Schieben' },
  { type: 'revealright', name: 'Aufdecken →', group: '➡️ Schieben' },
  { type: 'revealup', name: 'Aufdecken ↑', group: '➡️ Schieben' },
  { type: 'revealdown', name: 'Aufdecken ↓', group: '➡️ Schieben' },
  { type: 'circleopen', name: 'Kreis öffnen', group: '🔷 Formen' },
  { type: 'circleclose', name: 'Kreis schließen', group: '🔷 Formen' },
  { type: 'circlecrop', name: 'Kreis-Blende', group: '🔷 Formen' },
  { type: 'rectcrop', name: 'Rechteck-Blende', group: '🔷 Formen' },
  { type: 'vertopen', name: 'Vorhang auf ↔', group: '🔷 Formen' },
  { type: 'vertclose', name: 'Vorhang zu ↔', group: '🔷 Formen' },
  { type: 'horzopen', name: 'Vorhang auf ↕', group: '🔷 Formen' },
  { type: 'horzclose', name: 'Vorhang zu ↕', group: '🔷 Formen' },
  { type: 'radial', name: 'Radial', group: '🔷 Formen' },
  { type: 'hlslice', name: 'Streifen ←', group: '🔷 Formen' },
  { type: 'hrslice', name: 'Streifen →', group: '🔷 Formen' },
  { type: 'vuslice', name: 'Streifen ↑', group: '🔷 Formen' },
  { type: 'vdslice', name: 'Streifen ↓', group: '🔷 Formen' },
  { type: 'squeezeh', name: 'Zusammendrücken ↔', group: '🔷 Formen' },
  { type: 'squeezev', name: 'Zusammendrücken ↕', group: '🔷 Formen' },
  { type: 'zoomin', name: 'Zoom', group: '✨ Effekt' },
  { type: 'pixelize', name: 'Pixel', group: '✨ Effekt' },
  { type: 'hblur', name: 'Unschärfe', group: '✨ Effekt' },
  { type: 'zoomthrough', name: 'Zoom-Durchflug', group: '⚡ Dynamisch' },
  { type: 'punchin', name: 'Einschlag', group: '⚡ Dynamisch' },
  { type: 'whipleft', name: 'Wisch-Schwenk ←', group: '⚡ Dynamisch' },
  { type: 'whipright', name: 'Wisch-Schwenk →', group: '⚡ Dynamisch' },
  { type: 'whipup', name: 'Wisch-Schwenk ↑', group: '⚡ Dynamisch' },
  { type: 'whipdown', name: 'Wisch-Schwenk ↓', group: '⚡ Dynamisch' },
  { type: 'rollleft', name: 'Wegrollen ←', group: '⚡ Dynamisch' },
  { type: 'rollright', name: 'Wegrollen →', group: '⚡ Dynamisch' },
  { type: 'spin', name: 'Drehung', group: '⚡ Dynamisch' },
  { type: 'flash', name: 'Blitz', group: '⚡ Dynamisch' },
  { type: 'shake', name: 'Wackeln', group: '⚡ Dynamisch' },
  { type: 'glitch', name: 'Glitch', group: '⚡ Dynamisch' },
];

const SHORT_TRANSITIONS = new Set<TransitionType>(['whipleft', 'whipright', 'whipup', 'whipdown', 'flash', 'shake', 'glitch', 'zoomthrough', 'spin', 'punchin', 'rollleft', 'rollright', 'blurdissolve']);

export function defaultTransition(type: TransitionType = 'fade'): Transition {
  // Dynamische Übergänge wirken kurz am besten
  return SHORT_TRANSITIONS.has(type) ? { type, duration: 0.6, intensity: 1 } : { type, duration: 1 };
}

// ---------- Titel ----------

export interface FontDef { key: string; name: string; css: string; files: Partial<Record<'darwin' | 'win32' | 'linux', string[]>> }

export const FONTS: FontDef[] = [
  { key: 'sans', name: 'Standard (Helvetica/Arial)', css: 'Helvetica, Arial, sans-serif', files: { darwin: ['/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf'], win32: ['C:/Windows/Fonts/arial.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'] } },
  { key: 'sans-bold', name: 'Fett (Helvetica/Arial Bold)', css: 'Helvetica, Arial, sans-serif', files: { darwin: ['/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial Bold.ttf'], win32: ['C:/Windows/Fonts/arialbd.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'] } },
  { key: 'impact', name: 'Impact (Meme-Stil)', css: 'Impact, "Arial Black", sans-serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Impact.ttf', '/Library/Fonts/Impact.ttf'], win32: ['C:/Windows/Fonts/impact.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] } },
  { key: 'serif', name: 'Serif (Times/Georgia)', css: 'Georgia, "Times New Roman", serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Georgia.ttf', '/Library/Fonts/Georgia.ttf', '/System/Library/Fonts/Times.ttc'], win32: ['C:/Windows/Fonts/georgia.ttf', 'C:/Windows/Fonts/times.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'] } },
  { key: 'black', name: 'Extra fett (Arial Black)', css: '"Arial Black", "Arial Bold", sans-serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Arial Black.ttf', '/Library/Fonts/Arial Black.ttf'], win32: ['C:/Windows/Fonts/ariblk.ttf', 'C:/Windows/Fonts/arialbd.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] } },
  { key: 'condensed', name: 'Schmal (Arial Narrow)', css: '"Arial Narrow", "Bahnschrift Condensed", sans-serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Narrow.ttf'], win32: ['C:/Windows/Fonts/ARIALNB.TTF', 'C:/Windows/Fonts/bahnschrift.ttf', 'C:/Windows/Fonts/arialbd.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'] } },
  { key: 'rounded', name: 'Rund (Arial Rounded)', css: '"Arial Rounded MT Bold", "Segoe UI", sans-serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf', '/Library/Fonts/Arial Rounded Bold.ttf'], win32: ['C:/Windows/Fonts/ARLRDBD.TTF', 'C:/Windows/Fonts/segoeuib.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] } },
  { key: 'script', name: 'Handschrift', css: '"Brush Script MT", "Segoe Script", cursive', files: { darwin: ['/System/Library/Fonts/Supplemental/Brush Script.ttf', '/Library/Fonts/Brush Script.ttf'], win32: ['C:/Windows/Fonts/segoesc.ttf', 'C:/Windows/Fonts/BRUSHSCI.TTF'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf'] } },
  { key: 'trebuchet', name: 'Modern (Trebuchet)', css: '"Trebuchet MS", sans-serif', files: { darwin: ['/System/Library/Fonts/Supplemental/Trebuchet MS Bold.ttf', '/Library/Fonts/Trebuchet MS Bold.ttf'], win32: ['C:/Windows/Fonts/trebucbd.ttf'], linux: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] } },
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
  { id: 'neon', name: '💡 Neon', style: { text: 'NEON', font: 'rounded', size: 11, color: '#e0fff4', glow: '#22d3ee', shadow: false, outline: false, background: '', animation: 'pop', animationOut: 'shrink' } },
  { id: 'racing', name: '🏁 Racing', style: { text: 'FULL SPEED', font: 'black', size: 12, color: '#facc15', outline: true, outlineColor: '#000000', shadow: true, background: '', animation: 'slideright', animationOut: 'slideleft' } },
  { id: 'cinema', name: '🎞 Kino', style: { text: 'D I E   R E I S E', font: 'serif', size: 6, color: '#f5f5f4', shadow: false, outline: false, background: '', animation: 'fade', animationOut: 'fade' } },
  { id: 'impact', name: '💥 Wucht', style: { text: 'BOOM', font: 'impact', size: 18, color: '#ffffff', outline: true, outlineColor: '#dc2626', shadow: true, background: '', animation: 'zoom', animationOut: 'zoom' } },
  { id: 'sport', name: '⚡ Sport', style: { text: 'TOP SPEED 280', font: 'condensed', size: 9, color: '#ffffff', background: '#dc2626', backgroundOpacity: 0.9, shadow: false, animation: 'slideleft', animationOut: 'slideright' } },
  { id: 'script', name: '✍️ Handschrift', style: { text: 'Sommer 2026', font: 'script', size: 10, color: '#ffffff', shadow: true, background: '', animation: 'fade' } },
  { id: 'drop', name: '🪂 Fallender Titel', style: { text: 'LANDUNG', font: 'black', size: 12, color: '#ffffff', outline: true, shadow: true, background: '', animation: 'drop', animationOut: 'slidedown' } },
];

/** Zustand einer Titel-Animation: Deckkraft, Versatz (% der Breite/Höhe), Größe, sichtbare Zeichen. */
export interface TitleAnimState { alpha: number; dx: number; dy: number; scale: number; chars: number | null }

/** Ein- und Ausblend-Dauer (Sekunden). */
export function titleAnimDurations(duration: number): { inD: number; outD: number } {
  return { inD: Math.min(0.6, duration / 3), outD: Math.min(0.6, duration / 3) };
}

const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
/** Überschwingen (größer als Ziel, dann zurück). */
const backOut = (u: number) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);

/** Ausblenden, wenn nichts gewählt ist: wie bisher Ausblenden der Deckkraft (außer bei „keine“). */
export function titleOutOf(style: Pick<TitleStyle, 'animation' | 'animationOut'>): Exclude<TitleAnimationOut, 'auto'> {
  const o = style.animationOut ?? 'auto';
  if (o !== 'auto') return o;
  return style.animation === 'none' ? 'none' : 'fade';
}

/** Deckkraft/Versatz/Größe einer Titel-Animation zu einer Clip-Zeit (Vorschau). Export: titleAnimExpr (gleiche Formeln). */
export function titleAnimationAt(style: Pick<TitleStyle, 'animation' | 'animationOut'>, t: number, duration: number): TitleAnimState {
  const { inD, outD } = titleAnimDurations(duration);
  const s: TitleAnimState = { alpha: 1, dx: 0, dy: 0, scale: 1, chars: null };
  const u = Math.max(0, Math.min(1, t / inD));
  const e = easeOut(u);
  switch (style.animation) {
    case 'fade': s.alpha = u; break;
    case 'slideup': s.alpha = u; s.dy = (1 - u) * 6; break;
    case 'slidedown': s.alpha = u; s.dy = -(1 - e) * 8; break;
    case 'slideleft': s.alpha = u; s.dx = (1 - e) * 12; break;
    case 'slideright': s.alpha = u; s.dx = -(1 - e) * 12; break;
    case 'pop': s.alpha = Math.min(1, u * 3); s.scale = Math.max(0.01, backOut(u)); break;
    case 'zoom': s.alpha = u; s.scale = 1 + (1 - e) * 1.5; break;
    case 'drop': s.alpha = Math.min(1, u * 3); s.dy = -25 * (1 - backOut(u)); break;
    case 'typewriter': s.chars = Math.floor(t / 0.06); break;
    default: break;
  }
  const out = titleOutOf(style);
  if (out !== 'none' && t > duration - outD) {
    const v = Math.max(0, Math.min(1, (duration - t) / outD));
    const eo = easeOut(v);
    s.alpha *= v;
    if (out === 'slideup') s.dy += -(1 - eo) * 8;
    else if (out === 'slidedown') s.dy += (1 - eo) * 8;
    else if (out === 'slideleft') s.dx += -(1 - eo) * 12;
    else if (out === 'slideright') s.dx += (1 - eo) * 12;
    else if (out === 'shrink') s.scale *= Math.max(0.01, eo);
    else if (out === 'zoom') s.scale *= 1 + (1 - eo) * 1.5;
  }
  return s;
}

/**
 * Dieselbe Animation als FFmpeg-Ausdrücke (drawtext x/y/alpha/fontsize). `T` = Zeit seit Clip-Beginn (Ausdruck).
 * Ergebnis: Ausdrücke für alpha, dx (%), dy (%), scale.
 */
export function titleAnimExpr(style: Pick<TitleStyle, 'animation' | 'animationOut'>, duration: number, T: string): { alpha: string; dx: string; dy: string; scale: string } {
  const { inD, outD } = titleAnimDurations(duration);
  const n = (x: number) => (Math.round(x * 1e5) / 1e5).toString();
  const u = `clip(${T}/${n(inD)},0,1)`;
  const e = `(1-pow(1-${u},3))`;
  const back = `(1+2.70158*pow(${u}-1,3)+1.70158*pow(${u}-1,2))`;
  let alpha = '1', dx = '0', dy = '0', scale = '1';
  switch (style.animation) {
    case 'fade': alpha = u; break;
    case 'slideup': alpha = u; dy = `(1-${u})*6`; break;
    case 'slidedown': alpha = u; dy = `-(1-${e})*8`; break;
    case 'slideleft': alpha = u; dx = `(1-${e})*12`; break;
    case 'slideright': alpha = u; dx = `-(1-${e})*12`; break;
    case 'pop': alpha = `min(1,${u}*3)`; scale = `max(0.01,${back})`; break;
    case 'zoom': alpha = u; scale = `(1+(1-${e})*1.5)`; break;
    case 'drop': alpha = `min(1,${u}*3)`; dy = `(-25*(1-${back}))`; break;
    default: break;
  }
  const out = titleOutOf(style);
  if (out !== 'none') {
    const v = `clip((${n(duration)}-${T})/${n(outD)},0,1)`;
    const eo = `(1-pow(1-${v},3))`;
    // v ist vor dem Ausblenden 1 → alle Terme neutral
    alpha = `(${alpha})*${v}`;
    if (out === 'slideup') dy = `(${dy})-(1-${eo})*8`;
    else if (out === 'slidedown') dy = `(${dy})+(1-${eo})*8`;
    else if (out === 'slideleft') dx = `(${dx})-(1-${eo})*12`;
    else if (out === 'slideright') dx = `(${dx})+(1-${eo})*12`;
    else if (out === 'shrink') scale = `(${scale})*max(0.01,${eo})`;
    else if (out === 'zoom') scale = `(${scale})*(1+(1-${eo})*1.5)`;
  }
  return { alpha, dx, dy, scale };
}

export const TITLE_ANIMATIONS: Array<{ id: TitleAnimation; name: string }> = [
  { id: 'none', name: 'Keine' }, { id: 'fade', name: '🌫️ Einblenden' }, { id: 'slideup', name: '⬆️ Von unten' },
  { id: 'slidedown', name: '⬇️ Von oben' }, { id: 'slideleft', name: '⬅️ Von rechts' }, { id: 'slideright', name: '➡️ Von links' },
  { id: 'pop', name: '💥 Aufploppen' }, { id: 'zoom', name: '🔍 Heranzoomen' }, { id: 'drop', name: '🪂 Herabfallen' },
  { id: 'typewriter', name: '⌨️ Schreibmaschine' },
];
export const TITLE_ANIMATIONS_OUT: Array<{ id: TitleAnimationOut; name: string }> = [
  { id: 'auto', name: 'Passend (Ausblenden)' }, { id: 'none', name: 'Keine' }, { id: 'fade', name: '🌫️ Ausblenden' },
  { id: 'slideup', name: '⬆️ Nach oben' }, { id: 'slidedown', name: '⬇️ Nach unten' }, { id: 'slideleft', name: '⬅️ Nach links' },
  { id: 'slideright', name: '➡️ Nach rechts' }, { id: 'shrink', name: '🫧 Schrumpfen' }, { id: 'zoom', name: '🔍 Wegzoomen' },
];

export const TITLE_IN_DURATION = 0.6;
