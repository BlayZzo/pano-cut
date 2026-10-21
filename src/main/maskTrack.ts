// Masken-Editor (Hauptprozess): Einzelbilder in Masken-Auflösung holen, KI-Masken an Stellen erzeugen und Masken
// durch das Video verfolgen. Bei 360°-Videos arbeitet alles im ganzen Rundum-Bild (Equirect), damit die Maske auch
// außerhalb des sichtbaren Ausschnitts stimmt (Kamerafahrten bleiben möglich).
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import type { MediaItem } from '@shared/types';
import { dilate, goodFeatures, interiorPoints, maskBox, maskIoU, pyramid, robustSimilarity, toGray, trackPoints, warpMask, type Gray } from '@shared/flow';
import { pipeFfmpeg, streamFrames } from './ffmpeg';
import { needsStitching, stitchChain } from './stitch';
import { swapLensSettings } from './media';
import { fileExists } from './paths';
import { maskDir } from './objects';
import { samSegment, type SamPrompt } from './sam';
import type { Frame } from './ai';

export type MaskSpace = 'source' | 'equirect';

export function maskSpace(media: MediaItem): MaskSpace {
  return media.info.is360 ? 'equirect' : 'source';
}

/** Masken-Auflösung: normale Videos bis 1920 Pixel (lange Seite), 360° immer 2048×1024. */
export function maskSize(media: MediaItem): { w: number; h: number } {
  if (maskSpace(media) === 'equirect') return { w: 2048, h: 1024 };
  const W = media.info.width || 1920, H = media.info.height || 1080;
  const k = Math.min(1, 1920 / Math.max(W, H));
  return { w: Math.max(2, Math.round((W * k) / 2) * 2), h: Math.max(2, Math.round((H * k) / 2) * 2) };
}

/** Eingabe + Filterkette, die Bilder in Masken-Auflösung (RGBA) liefert. */
function frameSource(media: MediaItem, fps?: number): { file: string; graph: string; w: number; h: number } {
  const { w, h } = maskSize(media);
  const rate = fps ? `fps=${fps},` : '';
  if (maskSpace(media) === 'equirect' && media.stitch && needsStitching(media.stitch)) {
    const comp = media.companion && fileExists(media.companion) ? media.companion : undefined;
    if (comp) {
      const st = media.companionSwap ? swapLensSettings(media.stitch) : { ...media.stitch, mode: 'dualfisheye-sbs' as const };
      return { file: comp, graph: stitchChain(st, [`[0:v:0]${rate}`], w, h) + ',format=rgba[o]', w, h };
    }
    if (media.stitch.mode === 'dualfisheye-2streams') {
      const f = fps ? `fps=${fps}` : 'null';
      return { file: media.path, graph: `[0:v:0]${f}[ma];[0:v:1]${f}[mb];` + stitchChain(media.stitch, ['[ma]', '[mb]'], w, h) + ',format=rgba[o]', w, h };
    }
    return { file: media.path, graph: stitchChain(media.stitch, [`[0:v:0]${rate}`], w, h) + ',format=rgba[o]', w, h };
  }
  return { file: media.path, graph: `[0:v:0]${rate}scale=${w}:${h}:flags=bicubic,format=rgba[o]`, w, h };
}

// Zuletzt geholte Bilder (für die KI im Editor)
const frames = new Map<string, Frame>();

