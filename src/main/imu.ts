// Bewegungsdaten (Gyro) einer 360°-Kamera einmessen und in eine Lage-Spur umrechnen (nur auf Knopfdruck).
// 1) Achsen und Zeitversatz der Messdaten bestimmen: die Variante, mit der kleine Testbilder am ruhigsten werden.
// 2) Lage über die ganze Aufnahme: Gyro aufsummieren, Neigung über die Schwerkraft (Beschleunigung) nachführen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import type { MediaItem } from '@shared/types';
import { qmul, qnorm, qFromRotVec, qToMat, type Quat } from '@shared/stabilize';
import { readInstaImu, type InstaImu } from './insta360';
import { runFfmpeg } from './ffmpeg';
import { stitchChain } from './stitch';
import { mediaCacheDir, fileExists } from './paths';

const EW = 256, EH = 128, FPS = 10;

export interface ImuInfo { file: string; rate: number; start: number; samples: number; score: number; model: string; offset: number }

/** Kleine zusammengesetzte Graustufen-Panoramen (Kamera-Ausrichtung, ohne Grund-Drehung) für die Einmessung. */
async function calibFrames(item: MediaItem, seconds: number): Promise<Float32Array[]> {
  const st = { ...item.stitch!, yaw: 0, pitch: 0, roll: 0 };
  const comp = item.companion && fileExists(item.companion) ? item.companion : undefined;
  const src = comp ?? item.path;
  let pre = '', inputs: string[];
  if (comp) {
    inputs = ['[0:v:0]fps=10,'];
    if (item.companionSwap) { pre = '[0:v:0]fps=10,split[pa][pb];[pa]crop=iw/2:ih:0:0[pl];[pb]crop=iw/2:ih:iw/2:0[pr];[pr][pl]hstack[psw];'; inputs = ['[psw]']; }
  } else if (st.mode === 'dualfisheye-2streams') inputs = ['[0:v:0]fps=10,scale=480:480[ca];[0:v:1]fps=10,scale=480:480[cb];[ca]', '[cb]'];
  else inputs = ['[0:v:0]fps=10,'];
  const mode = comp ? { ...st, mode: 'dualfisheye-sbs' as const } : st;
  const chain = pre + stitchChain(mode, inputs, EW * 2, EH * 2) + `,scale=${EW}:${EH},format=gray[o]`;
  const out = path.join(os.tmpdir(), `panocut-calib-${process.pid}-${Date.now()}.gray`);
  try {
    await runFfmpeg(['-t', seconds.toFixed(2), '-i', src, '-filter_complex', chain, '-map', '[o]', '-f', 'rawvideo', out], { lowPriority: true });
    const buf = fs.readFileSync(out);
    const n = Math.floor(buf.length / (EW * EH));
    const frames: Float32Array[] = [];
    for (let k = 0; k < n; k++) frames.push(Float32Array.from(buf.subarray(k * EW * EH, (k + 1) * EW * EH)));
    return frames;
  } finally { fs.rm(out, { force: true }, () => undefined); }
}

/** Alle 24 echten Drehungen aus Achsen-Vertauschungen mit Vorzeichen (zeilenweise). */
function axisRotations(): number[][] {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const out: number[][] = [];
  for (const p of perms) for (let s = 0; s < 8; s++) {
    const m = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) m[r * 3 + p[r]] = (s >> r) & 1 ? -1 : 1;
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (det > 0) out.push(m);
  }
  return out;
}

const apply = (m: number[], x: number, y: number, z: number): [number, number, number] =>
  [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];

/** Lage (Kamera → Welt) zu den Zeitpunkten `times` (Videozeit), nur Gyro, ab Lage = Einheit. */
function integrate(imu: InstaImu, P: number[], sign: number, offset: number, times: number[]): Quat[] {
  const out: Quat[] = [];
  let q: Quat = [1, 0, 0, 0];
  let j = 0;
  const n = imu.t.length;
  for (const tv of times) {
    while (j < n - 1 && imu.t[j] + offset < tv) {
      const dt = imu.t[j + 1] - imu.t[j];
      const w = apply(P, imu.gyro[j * 3], imu.gyro[j * 3 + 1], imu.gyro[j * 3 + 2]);
      const k = (sign * Math.PI / 180) * dt;
      q = qnorm(qmul(q, qFromRotVec(w[0] * k, w[1] * k, w[2] * k)));
      j++;
    }
    out.push(q);
  }
  return out;
}

