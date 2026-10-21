// Bewegte Naht („Naht perfektionieren“): Nahe Dinge stehen in beiden Linsen leicht versetzt (die Linsen sitzen ein paar
// Zentimeter auseinander). Pro Stelle entlang der Naht wird dieser Versatz gemessen (quer zur Naht, in Grad) und beide
// Linsen werden dort je zur Hälfte aufeinander zu verschoben – wie das dynamische Stitching von Insta360 Studio.
// EINE Mathematik für Vorschau (panogl.ts: Textur uDisp) und Export (stitch.ts: displace mit Verschiebungskarten).
//
// Koordinaten: u = G·v (Richtung nach der Grund-Ausrichtung), Naht = Ebene u.z = 0.
// s = asin(u.z) = Abstand quer zur Naht, a = atan2(u.y, u.x) = Stelle entlang der Naht.
import type { StitchSettings } from './types';
import { lensLookup, lensModel, type LensModel, type SbsFrame } from './stitchModel';
import { panoMatrix } from './pano';

export const SEAM_BINS = 64;      // Stellen entlang der Naht (je 5,6°)
export const SEAM_MAX = 8;        // größter Versatz ±8°
const DEG = Math.PI / 180;

export interface SeamTrack { rate: number; start: number; frames: number; data: Uint8Array }

/** Versatz (Grad) → Byte (so steht er auch in der Vorschau-Textur). */
export function seamQuant(d: number): number {
  return Math.max(0, Math.min(255, Math.round(((d + SEAM_MAX) / (2 * SEAM_MAX)) * 255)));
}
export function seamDeq(b: number): number {
  return (b / 255) * 2 * SEAM_MAX - SEAM_MAX;
}

/** Versatz-Werte (Bytes, SEAM_BINS Stück) zur Dateizeit t – linear zwischen den Messungen. */
export function seamAt(tr: SeamTrack, t: number, out = new Uint8Array(SEAM_BINS)): Uint8Array {
  const x = Math.max(0, Math.min(tr.frames - 1, (t - tr.start) * tr.rate));
  const i0 = Math.floor(x), i1 = Math.min(tr.frames - 1, i0 + 1), f = x - i0;
  for (let k = 0; k < SEAM_BINS; k++) out[k] = Math.round(tr.data[i0 * SEAM_BINS + k] * (1 - f) + tr.data[i1 * SEAM_BINS + k] * f);
  return out;
}

/** Bereich der Verschiebung: voll bis t0 (Überlappung), weich auslaufend bis t1 (Grad). */
export function seamTaper(stitch: StitchSettings): { t0: number; t1: number } {
  const t0 = Math.max(1, (stitch.fov - 180) / 2);
  return { t0, t1: t0 + 10 };
}

export function taperAt(sDeg: number, t0: number, t1: number): number {
  const x = Math.max(0, Math.min(1, (t1 - Math.abs(sDeg)) / (t1 - t0)));
  return x * x * (3 - 2 * x);
}

/** Versatz (Grad) an der Nahtstelle a (Bogenmaß) – wie die Textur mit LINEAR + REPEAT. */
export function dispAtAngle(disp: Uint8Array, a: number): number {
  let x = (a / (2 * Math.PI) + 0.5) * SEAM_BINS - 0.5;
  x = ((x % SEAM_BINS) + SEAM_BINS) % SEAM_BINS;
  const i0 = Math.floor(x), i1 = (i0 + 1) % SEAM_BINS, f = x - i0;
  return seamDeq(disp[i0] * (1 - f) + disp[i1] * f);
}

