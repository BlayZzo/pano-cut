// „Naht perfektionieren“: Versatz naher Dinge an der Naht über das ganze Video messen (Rechnung: shared/seamFlow.ts).
// Ergebnis: seam.bin im Medien-Cache (je Messung SEAM_BINS Bytes), Vorschau + Export lesen dieselbe Datei.
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import type { MediaItem, StitchSettings } from '@shared/types';
import { stitchKey } from '@shared/stitchModel';
import { panoMatrix } from '@shared/pano';
import { SEAM_BINS, seamAt, seamCosts, seamProbe, seamQuant, seamSmoothTime, seamSolve, seamTaper, shiftedDir, type SeamTrack } from '@shared/seamFlow';
import { pipeFfmpeg, streamFrames } from './ffmpeg';
import { fileExists, mediaCacheDir } from './paths';

const RATE = 5;          // Messungen pro Sekunde
const LW = 832;          // Linsenbild für die Messung (Pixel)

export interface SeamInfo { file: string; rate: number; start: number; frames: number; key: string }

export async function buildSeamTrack(item: MediaItem, onProgress: (p: number) => void): Promise<SeamInfo> {
  if (!item.stitch || item.stitch.mode === 'equirect') throw new Error('Kein 360°-Rohvideo');
  const comp = item.companion && fileExists(item.companion) ? item.companion : undefined;
  const src = comp ?? item.path;
  let graph: string;
  if (comp || item.stitch.mode === 'dualfisheye-sbs') {
    const swap = comp && item.companionSwap;
    graph = `[0:v:0]fps=${RATE},scale=${LW * 2}:${LW},format=gray` + (swap ? `,split[x][y];[x]crop=${LW}:${LW}:${LW}:0[l];[y]crop=${LW}:${LW}:0:0[r];[l][r]hstack[o]` : '[o]');
  } else {
    graph = `[0:v:0]fps=${RATE},scale=${LW}:${LW}[a];[0:v:1]fps=${RATE},scale=${LW}:${LW}[b];[a][b]hstack,format=gray[o]`;
  }
  const probe = seamProbe(item.stitch);
  const dur = Math.max(0.2, item.info.duration);
  const total = Math.max(1, Math.ceil(dur * RATE));
  const raw: Float32Array[] = [];
  let prev: Float32Array | null = null;
  const t0 = Date.now();
  await streamFrames(['-i', src, '-filter_complex', graph, '-map', '[o]', '-f', 'rawvideo', '-'], LW * 2 * LW, (data, i) => {
    const d = seamSolve(seamCosts(probe, { data, width: LW * 2, height: LW }), prev);
    prev = d;
    raw.push(d);
    if (i % 5 === 0) onProgress(Math.min(99, (100 * i) / total));
  });
  if (!raw.length) throw new Error('Keine Bilder lesbar');
  const smooth = seamSmoothTime(raw, 2);
  const out = new Uint8Array(smooth.length * SEAM_BINS);
  smooth.forEach((row, i) => { for (let k = 0; k < SEAM_BINS; k++) out[i * SEAM_BINS + k] = seamQuant(row[k]); });
  const file = path.join(mediaCacheDir(item.path), `seam_${stitchKey(item.stitch)}.bin`);
  fs.writeFileSync(file, out);
  log.info('Naht gemessen', item.name, { frames: smooth.length, ms: Date.now() - t0 });
  onProgress(100);
  return { file, rate: RATE, start: 0, frames: smooth.length, key: stitchKey(item.stitch) };
}

export function readSeamTrack(info: { file: string; rate: number; start: number; frames: number }): SeamTrack | null {
  try {
    const data = new Uint8Array(fs.readFileSync(info.file));
    return { rate: info.rate, start: info.start, frames: Math.min(info.frames, Math.floor(data.length / SEAM_BINS)), data };
  } catch { return null; }
}

/** Gilt die Messung noch (gleiche Zusammensetz-Einstellungen, Datei vorhanden)? */
export function seamUsable(item: MediaItem): boolean {
  return !!(item.seam?.enabled && item.stitch && item.seam.key === stitchKey(item.stitch) && fileExists(item.seam.file));
}

export const MAP_W = 256, MAP_H = 128, MAP_RATE = 10;