// Richtungen der Testbild-Pixel
const DIRS = (() => {
  const d = new Float32Array(EW * EH * 3);
  for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) {
    const lon = (((x + 0.5) / EW) * 2 - 1) * Math.PI, lat = (((y + 0.5) / EH) * 2 - 1) * (Math.PI / 2);
    const i = (y * EW + x) * 3;
    d[i] = Math.cos(lat) * Math.sin(lon); d[i + 1] = Math.sin(lat); d[i + 2] = Math.cos(lat) * Math.cos(lon);
  }
  return d;
})();

/** Bild in Weltausrichtung umrechnen: Welt-Richtung w → Kamera-Richtung Rᵀ·w. Nur der mittlere Breitenbereich. */
function stabilize(img: Float32Array, q: Quat, out: Float32Array): void {
  const R = qToMat(q);
  const y0 = Math.round(EH * 0.15), y1 = Math.round(EH * 0.85);
  for (let y = y0; y < y1; y++) for (let x = 0; x < EW; x++) {
    const i = (y * EW + x) * 3;
    const wx = DIRS[i], wy = DIRS[i + 1], wz = DIRS[i + 2];
    const cx = R[0] * wx + R[3] * wy + R[6] * wz, cy = R[1] * wx + R[4] * wy + R[7] * wz, cz = R[2] * wx + R[5] * wy + R[8] * wz;
    const lon = Math.atan2(cx, cz), lat = Math.asin(Math.max(-1, Math.min(1, cy)));
    const sx = Math.floor(((lon / Math.PI + 1) / 2) * EW) % EW, sy = Math.max(0, Math.min(EH - 1, Math.floor(((lat / (Math.PI / 2) + 1) / 2) * EH)));
    out[y * EW + x] = img[sy * EW + sx];
  }
}

function residual(frames: Float32Array[], qs: Quat[] | null): number {
  const a = new Float32Array(EW * EH), b = new Float32Array(EW * EH);
  const y0 = Math.round(EH * 0.15), y1 = Math.round(EH * 0.85);
  let s = 0, n = 0;
  for (let k = 0; k + 1 < frames.length; k++) {
    if (qs) { stabilize(frames[k], qs[k], a); stabilize(frames[k + 1], qs[k + 1], b); }
    const A = qs ? a : frames[k], B = qs ? b : frames[k + 1];
    for (let i = y0 * EW; i < y1 * EW; i += 2) { s += Math.abs(A[i] - B[i]); n++; }
  }
  return s / Math.max(1, n);
}

/** Lage über die ganze Aufnahme mit Schwerkraft-Nachführung (Horizont), abgetastet mit `rate`. */
function orientationTrack(imu: InstaImu, P: number[], sign: number, offset: number, rate: number): { start: number; q: Float32Array } {
  const n = imu.t.length;
  const up: [number, number, number] = [0, -1, 0];
  // Startlage: Beschleunigung (zeigt nach oben) der ersten 0,3 s auf „oben“ drehen
  let ax = 0, ay = 0, az = 0, m = 0;
  for (let i = 0; i < n && imu.t[i] - imu.t[0] < 0.3; i++) { const a = apply(P, imu.acc[i * 3], imu.acc[i * 3 + 1], imu.acc[i * 3 + 2]); ax += a[0]; ay += a[1]; az += a[2]; m++; }
  const an = Math.hypot(ax, ay, az) || 1; ax /= an; ay /= an; az /= an;
  const cr: [number, number, number] = [ay * up[2] - az * up[1], az * up[0] - ax * up[2], ax * up[1] - ay * up[0]];
  const ang = Math.acos(Math.max(-1, Math.min(1, ax * up[0] + ay * up[1] + az * up[2])));
  const cn = Math.hypot(...cr) || 1;
  let q: Quat = qFromRotVec((cr[0] / cn) * ang, (cr[1] / cn) * ang, (cr[2] / cn) * ang);
  const start = imu.t[0] + offset;
  const total = imu.t[n - 1] - imu.t[0];
  const count = Math.max(1, Math.floor(total * rate) + 1);
  const out = new Float32Array(count * 4);
  let next = 0;
  const GAIN = 0.0015;   // ≈ 0,7 s Zeitkonstante bei 1000 Werten/s
  for (let i = 0; i < n - 1 && next < count; i++) {
    const dt = imu.t[i + 1] - imu.t[i];
    if (!(dt > 0) || dt > 0.1) continue;
    const w = apply(P, imu.gyro[i * 3], imu.gyro[i * 3 + 1], imu.gyro[i * 3 + 2]);
    const k = (sign * Math.PI / 180) * dt;
    q = qnorm(qmul(q, qFromRotVec(w[0] * k, w[1] * k, w[2] * k)));
    // Schwerkraft: gemessenes „oben“ in Weltkoordinaten zu (0,−1,0) hinziehen (nur bei ruhiger Bewegung)
    const a = apply(P, imu.acc[i * 3], imu.acc[i * 3 + 1], imu.acc[i * 3 + 2]);
    const al = Math.hypot(a[0], a[1], a[2]);
    if (Math.abs(al - 1) < 0.15) {
      const R = qToMat(q);
      const u = [(R[0] * a[0] + R[1] * a[1] + R[2] * a[2]) / al, (R[3] * a[0] + R[4] * a[1] + R[5] * a[2]) / al, (R[6] * a[0] + R[7] * a[1] + R[8] * a[2]) / al];
      const e = [u[1] * up[2] - u[2] * up[1], u[2] * up[0] - u[0] * up[2], u[0] * up[1] - u[1] * up[0]];
      q = qnorm(qmul(qFromRotVec(e[0] * GAIN, e[1] * GAIN, e[2] * GAIN), q));
    }
    while (next < count && imu.t[i + 1] - imu.t[0] >= next / rate) { out.set(q, next * 4); next++; }
  }
  for (; next < count; next++) out.set(q, next * 4);
  return { start, q: out };
}

