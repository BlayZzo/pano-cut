// 🫳 Stabilisierung mit den Bewegungsdaten der Kamera (Insta360-Gyro): Lage der Kamera über die Zeit (Quaternionen),
// daraus die Gegendrehung für die Ansicht. Modi wie in Insta360 Studio: „Folgen“ (FlowState: ruhig, folgt Schwenks),
// „Richtung fest“ (Blick bleibt in einer Richtung), jeweils mit „Horizont gerade“.
// Koordinaten wie v360/Vorschau: x rechts, y unten, z vorne; Welt-y = unten (Schwerkraft).
import type { StitchSettings } from './types';
import { panoMatrix } from './pano';
import { mul3 } from './stitchModel';

export type Quat = [number, number, number, number];   // w, x, y, z

export interface ImuTrack {
  rate: number;          // Werte pro Sekunde
  start: number;         // Videozeit des ersten Werts (s)
  q: Float32Array;       // Lage Kamera → Welt, je 4 Werte
}

export interface Stab360 {
  mode: 'off' | 'follow' | 'lock';
  smooth: number;        // Sekunden (Folgen: wie träge die Kamera Schwenken folgt)
  horizon: boolean;      // Horizont gerade halten
}

export const DEFAULT_STAB: Stab360 = { mode: 'follow', smooth: 1.0, horizon: true };

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function qnorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
export function qconj(q: Quat): Quat { return [q[0], -q[1], -q[2], -q[3]]; }
export function qFromRotVec(x: number, y: number, z: number): Quat {
  const th = Math.hypot(x, y, z);
  if (th < 1e-12) return [1, x / 2, y / 2, z / 2];
  const s = Math.sin(th / 2) / th;
  return [Math.cos(th / 2), x * s, y * s, z * s];
}
/** Zeilenweise 3×3-Drehmatrix */
export function qToMat(q: Quat): number[] {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
export function qRotate(q: Quat, v: [number, number, number]): [number, number, number] {
  const m = qToMat(q);
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function qslerp(a: Quat, b: Quat, u: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * u, a[1] + (bb[1] - a[1]) * u, a[2] + (bb[2] - a[2]) * u, a[3] + (bb[3] - a[3]) * u]);
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - u) * th) / s, kb = Math.sin(u * th) / s;
  return [a[0] * ka + bb[0] * kb, a[1] * ka + bb[1] * kb, a[2] * ka + bb[2] * kb, a[3] * ka + bb[3] * kb];
}

export function trackAt(tr: ImuTrack, t: number): Quat {
  const n = tr.q.length / 4;
  const x = (t - tr.start) * tr.rate;
  const i = Math.max(0, Math.min(n - 1, Math.floor(x)));
  const j = Math.min(n - 1, i + 1);
  const a: Quat = [tr.q[i * 4], tr.q[i * 4 + 1], tr.q[i * 4 + 2], tr.q[i * 4 + 3]];
  const b: Quat = [tr.q[j * 4], tr.q[j * 4 + 1], tr.q[j * 4 + 2], tr.q[j * 4 + 3]];
  return qslerp(a, b, Math.max(0, Math.min(1, x - i)));
}

/** Nur die Blickrichtung (Gier) einer Lage, Horizont gerade (Welt-y = unten). */
function headingOnly(q: Quat): Quat {
  const f = qRotate(q, [0, 0, 1]);
  const yaw = Math.atan2(f[0], f[2]);
  return [Math.cos(yaw / 2), 0, Math.sin(yaw / 2), 0];
}

/**
 * Ziel-Lage der virtuellen Kamera je Wert der Spur (gleiche Abtastung): Folgen = geglättete Lage (zentrierter Mittelwert),
 * Richtung fest = Lage am Anfang; „Horizont“ entfernt Neigen/Kippen.
 */
export function targetTrack(tr: ImuTrack, s: Stab360, from = 0): ImuTrack {
  const n = tr.q.length / 4;
  const out = new Float32Array(tr.q.length);
  const get = (i: number): Quat => [tr.q[i * 4], tr.q[i * 4 + 1], tr.q[i * 4 + 2], tr.q[i * 4 + 3]];
  const i0 = Math.max(0, Math.min(n - 1, Math.round((from - tr.start) * tr.rate)));
  if (s.mode === 'lock') {
    let q = get(i0);
    if (s.horizon) q = headingOnly(q);
    for (let i = 0; i < n; i++) out.set(q, i * 4);
    return { ...tr, q: out };
  }
  // Folgen: gleitender Mittelwert (zweimal = weiches Dreieck), Vorzeichen jeweils am Vorgänger ausgerichtet
  const w = Math.max(1, Math.round((s.smooth * tr.rate) / 2));
  const pass = (src: Float32Array): Float32Array => {
    const res = new Float32Array(src.length);
    const acc = [0, 0, 0, 0];
    const aligned = new Float32Array(src.length);
    let prev: Quat = [src[0], src[1], src[2], src[3]];
    for (let i = 0; i < n; i++) {
      let q: Quat = [src[i * 4], src[i * 4 + 1], src[i * 4 + 2], src[i * 4 + 3]];
      if (q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
      aligned.set(q, i * 4); prev = q;
    }
    // Präfixsummen für schnellen Fenster-Mittelwert
    const pre = new Float64Array((n + 1) * 4);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) pre[(i + 1) * 4 + k] = pre[i * 4 + k] + aligned[i * 4 + k];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n - 1, i + w);
      for (let k = 0; k < 4; k++) acc[k] = pre[(b + 1) * 4 + k] - pre[a * 4 + k];
      const q = qnorm([acc[0], acc[1], acc[2], acc[3]]);
      res.set(q, i * 4);
    }
    return res;
  };
  let sm = pass(pass(tr.q));
  if (s.horizon) {
    const lv = new Float32Array(sm.length);
    for (let i = 0; i < n; i++) lv.set(headingOnly([sm[i * 4], sm[i * 4 + 1], sm[i * 4 + 2], sm[i * 4 + 3]]), i * 4);
    sm = lv;
  }
  return { ...tr, q: sm };
}

function transpose(m: number[]): number[] { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }

/**
 * Gegendrehung für die Ansicht zur Videozeit t (zeilenweise, Blickrichtung → Richtung im zusammengesetzten Panorama):
 * S = Gᵀ · R(t)ᵀ · T(t) · G   (G = Grund-Ausrichtung beim Zusammensetzen)
 */
export function stabMatrixAt(raw: ImuTrack, target: ImuTrack, t: number, stitch?: StitchSettings): number[] {
  const R = qToMat(trackAt(raw, t)), T = qToMat(trackAt(target, t));
  let S = mul3(transpose(R), T);
  if (stitch && Math.abs(stitch.yaw) + Math.abs(stitch.pitch) + Math.abs(stitch.roll) > 1e-6) {
    const G = panoMatrix(stitch.yaw, stitch.pitch, stitch.roll);
    S = mul3(transpose(G), mul3(S, G));
  }
  return S;
}

export function stabActive(s?: Stab360): s is Stab360 {
  return !!s && s.mode !== 'off';
}