/** Ein Bild zur Quellzeit t in Masken-Auflösung. */
export async function maskFrame(media: MediaItem, t: number): Promise<Frame & { key: string }> {
  const key = `${media.id}|${t.toFixed(3)}`;
  const hit = frames.get(key);
  if (hit) return { ...hit, key };
  const src = frameSource(media);
  let data: Uint8Array | null = null;
  await streamFrames(['-ss', Math.max(0, t).toFixed(3), '-i', src.file, '-filter_complex', src.graph, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-'], src.w * src.h * 4, (d) => { data = d; }, false);
  if (!data) throw new Error('Bild konnte nicht gelesen werden');
  const f: Frame = { data, width: src.w, height: src.h };
  frames.set(key, f);
  if (frames.size > 8) frames.delete(frames.keys().next().value as string);
  return { ...f, key };
}

/** KI-Maske im Editor-Bild (Hinweise in Masken-Pixeln). */
export async function maskSegment(media: MediaItem, t: number, prompt: SamPrompt): Promise<Uint8Array> {
  const f = await maskFrame(media, t);
  const r = await samSegment(f, prompt, { wrap: maskSpace(media) === 'equirect', key: f.key });
  return r.mask;
}

/** Rahmen einer Maske, bei 360° auch über die Kante hinweg (dann x1 > Breite möglich). */
function wrapBox(mask: Uint8Array, W: number, H: number, wrap: boolean): { x0: number; y0: number; x1: number; y1: number } | null {
  const b = maskBox(mask, W, H);
  if (!b) return null;
  if (!wrap || b.x1 - b.x0 < W / 2) return b;
  // Objekt liegt über der Kante: um eine halbe Breite verschoben messen
  const sh = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sh[y * W + ((x + W / 2) % W)] = mask[y * W + x];
  const c = maskBox(sh, W, H);
  if (!c) return b;
  return { x0: c.x0 - W / 2, y0: c.y0, x1: c.x1 - W / 2, y1: c.y1 };
}

export interface TrackRequest {
  media: MediaItem;
  trackId: string;
  start: number;     // Quellzeit des Startbilds (dort gilt `mask`)
  end: number;       // bis zu dieser Quellzeit (davor = rückwärts)
  fps: number;
  mask: Uint8Array;  // Maske im Startbild (Masken-Auflösung)
  mode: 'ai' | 'fast';
}

/**
 * Maske verfolgen. Je Bild: Bewegung der Merkmale (Lucas-Kanade) → Maske mitbewegen; im KI-Modus danach mit
 * MobileSAM neu zeichnen (passt sich Form-Änderungen an, z. B. Arme/Beine). Ergebnis: Masken-PNGs je Quellzeit.
 */
export async function trackMask(req: TrackRequest, onProgress: (percent: number, preview?: { t: number }) => void, signal: AbortSignal): Promise<Array<{ t: number; path: string; box: { x: number; y: number; w: number; h: number } | null }>> {
  const { media } = req;
  const { w: W, h: H } = maskSize(media);
  const wrap = maskSpace(media) === 'equirect';
  const dir = path.join(maskDir(media.path, req.trackId), `trk_${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  const dirSign = req.end >= req.start ? 1 : -1;
  const total = Math.max(1, Math.round(Math.abs(req.end - req.start) * req.fps));
  const out: Array<{ t: number; path: string; box: { x: number; y: number; w: number; h: number } | null }> = [];
  const writer = pipeFfmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', '1', '-i', '-', '-start_number', '0', path.join(dir, 'm_%05d.png')]);
  let prevMask = req.mask;
  let prevPyr: Gray[] | null = null;
  let n = 0;
  const LEVELS = 4;

  const step = async (rgba: Uint8Array, t: number) => {
    if (signal.aborted) throw new Error('Abgebrochen');
    const g = toGray(rgba, W, H);
    const pyr = pyramid(g, LEVELS);
    if (!prevPyr) { prevPyr = pyr; return; }   // erstes Bild = Startbild
    // 1) Bewegung schätzen und Maske mitnehmen
    const region = dilate(prevMask, W, H, 10);
    const feats = goodFeatures(prevPyr[0], region, 400, 5);
    let predicted = prevMask;
    if (feats.length >= 3) {
      const moved = trackPoints(prevPyr, pyr, feats);
      const src: Array<[number, number]> = [], dst: Array<[number, number]> = [];
      moved.forEach((m, i) => { if (m) { src.push(feats[i]); dst.push(m); } });
      const est = robustSimilarity(src, dst, 2.5);
      if (est) predicted = warpMask(prevMask, W, H, est.sim, wrap);
    }
    // 2) KI: Form neu zeichnen (Rahmen + innere Punkte als Hinweis)
    let next = predicted;
    if (req.mode === 'ai') {
      const box = wrapBox(predicted, W, H, wrap);
      if (box) {
        const mx = (box.x1 - box.x0) * 0.04, my = (box.y1 - box.y0) * 0.04;
        const prompt: SamPrompt = {
          box: { x0: box.x0 - mx, y0: Math.max(0, box.y0 - my), x1: box.x1 + mx, y1: Math.min(H - 1, box.y1 + my) },
          points: interiorPoints(predicted, W, H, 3).map(([x, y]) => ({ x, y, label: 1 as const })),
        };
        try {
          const r = await samSegment({ data: rgba, width: W, height: H }, prompt, { wrap });
          const iou = maskIoU(r.mask, predicted);
          const a0 = maskBox(predicted, W, H)?.area ?? 0, a1 = maskBox(r.mask, W, H)?.area ?? 0;
          if (iou > 0.35 && a1 > a0 * 0.5 && a1 < a0 * 2) next = r.mask;
        } catch (e) { log.warn('KI-Verfolgen: Bild übersprungen', (e as Error).message); }
      }
    }
    prevMask = next;
    prevPyr = pyr;
    await writer.write(next);
    const bb = wrapBox(next, W, H, wrap);
    out.push({ t, path: path.join(dir, `m_${String(n).padStart(5, '0')}.png`), box: bb ? { x: bb.x0 / W, y: bb.y0 / H, w: (bb.x1 - bb.x0 + 1) / W, h: (bb.y1 - bb.y0 + 1) / H } : null });
    n++;
    onProgress(Math.min(99, (100 * n) / total), { t });
  };

  try {
    const src = frameSource(media, req.fps);
    if (dirSign > 0) {
      const dur = req.end - req.start + 0.5 / req.fps;
      let k = 0;
      await streamFrames(['-ss', req.start.toFixed(3), '-t', dur.toFixed(3), '-i', src.file, '-filter_complex', src.graph, '-map', '[o]', '-f', 'rawvideo', '-'], W * H * 4,
        (d) => step(d, req.start + (k++) / req.fps));
    } else {
      // Rückwärts: in Stücken von 1 s dekodieren und rückwärts abarbeiten
      let b = req.start;
      let firstDone = false;
      while (b > req.end + 1e-3) {
        if (signal.aborted) throw new Error('Abgebrochen');
        const a = Math.max(req.end, b - 1);
        const chunk: Uint8Array[] = [];
        await streamFrames(['-ss', a.toFixed(3), '-t', (b - a + 0.5 / req.fps).toFixed(3), '-i', src.file, '-filter_complex', src.graph, '-map', '[o]', '-f', 'rawvideo', '-'], W * H * 4, (d) => { chunk.push(d); });
        for (let i = chunk.length - 1; i >= 0; i--) {
          const t = a + i / req.fps;
          if (firstDone && t >= b - 0.5 / req.fps) continue;   // Grenzbild nicht doppelt
          await step(chunk[i], t);
          firstDone = true;
        }
        b = a;
      }
    }
    await writer.end();
  } catch (e) {
    writer.kill();
    throw e;
  }
  onProgress(100);
  return out.sort((x, y) => x.t - y.t);
}

/** Masken-PNG lesen (für den Editor: Ausgangsmaske einer gespeicherten Stelle) – als Graustufen in Masken-Auflösung. */
export async function readMaskPng(file: string, W: number, H: number): Promise<Uint8Array> {
  let data: Uint8Array | null = null;
  await streamFrames(['-i', file, '-vf', `scale=${W}:${H},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'], W * H, (d) => { data = d; }, false);
  if (!data) throw new Error('Maske nicht lesbar');
  return data;
}

