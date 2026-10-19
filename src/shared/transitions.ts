// Dynamische Übergänge (Zoom-Durchflug, Wisch-Schwenk, Drehung, Blitz, Wackeln, Glitch) mit einstellbarer Stärke.
// Eine Rechnung für beide Seiten: die Vorschau zeichnet damit ins Canvas, der Export erzeugt daraus pro Bild
// perspective-Ecken und sendcmd-Befehle (gblur/dblur, rgbashift, Deckkraft, weiße Fläche).
import type { TransitionType } from './types';

export const DYNAMIC_TRANSITIONS = ['zoomthrough', 'whipleft', 'whipright', 'whipup', 'whipdown', 'spin', 'flash', 'shake', 'glitch'] as const;
export type DynamicTransition = typeof DYNAMIC_TRANSITIONS[number];

export function isDynamicTransition(type: TransitionType): type is DynamicTransition {
  return (DYNAMIC_TRANSITIONS as readonly string[]).includes(type);
}

/** Zustand einer Ebene (A = alter Clip, B = neuer Clip) während des Übergangs. */
export interface DynLayer {
  x: number;          // Verschiebung in % der Bildbreite
  y: number;          // in % der Bildhöhe
  scale: number;
  rotation: number;   // Grad
  blur: number;       // Unschärfe (Standardabweichung) in % der Bildhöhe
  blurDir: number | null;  // Richtung der Bewegungsunschärfe in Grad (null = rundum)
  alpha: number;      // Deckkraft 0..1
  shift: number;      // Farbversatz (Glitch) in % der Bildbreite, Rot nach rechts, Blau nach links
}

export interface DynFrame { a: DynLayer; b: DynLayer; flash: number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (e0: number, e1: number, x: number) => { const u = clamp01((x - e0) / (e1 - e0)); return u * u * (3 - 2 * u); };
const easeIn = (x: number) => { const u = clamp01(x); return u * u * u; };
const bell = (u: number, w: number) => Math.exp(-Math.pow((u - 0.5) / w, 2));

/** Deterministisches „Zufalls“-Rauschen −1..1 für Schritt q (gleich in Vorschau und Export). */
export function hashNoise(q: number, salt: number): number {
  const s = Math.sin(q * 127.1 + salt * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/**
 * Nötige Vergrößerung, damit eine gedrehte/verschobene Ebene das ganze Bild bedeckt (keine leeren Ecken).
 * x/y in %, Seitenverhältnis = Breite/Höhe.
 */
export function coverScale(rotation: number, x: number, y: number, aspect: number): number {
  const W = aspect, H = 1;
  const dx = (x / 100) * W, dy = (y / 100) * H;
  const r = (-rotation * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  let need = 1;
  for (const [px, py] of [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]]) {
    const qx = (px - dx) * c - (py - dy) * s;
    const qy = (px - dx) * s + (py - dy) * c;
    need = Math.max(need, Math.abs(qx) / (W / 2), Math.abs(qy) / (H / 2));
  }
  return need;
}

function layer(p: Partial<DynLayer> = {}): DynLayer {
  return { x: 0, y: 0, scale: 1, rotation: 0, blur: 0, blurDir: null, alpha: 1, shift: 0, ...p };
}

/**
 * Zustand zum Fortschritt u (0..1) eines Übergangs der Dauer `dur` (Sekunden) mit Stärke `intensity` (0..2).
 * `aspect` = Bildbreite / Bildhöhe (für das Abdecken bei Drehung/Verschiebung).
 */
export function dynTransitionAt(type: DynamicTransition, intensity: number, u: number, dur: number, aspect: number): DynFrame {
  const I = Math.max(0, Math.min(2, intensity));
  const vA = clamp01(u / 0.5);            // A: 0 → 1 bis zur Mitte
  const vB = clamp01((u - 0.5) / 0.5);    // B: 0 → 1 ab der Mitte
  const inB = 1 - vB;                     // B: 1 → 0
  let a = layer(), b = layer(), flash = 0;
  switch (type) {
    case 'zoomthrough': {
      const z = 1.5 * I;
      a = layer({ scale: 1 + z * easeIn(vA), blur: 1.6 * I * vA * vA });
      b = layer({ scale: 1 + z * inB * inB * inB, blur: 1.6 * I * inB * inB, alpha: smooth(0.4, 0.6, u) });
      break;
    }
    case 'whipleft': case 'whipright': case 'whipup': case 'whipdown': {
      const horiz = type === 'whipleft' || type === 'whipright';
      const dir = type === 'whipleft' || type === 'whipup' ? -1 : 1;
      const dist = 28 * I;
      const bl = 3 * I * bell(u, 0.2);
      const ang = horiz ? 0 : 90;
      const pa = dir * dist * easeIn(vA), pb = -dir * dist * inB * inB * inB;
      a = layer({ x: horiz ? pa : 0, y: horiz ? 0 : pa, blur: bl, blurDir: ang });
      b = layer({ x: horiz ? pb : 0, y: horiz ? 0 : pb, blur: bl, blurDir: ang, alpha: smooth(0.45, 0.55, u) });
      break;
    }
    case 'spin': {
      const ang = 150 * I;
      const bl = 1.0 * I * bell(u, 0.18);
      const bump = 1 + 0.15 * I * bell(u, 0.25);
      a = layer({ rotation: ang * easeIn(vA), blur: bl, scale: bump });
      b = layer({ rotation: -ang * inB * inB * inB, blur: bl, scale: bump, alpha: smooth(0.42, 0.58, u) });
      break;
    }
    case 'flash': {
      const w = 0.1 + 0.05 * I;
      flash = Math.min(1, 0.45 + 0.55 * I) * bell(u, w);
      a = layer({ scale: 1 + 0.06 * I * vA * vA });
      b = layer({ scale: 1 + 0.06 * I * inB * inB, alpha: smooth(0.49, 0.51, u) });
      break;
    }
    case 'shake': {
      const env = bell(u, 0.24);
      const q = Math.floor(u * dur * 24);
      const p = { x: 3 * I * env * hashNoise(q, 1), y: 2.5 * I * env * hashNoise(q, 2), rotation: 2 * I * env * hashNoise(q, 3), blur: 0.35 * I * env };
      a = layer(p);
      b = layer({ ...p, alpha: smooth(0.47, 0.53, u) });
      break;
    }
    case 'glitch': {
      const env = bell(u, 0.2);
      const q = Math.floor(u * dur * 15);
      const jump = hashNoise(q, 5) > 0.2 ? 1 : 0;
      const p = { x: 2.5 * I * env * jump * hashNoise(q, 6), shift: 1.8 * I * env * hashNoise(q, 7) };
      const flick = u < 0.35 ? 0 : u > 0.65 ? 1 : hashNoise(q, 8) > 0 ? 1 : 0;
      a = layer(p);
      b = layer({ ...p, alpha: flick });
      break;
    }
  }
  // Ecken immer abdecken (sonst sähe man bei Drehung/Verschiebung den Hintergrund)
  for (const l of [a, b]) l.scale *= coverScale(l.rotation, l.x, l.y, aspect);
  return { a, b, flash };
}
