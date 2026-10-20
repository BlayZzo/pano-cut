// 360°-Zusammensetzen mit zwei Fischaugen: EINE Mathematik für Vorschau (WebGL, panogl.ts) und Export (FFmpeg, stitch.ts).
// Pro Linse: Mittelpunkt/Größe des Bildkreises, kleine Drehkorrektur, Helligkeit/Farbe. Die Naht wird weich überblendet.
//
// Linse 0 = linke Bildhälfte bzw. erster Bildstrom = hintere Linse (schaut nach −z, gespiegelt),
// Linse 1 = rechte Hälfte bzw. zweiter Strom = vordere Linse (schaut nach +z) – wie FFmpeg v360 `input=dfisheye`.
import type { LensCalSettings, StitchSettings } from './types';
import { panoMatrix } from './pano';

/** Linsen-Kalibrierung (Werte siehe LensCalSettings in types.ts). */
export type LensCal = LensCalSettings;

export const DEFAULT_LENS: LensCal = { dx: 0, dy: 0, r: 1, yaw: 0, pitch: 0, roll: 0, gain: [1, 1, 1] };
export const DEFAULT_BLEND = 8;   // Grad – weiche Naht

export function lensCal(stitch: StitchSettings, i: 0 | 1): LensCal {
  return { ...DEFAULT_LENS, ...(stitch.lens?.[i] ?? {}) };
}

/** Breite der weichen Naht (Grad), begrenzt auf den Bereich, den beide Linsen sehen. */
export function blendWidth(stitch: StitchSettings): number {
  const b = stitch.blend ?? 0;
  return Math.max(0, Math.min(b, stitch.fov - 184));
}

/** Zeilenweise 3×3-Matrizen multiplizieren. */
export function mul3(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}

/** Gegenstück zu `panoMatrix`: Gier/Neigung/Rollen (Grad) einer Drehmatrix – für FFmpeg v360. */
export function eulerFromMatrix(m: number[]): { yaw: number; pitch: number; roll: number } {
  const d = 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[5])));
  return { yaw: Math.atan2(m[2], m[8]) * d, pitch: pitch * d, roll: Math.atan2(m[3], m[4]) * d };
}

export interface LensModel {
  matrix: number[];   // Blickrichtung (Ausgabe) → Linsen-Koordinaten (zeilenweise), wie v360 yaw/pitch/roll
  euler: { yaw: number; pitch: number; roll: number };
  ihFov: number;      // v360 ih_fov/iv_fov für das zugeschnittene Linsenbild
  crop: { x: number; y: number; w: number; h: number }; // Anteile des Linsenbilds (Mittelpunkt in die Mitte gerückt)
  gain: [number, number, number];
}

const BACK = panoMatrix(180, 0, 0);

/** Alle Werte für eine Linse. */
export function lensModel(stitch: StitchSettings, i: 0 | 1): LensModel {
  const cal = lensCal(stitch, i);
  const global = panoMatrix(stitch.yaw, stitch.pitch, stitch.roll);
  const base = i === 0 ? mul3(BACK, global) : global;
  const matrix = mul3(panoMatrix(cal.yaw, cal.pitch, cal.roll), base);
  const m = Math.min(0.2, Math.max(Math.abs(cal.dx), Math.abs(cal.dy)) + 0.002);
  const crop = { x: m + cal.dx, y: m + cal.dy, w: 1 - 2 * m, h: 1 - 2 * m };
  const r = Math.max(0.5, Math.min(1.5, cal.r));
  return { matrix, euler: eulerFromMatrix(matrix), ihFov: (stitch.fov * crop.w) / r, crop, gain: cal.gain };
}

/** Bis zu welchem Längengrad (vom Linsen-Mittelpunkt) jede Linse benutzt wird (Grad) – Naht + 2° Rand. */
export function coverHalf(stitch: StitchSettings): number {
  return 90 + blendWidth(stitch) / 2 + 2;
}

/** Gewicht der vorderen Linse (0..1) für eine Blickrichtung `u` NACH der Grund-Ausrichtung (wie Shader und geq). */
export function frontWeight(u: [number, number, number], blend: number, cover: number): number {
  const uz = u[2];
  const lon = Math.abs((Math.atan2(u[0], u[2]) * 180) / Math.PI);
  if (lon > cover) return 0;
  if (lon < 180 - cover) return 1;
  const s = (Math.asin(Math.max(-1, Math.min(1, uz))) * 180) / Math.PI;
  if (blend <= 0) return uz >= 0 ? 1 : 0;
  const x = Math.max(0, Math.min(1, (s + blend / 2) / blend));
  return x * x * (3 - 2 * x);
}

