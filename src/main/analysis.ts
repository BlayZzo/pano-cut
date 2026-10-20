// Analysen auf Knopfdruck: Bewegung im Bild (Hook-Finder), Pausen im Ton und unscharfe/verwackelte Stellen (Grobschnitt).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { availableFilters, runFfmpeg } from './ffmpeg';

function tmp(name: string): string {
  return path.join(os.tmpdir(), `panocut-an-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${name}`);
}

/** Bewegung über die Zeit: mittlerer Helligkeitsunterschied aufeinanderfolgender Bilder (0..1), `rate` Werte pro Sekunde. */
export async function motionCurve(file: string, start: number, duration: number, rate = 4): Promise<{ values: number[]; hop: number }> {
  const out = tmp('motion.gray');
  const W = 64, H = 36;
  try {
    await runFfmpeg(['-ss', start.toFixed(3), '-t', Math.max(0.1, duration).toFixed(3), '-i', file, '-an',
      '-vf', `fps=${rate},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', out], { lowPriority: true });
    const buf = fs.readFileSync(out);
    const n = Math.floor(buf.length / (W * H));
    const values: number[] = [];
    for (let f = 0; f < n; f++) {
      if (f === 0) { values.push(0); continue; }
      let s = 0;
      const a = (f - 1) * W * H, b = f * W * H;
      for (let i = 0; i < W * H; i++) s += Math.abs(buf[b + i] - buf[a + i]);
      values.push(s / (W * H * 255));
    }
    if (values.length > 1) values[0] = values[1];
    return { values, hop: 1 / rate };
  } finally {
    fs.rm(out, { force: true }, () => undefined);
  }
}

/** Leise Stellen (Pausen) im Ton: [start, end] relativ zu `start`. */
export async function silences(file: string, start: number, duration: number, thresholdDb = -38, minDur = 0.6): Promise<Array<{ start: number; end: number }>> {
  const log = await runFfmpeg(['-ss', start.toFixed(3), '-t', Math.max(0.1, duration).toFixed(3), '-i', file, '-vn',
    '-af', `silencedetect=n=${thresholdDb}dB:d=${Math.max(0.1, minDur)}`, '-f', 'null', '-'], { lowPriority: true });
  const out: Array<{ start: number; end: number }> = [];
  let s: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    if (a) s = Math.max(0, parseFloat(a[1]));
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (b && s !== null) { out.push({ start: s, end: parseFloat(b[1]) }); s = null; }
  }
  if (s !== null) out.push({ start: s, end: duration });
  return out;
}

/** Unschärfe über die Zeit (größer = unschärfer), `rate` Werte pro Sekunde. Fehlt der Filter, wird [] geliefert. */
export async function blurCurve(file: string, start: number, duration: number, rate = 2): Promise<{ values: number[]; hop: number }> {
  const filters = await availableFilters();
  if (!filters.has('blurdetect')) return { values: [], hop: 1 / rate };
  const meta = tmp('blur.txt');
  try {
    await runFfmpeg(['-ss', start.toFixed(3), '-t', Math.max(0.1, duration).toFixed(3), '-i', file, '-an',
      '-vf', `fps=${rate},scale=480:-2,blurdetect=block_width=32:block_height=32,metadata=mode=print:file='${meta.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`, '-f', 'null', '-'], { lowPriority: true });
    const txt = fs.existsSync(meta) ? fs.readFileSync(meta, 'utf8') : '';
    const values = [...txt.matchAll(/lavfi\.blur=([\d.]+)/g)].map((m) => parseFloat(m[1]));
    return { values, hop: 1 / rate };
  } finally {
    fs.rm(meta, { force: true }, () => undefined);
  }
}

/**
 * Bewegungsverlauf nur aus den Schlüsselbildern (sehr schnell, auch bei langen 4K/8K-Dateien): Unterschied zwischen
 * aufeinanderfolgenden Schlüsselbildern, mit deren Zeitpunkten (Dateizeit, Sekunden).
 */
export async function activityCurve(file: string, start = 0, duration = 0, dense = 0): Promise<{ times: number[]; values: number[] }> {
  const out = tmp('act.gray');
  const W = 48, H = 27;
  try {
    // dense > 0: alle Bilder dekodieren, `dense` Werte pro Sekunde (genauer, für kurze Dateien); sonst nur Schlüsselbilder
    const args = dense > 0 ? [] : ['-skip_frame', 'nokey'];
    if (start > 0) args.push('-ss', start.toFixed(3));
    if (duration > 0) args.push('-t', duration.toFixed(3));
    args.push('-i', file, '-an', '-map', '0:v:0', '-vf', `${dense > 0 ? `fps=${dense},` : ''}scale=${W}:${H}:flags=area,format=gray,showinfo`, '-fps_mode', 'passthrough', '-f', 'rawvideo', out);
    const log = await runFfmpeg(args, { lowPriority: true });
    const times = [...log.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]) + start);
    const buf = fs.readFileSync(out);
    const n = Math.min(times.length, Math.floor(buf.length / (W * H)));
    const values: number[] = [];
    for (let f = 0; f < n; f++) {
      if (f === 0) { values.push(0); continue; }
      let s = 0;
      const a = (f - 1) * W * H, b = f * W * H;
      for (let i = 0; i < W * H; i++) s += Math.abs(buf[b + i] - buf[a + i]);
      // pro Sekunde Abstand, damit unregelmäßige Schlüsselbild-Abstände nicht stören
      values.push(s / (W * H * 255) / Math.max(0.2, times[f] - times[f - 1]));
    }
    if (values.length > 1) values[0] = values[1];
    return { times: times.slice(0, n), values };
  } finally {
    fs.rm(out, { force: true }, () => undefined);
  }
}
