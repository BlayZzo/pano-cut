// KI im Renderer: Einzelbilder holen, Objekte erkennen, über die Zeit verfolgen, Masken berechnen.
import type { AiDetectModel, AiSegmentModel, Clip, Detection, MediaItem, ObjectTrack, TrackBox } from '@shared/types';
import { clipDuration, makeId } from '@shared/timeline';
import { TRACK_COLORS, boxIou, trackBoxAt } from '@shared/ai';
import { engine } from '../engine/instance';

export interface AiJobProgress { percent: number; message: string }

let cancelled = false;
export function cancelAi(): void { cancelled = true; void window.panocut.aiCancel(); }

function frameToPayload(img: ImageData): { data: Uint8Array; width: number; height: number } {
  return { data: new Uint8Array(img.data.buffer.slice(0)), width: img.width, height: img.height };
}

/** Objekte in einem Einzelbild erkennen. */
export async function detectAt(clip: Clip, media: MediaItem, localT: number, model: AiDetectModel): Promise<Detection[]> {
  const img = await engine.grabFrame(clip, media, localT, 640);
  if (!img) throw new Error('Kein Bild an dieser Stelle.');
  return window.panocut.aiDetect(frameToPayload(img), model, 0.3);
}

/** Abtastintervall je nach Clip-Länge (kurze Clips feiner). */
export function sampleInterval(clip: Clip): number {
  const d = clipDuration(clip);
  return d <= 10 ? 0.2 : d <= 60 ? 0.33 : 0.5;
}

/**
 * Verfolgt ein erkanntes Objekt vom Zeitpunkt t0 aus vorwärts und rückwärts durch den Clip.
 * Pro Abtastzeitpunkt wird neu erkannt und die Box mit der größten Überlappung (gleiche Klasse) gewählt.
 */
export async function trackObject(clip: Clip, media: MediaItem, det: Detection, t0: number, model: AiDetectModel, onProgress: (p: AiJobProgress) => void): Promise<ObjectTrack> {
  cancelled = false;
  const interval = sampleInterval(clip);
  const dur = clipDuration(clip);
  const boxes: TrackBox[] = [{ t: t0, x: det.x, y: det.y, w: det.w, h: det.h }];
  const totalSteps = Math.ceil(dur / interval);
  let done = 0;
  const follow = async (dir: 1 | -1) => {
    let last: TrackBox = boxes[0];
    let misses = 0;
    for (let t = t0 + dir * interval; t >= 0 && t <= dur; t += dir * interval) {
      if (cancelled) return;
      const img = await engine.grabFrame(clip, media, t, 640);
      if (!img) break;
      const dets = await window.panocut.aiDetect(frameToPayload(img), model, 0.25);
      let best: Detection | null = null, bestIou = 0.2;
      for (const d of dets) {
        if (d.label !== det.label) continue;
        const i = boxIou(d, last);
        if (i > bestIou) { bestIou = i; best = d; }
      }
      if (best) {
        last = { t, x: best.x, y: best.y, w: best.w, h: best.h };
        boxes.push(last);
        misses = 0;
      } else {
        misses++;
        if (misses >= 3) break;
      }
      done++;
      onProgress({ percent: Math.min(99, Math.round((done / totalSteps) * 100)), message: `Objekt wird verfolgt … ${Math.round(t * 10) / 10} s` });
    }
  };
  await follow(1);
  await follow(-1);
  boxes.sort((a, b) => a.t - b.t);
  const used = (clip.objects ?? []).length;
  return { id: makeId('obj'), label: det.label, labelDe: det.labelDe, color: TRACK_COLORS[used % TRACK_COLORS.length], boxes };
}

/** Alphamaske als Graustufen-PNG kodieren. */
async function maskToPng(alpha: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = alpha[i];
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('PNG konnte nicht erzeugt werden');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Berechnet Masken für einen Track an allen Abtastzeitpunkten (Box-Bereich) und speichert sie als PNG.
 */
export async function maskTrack(clip: Clip, media: MediaItem, track: ObjectTrack, model: AiSegmentModel, onProgress: (p: AiJobProgress) => void): Promise<Array<{ t: number; path: string }>> {
  cancelled = false;
  const masks: Array<{ t: number; path: string }> = [];
  const times = track.boxes.map((b) => b.t);
  // Bei sehr dichten Boxen ausdünnen (max. ~4 Masken pro Sekunde)
  const minGap = model === 'isnet' ? 0.5 : 0.25;
  const sampled: number[] = [];
  for (const t of times) if (sampled.length === 0 || t - sampled[sampled.length - 1] >= minGap - 1e-6) sampled.push(t);
  if (sampled[sampled.length - 1] !== times[times.length - 1]) sampled.push(times[times.length - 1]);
  const width = model === 'isnet' ? 1024 : 720;
  for (let i = 0; i < sampled.length; i++) {
    if (cancelled) break;
    const t = sampled[i];
    const img = await engine.grabFrame(clip, media, t, width);
    if (!img) continue;
    const box = trackBoxAt(track, t);
    const res = await window.panocut.aiSegment(frameToPayload(img), model, box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null);
    const png = await maskToPng(new Uint8Array(res.alpha), res.width, res.height);
    const path = await window.panocut.aiSaveMask(media.path, track.id, i, png);
    masks.push({ t, path });
    onProgress({ percent: Math.round(((i + 1) / sampled.length) * 100), message: `Maske ${i + 1} von ${sampled.length} …` });
  }
  return masks;
}