/** Wo im Linsenbild (0..1, bezogen aufs ganze Linsenbild) liegt die Richtung `v`? null = außerhalb. */
export function lensLookup(model: LensModel, v: [number, number, number]): [number, number] | null {
  const M = model.matrix;
  const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
  const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
  const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
  const h = Math.hypot(x, y);
  const lh = h > 0 ? h : 1;
  const phi = Math.atan2(h, z) / Math.PI;
  const k = 180 / model.ihFov;
  const uf = (x / lh) * phi * k, vf = (y / lh) * phi * k;
  if (!(uf > -0.5 && uf < 0.5 && vf > -0.5 && vf < 0.5)) return null;
  return [model.crop.x + (uf + 0.5) * model.crop.w, model.crop.y + (vf + 0.5) * model.crop.h];
}

/** Schlüssel für die Vorschau-Datei: ändert sich bei jeder Einstellung, die das Bild verändert. */
export function stitchKey(stitch: StitchSettings): string {
  const parts = [stitch.mode, stitch.fov, stitch.yaw, stitch.pitch, stitch.roll, blendWidth(stitch)];
  for (const i of [0, 1] as const) {
    const c = lensCal(stitch, i);
    parts.push(c.dx, c.dy, c.r, c.yaw, c.pitch, c.roll, ...c.gain);
  }
  const s = parts.map((p) => (typeof p === 'number' ? Math.round(p * 1e4) / 1e4 : p)).join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- Kameradaten (Insta360)

/**
 * Liest die Linsen-Kalibrierung aus dem Insta360-Datei-Anhang („offset“-Text), z. B.
 * `2_2654.126_2685.470_2686.170_-0.327_0.639_90.070_2641.275_8062.780_2698.140_0.569_0.516_90.621_10752_5376_113`
 * = Anzahl, je Linse Radius/Mitte x/Mitte y/3 Winkel, Gesamtbreite/-höhe. Die Linsen liegen nebeneinander.
 * Übernommen werden Mittelpunkt und Radius (sicher); die Winkel sind nur Startwerte für das Ausrichten.
 */
export function parseInstaOffset(text: string): Array<Pick<LensCal, 'dx' | 'dy' | 'r'>> | null {
  const re = /(?:^|[^0-9.])2_(\d+\.\d+)_(\d+\.\d+)_(\d+\.\d+)_(-?\d+\.\d+)_(-?\d+\.\d+)_(-?\d+\.\d+)_(\d+\.\d+)_(\d+\.\d+)_(\d+\.\d+)_(-?\d+\.\d+)_(-?\d+\.\d+)_(-?\d+\.\d+)_(\d+)_(\d+)/g;
  const ok = (l: { dx: number; dy: number; r: number }) => Math.abs(l.dx) < 0.1 && Math.abs(l.dy) < 0.1 && l.r > 0.7 && l.r < 1.3;
  for (const m of text.matchAll(re)) {
    const n = m.slice(1).map(Number);
    const W = n[12], H = n[13];
    const lw = W / 2;
    if (!(lw > 0 && H > 0) || Math.abs(lw - H) / H > 0.05) continue;
    const lens = (r: number, cx: number, cy: number, idx: number) => ({
      dx: (cx - idx * lw - lw / 2) / lw, dy: (cy - H / 2) / H, r: r / (lw / 2),
    });
    const a = lens(n[0], n[1], n[2], 0), b = lens(n[6], n[7], n[8], 1);
    if (ok(a) && ok(b)) return [a, b];
  }
  return null;
}

// ---------------------------------------------------------------- Automatisch ausrichten

/** Ein Bild beider Linsen nebeneinander (RGB, 8 Bit), z. B. 1024×512. */
export interface SbsFrame { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: 3 | 4 }

function sample(f: SbsFrame, lens: 0 | 1, u: number, v: number, out: number[]): void {
  const lw = f.width / 2;
  const x = Math.max(0, Math.min(lw - 1.001, u * (lw - 1))) + lens * lw;
  const y = Math.max(0, Math.min(f.height - 1.001, v * (f.height - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const c = f.channels;
  for (let k = 0; k < 3; k++) {
    const p = (yy: number, xx: number) => f.data[(yy * f.width + xx) * c + k];
    out[k] = (p(y0, x0) * (1 - fx) + p(y0, x0 + 1) * fx) * (1 - fy) + (p(y0 + 1, x0) * (1 - fx) + p(y0 + 1, x0 + 1) * fx) * fy;
  }
}

/** Abtastpunkte im Überlappungsstreifen (Richtungen nach der Grund-Ausrichtung = Weltrichtungen vor `global`). */
function bandDirections(stitch: StitchSettings, n = 720, rows = 9): Array<[number, number, number]> {
  const half = Math.max(1, (stitch.fov - 180) / 2 - 1);
  const ginv = transpose(panoMatrix(stitch.yaw, stitch.pitch, stitch.roll));
  const out: Array<[number, number, number]> = [];
  for (let r = 0; r < rows; r++) {
    const s = ((r / (rows - 1)) * 2 - 1) * half * (Math.PI / 180); // Höhe über der Nahtebene
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      // Richtung u (nach Grund-Ausrichtung): Nahtebene z = 0
      const u = [Math.cos(s) * Math.cos(a), Math.cos(s) * Math.sin(a), Math.sin(s)];
      // zurück in Ausgaberichtung v = Gᵀ·u (damit lensModel die Grund-Ausrichtung wieder anwendet)
      out.push([ginv[0] * u[0] + ginv[1] * u[1] + ginv[2] * u[2], ginv[3] * u[0] + ginv[4] * u[1] + ginv[5] * u[2], ginv[6] * u[0] + ginv[7] * u[1] + ginv[8] * u[2]]);
    }
  }
  return out;
}

function transpose(m: number[]): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Mittlerer Farbunterschied beider Linsen im Überlappungsstreifen (kleiner = bessere Naht). */
export function seamError(stitch: StitchSettings, frames: SbsFrame[], dirs = bandDirections(stitch), withGain = true): number {
  const m0 = lensModel(stitch, 0), m1 = lensModel(stitch, 1);
  const a = [0, 0, 0], b = [0, 0, 0];
  let sum = 0, n = 0;
  for (const f of frames) {
    for (const v of dirs) {
      const p0 = lensLookup(m0, v), p1 = lensLookup(m1, v);
      if (!p0 || !p1) continue;
      sample(f, 0, p0[0], p0[1], a);
      sample(f, 1, p1[0], p1[1], b);
      for (let k = 0; k < 3; k++) {
        const ga = withGain ? m0.gain[k] : 1, gb = withGain ? m1.gain[k] : 1;
        sum += Math.abs(a[k] * ga - b[k] * gb);
      }
      n++;
    }
  }
  return n > dirs.length * frames.length * 0.3 ? sum / (n * 3) : 1e9;
}

/** Farbe/Helligkeit beider Linsen im Überlappungsstreifen angleichen (beide treffen sich in der Mitte). */
export function matchGains(stitch: StitchSettings, frames: SbsFrame[]): [[number, number, number], [number, number, number]] {
  const mm0 = lensModel(stitch, 0), mm1 = lensModel(stitch, 1);
  const dirs = bandDirections(stitch);
  const sa = [0, 0, 0], sb = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
  for (const f of frames) for (const v of dirs) {
    const p0 = lensLookup(mm0, v), p1 = lensLookup(mm1, v);
    if (!p0 || !p1) continue;
    sample(f, 0, p0[0], p0[1], a); sample(f, 1, p1[0], p1[1], b);
    for (let k = 0; k < 3; k++) { sa[k] += a[k]; sb[k] += b[k]; }
  }
  const g0: [number, number, number] = [1, 1, 1], g1: [number, number, number] = [1, 1, 1];
  for (let k = 0; k < 3; k++) {
    if (sa[k] < 1 || sb[k] < 1) continue;
    const ratio = Math.max(0.6, Math.min(1.6, sb[k] / sa[k]));
    g0[k] = Math.sqrt(ratio);
    g1[k] = 1 / Math.sqrt(ratio);
  }
  return [g0, g1];
}

/**
 * Naht automatisch ausrichten: Sichtfeld und Drehkorrektur der vorderen Linse so wählen, dass beide Linsen im
 * Überlappungsstreifen möglichst dasselbe zeigen; danach Farbe/Helligkeit angleichen.
 */
export function autoAlign(start: StitchSettings, frames: SbsFrame[]): { stitch: StitchSettings; before: number; after: number } {
  let s: StitchSettings = { ...start, lens: [lensCal(start, 0), lensCal(start, 1)] };
  const err = (x: StitchSettings) => seamError(x, frames, bandDirections(x, 360, 7), false);
  const before = err(s);
  let best = before;
  type P = { get: (x: StitchSettings) => number; set: (x: StitchSettings, v: number) => StitchSettings; step: number; min: number; max: number };
  const lensSet = (key: 'yaw' | 'pitch' | 'roll') => ({
    get: (x: StitchSettings) => lensCal(x, 1)[key],
    set: (x: StitchSettings, v: number) => ({ ...x, lens: [lensCal(x, 0), { ...lensCal(x, 1), [key]: v }] as [LensCal, LensCal] }),
    step: 1, min: -6, max: 6,
  });
  const params: P[] = [
    { get: (x) => x.fov, set: (x, v) => ({ ...x, fov: v }), step: 4, min: 180, max: 225 },
    lensSet('yaw'), lensSet('pitch'), lensSet('roll'),
  ];
  for (let round = 0; round < 6; round++) {
    for (const p of params) {
      for (let tries = 0; tries < 12; tries++) {
        let improved = false;
        for (const dir of [1, -1]) {
          const v = p.get(s) + dir * p.step;
          if (v < p.min || v > p.max) continue;
          const cand = p.set(s, v);
          const e = err(cand);
          if (e < best - 1e-4) { best = e; s = cand; improved = true; break; }
        }
        if (!improved) break;
      }
      p.step /= 2;
    }
  }
  const [g0, g1] = matchGains(s, frames);
  s = { ...s, lens: [{ ...lensCal(s, 0), gain: g0 }, { ...lensCal(s, 1), gain: g1 }] };
  return { stitch: s, before, after: best };
}