/** Bereits geprüfte Kameras: Achsen fest, nur der Zeitversatz wird gesucht (schneller). */
const KNOWN: Record<string, { P: number[]; sign: number }> = {
  'Insta360 X5': { P: [0, 0, -1, 1, 0, 0, 0, -1, 0], sign: 1 },
};

/** Bewegungsdaten einmessen und als Lage-Spur speichern (Cache). */
export async function buildImuTrack(item: MediaItem, onProgress: (p: number) => void = () => undefined): Promise<ImuInfo> {
  const imu = readInstaImu(item.path) ?? (item.companion ? readInstaImu(item.companion) : null);
  if (!imu || imu.t.length < 100) throw new Error('In dieser Datei sind keine Bewegungsdaten (nur Insta360-Kameras speichern sie).');
  onProgress(5);
  const frames = await calibFrames(item, Math.min(40, item.info.duration));
  if (frames.length < 6) throw new Error('Zu wenige Bilder zum Einmessen');
  onProgress(40);
  const times = frames.map((_, k) => k / FPS);
  const base = residual(frames, null);
  // 1) Achsen: bekannte Kamera → fest; sonst alle Varianten bei Versatz 0
  const cands: Array<{ P: number[]; sign: number; score: number }> = [];
  const known = KNOWN[imu.model];
  if (known) cands.push({ ...known, score: residual(frames, integrate(imu, known.P, known.sign, 0, times)) });
  else {
    const rots = axisRotations();
    let done = 0;
    for (const P of rots) for (const sign of [1, -1]) {
      cands.push({ P, sign, score: residual(frames, integrate(imu, P, sign, 0, times)) });
      onProgress(40 + (35 * ++done) / (rots.length * 2));
    }
    cands.sort((a, b) => a.score - b.score);
  }
  // 2) Zeitversatz für die besten drei
  let best = { ...cands[0], offset: 0 };
  for (const c of cands.slice(0, 3)) {
    for (let off = -0.15; off <= 0.1501; off += 0.01) {
      const s = residual(frames, integrate(imu, c.P, c.sign, off, times));
      if (s < best.score) best = { ...c, score: s, offset: off };
    }
  }
  for (let off = best.offset - 0.008; off <= best.offset + 0.0081; off += 0.002) {
    const s = residual(frames, integrate(imu, best.P, best.sign, off, times));
    if (s < best.score) best = { ...best, score: s, offset: off };
  }
  onProgress(90);
  const rate = 100;
  const tr = orientationTrack(imu, best.P, best.sign, best.offset, rate);
  const dir = mediaCacheDir(item.path);
  const file = path.join(dir, 'imu.bin');
  fs.writeFileSync(file, Buffer.from(tr.q.buffer, tr.q.byteOffset, tr.q.byteLength));
  const quality = base > 0 ? best.score / base : 1;
  log.info('Bewegungsdaten eingemessen', item.name, { model: imu.model, quality, offset: best.offset, P: best.P, sign: best.sign });
  onProgress(100);
  return { file, rate, start: tr.start, samples: tr.q.length / 4, score: quality, model: imu.model, offset: best.offset };
}

export function readImuFile(file: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(file));
}