/** Blickrichtung v (Ausgabe) → verschobene Richtung für Linse i (0 = hinten: −, 1 = vorne: +). */
export function shiftedDir(v: [number, number, number], i: 0 | 1, G: number[], disp: Uint8Array, t0: number, t1: number): [number, number, number] {
  const ux = G[0] * v[0] + G[1] * v[1] + G[2] * v[2];
  const uy = G[3] * v[0] + G[4] * v[1] + G[5] * v[2];
  const uz = G[6] * v[0] + G[7] * v[1] + G[8] * v[2];
  const s = Math.asin(Math.max(-1, Math.min(1, uz)));
  const tp = taperAt(s / DEG, t0, t1);
  if (tp <= 0) return v;
  const a = Math.atan2(uy, ux);
  const d = (i === 1 ? 0.5 : -0.5) * dispAtAngle(disp, a) * tp * DEG;
  const s2 = s + d;
  const c = Math.cos(s2);
  const u2 = [c * Math.cos(a), c * Math.sin(a), Math.sin(s2)];
  // v' = Gᵀ·u'
  return [G[0] * u2[0] + G[3] * u2[1] + G[6] * u2[2], G[1] * u2[0] + G[4] * u2[1] + G[7] * u2[2], G[2] * u2[0] + G[5] * u2[1] + G[8] * u2[2]];
}

export function seamGlobal(stitch: StitchSettings): number[] {
  return panoMatrix(stitch.yaw, stitch.pitch, stitch.roll);
}

// ---------------------------------------------------------------- Messen

/** Graustufenbild beider Linsen nebeneinander (Linse 0 links). */
export interface GrayFrame { data: Uint8Array; width: number; height: number }