/**
 * Verschiebungskarten für FFmpeg `displace` (je Linse x und y) als FFV1-Video: ein yuv420p-Bild MAP_W × 4·MAP_H pro
 * 1/MAP_RATE s, untereinander x0, y0, x1, y1. Y = Versatz in Pixeln bei W×H, U/V = halber Versatz (Farbebenen sind halb so groß).
 */
export async function writeSeamMaps(track: SeamTrack, stitch: StitchSettings, from: number, duration: number, W: number, H: number, deep: boolean, file: string): Promise<string> {
  const n = Math.max(1, Math.ceil(duration * MAP_RATE) + 1);
  const G = panoMatrix(stitch.yaw, stitch.pitch, stitch.roll);
  const { t0, t1 } = seamTaper(stitch);
  const center = deep ? 512 : 128, lim = center - 1;
  const bps = deep ? 2 : 1;
  const planeY = MAP_W * 4 * MAP_H, planeC = (MAP_W / 2) * 2 * MAP_H;
  const pipe = pipeFfmpeg(['-f', 'rawvideo', '-pix_fmt', deep ? 'yuv420p10le' : 'yuv420p', '-s', `${MAP_W}x${4 * MAP_H}`, '-r', String(MAP_RATE), '-i', '-', '-c:v', 'ffv1', file]);
  const disp = new Uint8Array(SEAM_BINS);
  // Richtungen der Kartenpunkte (einmal)
  const dirAt = (x: number, y: number): [number, number, number] => {
    const lon = ((2 * (x + 0.5)) / W - 1) * Math.PI, lat = ((2 * (y + 0.5)) / H - 1) * (Math.PI / 2);
    return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
  };
  const offset = (v: [number, number, number], i: 0 | 1, X: number, Y: number): [number, number] => {
    const w = shiftedDir(v, i, G, disp, t0, t1);
    if (w === v) return [0, 0];
    const lon = Math.atan2(w[0], w[2]), lat = Math.asin(Math.max(-1, Math.min(1, w[1])));
    let dx = ((lon / Math.PI + 1) * W) / 2 - 0.5 - X;
    const dy = ((lat / (Math.PI / 2) + 1) * H) / 2 - 0.5 - Y;
    if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
    return [dx, dy];
  };
  const dirs: Array<[number, number, number]> = [], cdirs: Array<[number, number, number]> = [];
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) dirs.push(dirAt(((x + 0.5) * W) / MAP_W - 0.5, ((y + 0.5) * H) / MAP_H - 0.5));
  for (let y = 0; y < MAP_H / 2; y++) for (let x = 0; x < MAP_W / 2; x++) cdirs.push(dirAt(((x + 0.5) * W) / (MAP_W / 2) - 0.5, ((y + 0.5) * H) / (MAP_H / 2) - 0.5));
  try {
    for (let k = 0; k < n; k++) {
      seamAt(track, from + k / MAP_RATE, disp);
      const buf = new Uint8Array((planeY + 2 * planeC) * bps);
      const put = (idx: number, val: number) => {
        const q = Math.max(center - lim, Math.min(center + lim, Math.round(center + val)));
        if (deep) { buf[idx * 2] = q & 255; buf[idx * 2 + 1] = q >> 8; } else buf[idx] = q;
      };
      for (const lens of [0, 1] as const) {
        // Y-Ebene: 4 Karten untereinander (x0, y0, x1, y1)
        for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
          const X = ((x + 0.5) * W) / MAP_W - 0.5, Y = ((y + 0.5) * H) / MAP_H - 0.5;
          const o = offset(dirs[y * MAP_W + x], lens, X, Y);
          put((lens * 2 * MAP_H + y) * MAP_W + x, o[0]);
          put(((lens * 2 + 1) * MAP_H + y) * MAP_W + x, o[1]);
        }
        // U/V-Ebenen (halbe Größe): halber Versatz
        const cw = MAP_W / 2, ch = MAP_H / 2;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          const X = ((x + 0.5) * W) / cw - 0.5, Y = ((y + 0.5) * H) / ch - 0.5;
          const o = offset(cdirs[y * cw + x], lens, X, Y);
          for (const comp of [0, 1]) {
            const idx = ((lens * 2 + comp) * ch + y) * cw + x;
            put(planeY + idx, o[comp] / 2);
            put(planeY + planeC + idx, o[comp] / 2);
          }
        }
      }
      await pipe.write(buf);
    }
    await pipe.end();
  } catch (e) { pipe.kill(); throw e; }
  return file;
}
