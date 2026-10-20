// „Naht automatisch ausrichten“ (nur auf Knopfdruck): Kameradaten (Insta360) lesen, einige Bilder beider Linsen holen,
// Sichtfeld/Drehung/Farbe so wählen, dass die Naht möglichst unsichtbar wird (Rechnung: shared/stitchModel.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import type { MediaItem, StitchSettings } from '@shared/types';
import { autoAlign, DEFAULT_BLEND, parseInstaOffset, type SbsFrame } from '@shared/stitchModel';
import { runFfmpeg } from './ffmpeg';

/** Linsen-Kalibrierung aus dem Datei-Ende (Insta360 schreibt sie in einen Anhang am Schluss der Datei). */
export function readCameraCalibration(file: string): ReturnType<typeof parseInstaOffset> {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 6_000_000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return parseInstaOffset(buf.toString('latin1'));
  } catch (e) {
    log.warn('Kameradaten nicht lesbar', (e as Error).message);
    return null;
  }
}

async function grabSbs(item: MediaItem, t: number, W: number, H: number): Promise<SbsFrame | null> {
  const out = path.join(os.tmpdir(), `panocut-sbs-${process.pid}-${Date.now()}-${Math.round(t * 1000)}.rgb`);
  try {
    const two = item.stitch?.mode === 'dualfisheye-2streams';
    const graph = two ? `[0:v:0][0:v:1]hstack,scale=${W}:${H}:flags=area,format=rgb24[o]` : `[0:v:0]scale=${W}:${H}:flags=area,format=rgb24[o]`;
    await runFfmpeg(['-ss', t.toFixed(3), '-i', item.path, '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', out], { lowPriority: true });
    const data = new Uint8Array(fs.readFileSync(out));
    return data.length >= W * H * 3 ? { data, width: W, height: H, channels: 3 } : null;
  } catch (e) {
    log.warn('Bild für Naht-Ausrichtung fehlgeschlagen', (e as Error).message);
    return null;
  } finally {
    fs.rm(out, { force: true }, () => undefined);
  }
}

export interface AutoStitchResult { stitch: StitchSettings; before: number; after: number; camera: boolean }

export async function autoAlignStitch(item: MediaItem): Promise<AutoStitchResult> {
  if (!item.stitch || item.stitch.mode === 'equirect') throw new Error('Kein 360°-Rohvideo');
  const cal = readCameraCalibration(item.path) ?? (item.companion ? readCameraCalibration(item.companion) : null);
  const dur = Math.max(0.1, item.info.duration);
  const times = dur < 1.5 ? [dur / 2] : [0.2, 0.5, 0.8].map((f) => f * dur);
  const frames = (await Promise.all(times.map((t) => grabSbs(item, t, 1024, 512)))).filter((f): f is SbsFrame => !!f);
  if (!frames.length) throw new Error('Kein Bild lesbar');
  const start: StitchSettings = {
    ...item.stitch,
    blend: item.stitch.blend ?? DEFAULT_BLEND,
    // Mittelpunkt/Größe aus den Kameradaten, Drehung/Farbe werden neu gesucht
    lens: cal ? [{ ...cal[0] }, { ...cal[1] }] : undefined,
  };
  const r = autoAlign(start, frames);
  log.info('Naht ausgerichtet', item.name, { before: r.before, after: r.after, camera: !!cal, fov: r.stitch.fov });
  return { stitch: { ...r.stitch, calibrated: cal ? 'camera+auto' : 'auto' }, before: r.before, after: r.after, camera: !!cal };
}