function sampleGray(f: GrayFrame, lens: 0 | 1, p: [number, number]): number {
  const lw = f.width / 2;
  const x = Math.max(0, Math.min(lw - 1.001, p[0] * (lw - 1))) + lens * lw;
  const y = Math.max(0, Math.min(f.height - 1.001, p[1] * (f.height - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const w = f.width, d = f.data;
  const i = y0 * w + x0;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}

const STEP = 0.25;                 // Grad zwischen den Versatz-Kandidaten
const NCAND = Math.round((2 * SEAM_MAX) / STEP) + 1;
const ACOLS = 5;                   // Spalten pro Nahtstelle

export interface SeamProbe {
  stitch: StitchSettings;
  m0: LensModel; m1: LensModel; G: number[];
  sStep: number; sHalf: number; rows: number[];   // Spalten-Abtastung quer zur Naht
  dirs: Array<Array<Array<[number, number, number]>>>; // [bin][col][sIndex]
}

/** Abtast-Richtungen einmal vorbereiten (hängt nur von den Zusammensetz-Einstellungen ab). */
export function seamProbe(stitch: StitchSettings): SeamProbe {
  const m0 = lensModel(stitch, 0), m1 = lensModel(stitch, 1);
  const G = seamGlobal(stitch);
  const { t0 } = seamTaper(stitch);
  const sStep = 0.125;
  const sHalf = t0 * 0.8 + SEAM_MAX / 2 + 0.5;
  const n = Math.round((2 * sHalf) / sStep) + 1;
  const dirs: SeamProbe['dirs'] = [];
  for (let k = 0; k < SEAM_BINS; k++) {
    const cols: Array<Array<[number, number, number]>> = [];
    for (let j = 0; j < ACOLS; j++) {
      const a = (-Math.PI + ((k + 0.5) / SEAM_BINS) * 2 * Math.PI) + ((j - (ACOLS - 1) / 2) / ACOLS) * ((2 * Math.PI) / SEAM_BINS);
      const col: Array<[number, number, number]> = [];
      for (let q = 0; q < n; q++) {
        const s = (-sHalf + q * sStep) * DEG;
        const u = [Math.cos(s) * Math.cos(a), Math.cos(s) * Math.sin(a), Math.sin(s)];
        col.push([G[0] * u[0] + G[3] * u[1] + G[6] * u[2], G[1] * u[0] + G[4] * u[1] + G[7] * u[2], G[2] * u[0] + G[5] * u[1] + G[8] * u[2]]);
      }
      cols.push(col);
    }
    dirs.push(cols);
  }
  // Vergleichszeilen (Grad quer zur Naht) innerhalb der Überlappung
  const rows: number[] = [];
  for (let s = -t0 * 0.8; s <= t0 * 0.8 + 1e-6; s += 0.5) rows.push(s);
  return { stitch, m0, m1, G, sStep, sHalf, rows, dirs };
}

/** Kosten je Nahtstelle und Kandidat (0 = gleich, 1 = unähnlich); Zeilen = Bins, Spalten = Kandidaten. */
export function seamCosts(p: SeamProbe, f: GrayFrame): Float32Array {
  const n = p.dirs[0][0].length;
  const costs = new Float32Array(SEAM_BINS * NCAND);
  const c0 = new Float32Array(n), c1 = new Float32Array(n);
  const v0 = new Uint8Array(n), v1 = new Uint8Array(n);
  const A = new Float32Array(p.rows.length * ACOLS), B = new Float32Array(p.rows.length * ACOLS);
  const cols0: Float32Array[] = [], cols1: Float32Array[] = [], ok0: Uint8Array[] = [], ok1: Uint8Array[] = [];
  for (let k = 0; k < SEAM_BINS; k++) {
    cols0.length = cols1.length = ok0.length = ok1.length = 0;
    for (let j = 0; j < ACOLS; j++) {
      const col = p.dirs[k][j];
      for (let q = 0; q < n; q++) {
        const l0 = lensLookup(p.m0, col[q]), l1 = lensLookup(p.m1, col[q]);
        v0[q] = l0 ? 1 : 0; v1[q] = l1 ? 1 : 0;
        c0[q] = l0 ? sampleGray(f, 0, l0) : 0;
        c1[q] = l1 ? sampleGray(f, 1, l1) : 0;
      }
      cols0.push(c0.slice()); cols1.push(c1.slice()); ok0.push(v0.slice()); ok1.push(v1.slice());
    }
    for (let ci = 0; ci < NCAND; ci++) {
      const d = -SEAM_MAX + ci * STEP;
      let m = 0, valid = true;
      for (let r = 0; r < p.rows.length && valid; r++) {
        // hintere Linse bei s − d/2, vordere bei s + d/2
        const q0 = Math.round((p.rows[r] - d / 2 + p.sHalf) / p.sStep);
        const q1 = Math.round((p.rows[r] + d / 2 + p.sHalf) / p.sStep);
        for (let j = 0; j < ACOLS; j++) {
          if (q0 < 0 || q0 >= n || q1 < 0 || q1 >= n || !ok0[j][q0] || !ok1[j][q1]) { valid = false; break; }
          A[m] = cols0[j][q0]; B[m] = cols1[j][q1]; m++;
        }
      }
      let cost = 1;
      if (valid && m > 4) {
        let sa = 0, sb = 0;
        for (let i = 0; i < m; i++) { sa += A[i]; sb += B[i]; }
        sa /= m; sb /= m;
        let ab = 0, aa = 0, bb = 0;
        for (let i = 0; i < m; i++) { const x = A[i] - sa, y = B[i] - sb; ab += x * y; aa += x * x; bb += y * y; }
        const tex = Math.min(aa, bb) / m;
        // wenig Struktur (Himmel, Wand): keine Aussage
        cost = tex < 6 ? 0.5 : 1 - ab / Math.sqrt(aa * bb + 1e-6);
      }
      costs[k * NCAND + ci] = cost;
    }
  }
  return costs;
}

/**
 * Glatter Versatz entlang der Naht: Kosten + Sprünge zwischen Nachbarstellen + Nähe zum vorigen Bild (zeitlich ruhig)
 * + leichter Zug zu 0 (weit weg). Ringförmig: zwei Runden, die zweite zählt.
 */
export function seamSolve(costs: Float32Array, prev: Float32Array | null): Float32Array {
  const smooth = 0.03, tempo = 0.04, prior = 0.004;
  const N = SEAM_BINS, C = NCAND;
  const unary = new Float32Array(N * C);
  for (let k = 0; k < N; k++) for (let c = 0; c < C; c++) {
    const d = -SEAM_MAX + c * STEP;
    unary[k * C + c] = costs[k * C + c] + prior * Math.abs(d) + (prev ? tempo * Math.min(4, Math.abs(d - prev[k])) : 0);
  }
  const laps = 2 * N;
  let acc = new Float32Array(C);
  const back = new Int16Array(laps * C);
  for (let c = 0; c < C; c++) acc[c] = unary[c];
  for (let step = 1; step < laps; step++) {
    const k = step % N;
    const next = new Float32Array(C);
    // großer Sprung (Kante zwischen nah und fern)
    let far = Infinity, farArg = 0;
    for (let pc = 0; pc < C; pc++) if (acc[pc] < far) { far = acc[pc]; farArg = pc; }
    for (let c = 0; c < C; c++) {
      let best = Infinity, arg = 0;
      for (let pc = Math.max(0, c - 8); pc <= Math.min(C - 1, c + 8); pc++) {
        const v = acc[pc] + smooth * Math.abs(pc - c);
        if (v < best) { best = v; arg = pc; }
      }
      if (far + smooth * 10 < best) { best = far + smooth * 10; arg = farArg; }
      next[c] = best + unary[k * C + c];
      back[step * C + c] = arg;
    }
    acc = next;
  }
  let c = 0;
  for (let i = 1; i < C; i++) if (acc[i] < acc[c]) c = i;
  const out = new Float32Array(N);
  for (let step = laps - 1; step >= N; step--) {
    out[step % N] = -SEAM_MAX + c * STEP;
    c = back[step * C + c];
  }
  return out;
}

/** Zeitlich glätten (Median gegen Ausreißer, dann Mittelwert) – je Nahtstelle. */
export function seamSmoothTime(rows: Float32Array[], radius = 2): Float32Array[] {
  const n = rows.length;
  const med = rows.map((_, i) => {
    const o = new Float32Array(SEAM_BINS);
    for (let k = 0; k < SEAM_BINS; k++) {
      const w: number[] = [];
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) w.push(rows[j][k]);
      w.sort((x, y) => x - y);
      o[k] = w[w.length >> 1];
    }
    return o;
  });
  return med.map((_, i) => {
    const o = new Float32Array(SEAM_BINS);
    for (let k = 0; k < SEAM_BINS; k++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) { const wt = radius + 1 - Math.abs(j - i); s += med[j][k] * wt; c += wt; }
      o[k] = s / c;
    }
    return o;
  });
}

/** Mittlerer Unterschied beider Linsen in der Überlappung mit Versatz (zum Prüfen: kleiner = bessere Naht). */
export function seamDiff(stitch: StitchSettings, f: GrayFrame, disp: Uint8Array): number {
  const m0 = lensModel(stitch, 0), m1 = lensModel(stitch, 1);
  const G = seamGlobal(stitch);
  const { t0, t1 } = seamTaper(stitch);
  let sum = 0, n = 0;
  for (let k = 0; k < 720; k++) {
    const a = (k / 720) * 2 * Math.PI - Math.PI;
    for (let s = -t0 * 0.5; s <= t0 * 0.5; s += 0.5) {
      const sr = s * DEG;
      const u = [Math.cos(sr) * Math.cos(a), Math.cos(sr) * Math.sin(a), Math.sin(sr)];
      const v: [number, number, number] = [G[0] * u[0] + G[3] * u[1] + G[6] * u[2], G[1] * u[0] + G[4] * u[1] + G[7] * u[2], G[2] * u[0] + G[5] * u[1] + G[8] * u[2]];
      const l0 = lensLookup(m0, shiftedDir(v, 0, G, disp, t0, t1)), l1 = lensLookup(m1, shiftedDir(v, 1, G, disp, t0, t1));
      if (!l0 || !l1) continue;
      sum += Math.abs(sampleGray(f, 0, l0) * m0.gain[1] - sampleGray(f, 1, l1) * m1.gain[1]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

export type { SbsFrame };
