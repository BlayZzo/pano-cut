// Freigestellte Objekte als WebM mit Alphakanal rendern (für die Objekt-Mediathek und zum Überlagern).
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem, Project } from '@shared/types';
import { clipDuration, makeId, sourceTimeAt } from '@shared/timeline';
import { probeFile, runFfmpeg } from './ffmpeg';
import { mediaCacheDir } from './paths';

export function objectsDir(projectId: string): string {
  const dir = path.join(app.getPath('userData'), 'objects', projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Schreibt eine concat-Liste für Masken mit exakten Zeiten (Bildsequenz mit Dauern). */
export function writeMaskList(masks: Array<{ t: number; path: string }>, totalDuration: number, file: string, startAt = 0): void {
  const sorted = [...masks].sort((a, b) => a.t - b.t);
  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t0 = Math.max(startAt, sorted[i].t);
    const t1 = i + 1 < sorted.length ? sorted[i + 1].t : Math.max(totalDuration, t0 + 0.04);
    if (t1 <= startAt) continue;
    const dur = Math.max(0.01, t1 - t0);
    lines.push(`file '${sorted[i].path.replace(/'/g, "'\\''")}'`, `duration ${dur.toFixed(4)}`);
  }
  if (sorted.length) lines.push(`file '${sorted[sorted.length - 1].path.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

/** Maskenkette: Graustufen, optional Rand weichzeichnen und vergrößern/verkleinern. */
export function maskChain(feather: number, grow: number, invert: boolean): string {
  const parts = ['format=gray'];
  const g = Math.round(grow);
  for (let i = 0; i < Math.min(Math.abs(g), 10); i++) parts.push(g > 0 ? 'dilation' : 'erosion');
  if (feather > 0) parts.push(`boxblur=${Math.max(1, Math.round(feather / 2))}:1`);
  if (invert) parts.push('negate');
  return parts.join(',');
}

export async function renderObject(project: Project, clipId: string, trackId: string, name: string, onProgress: (percent: number) => void): Promise<MediaItem> {
  const clip = project.clips[clipId];
  if (!clip) throw new Error('Clip nicht gefunden');
  const media = project.media[clip.mediaId];
  if (!media) throw new Error('Medium nicht gefunden');
  const track = clip.objects?.find((t) => t.id === trackId);
  if (!track || !track.masks || track.masks.length === 0) throw new Error('Für dieses Objekt gibt es noch keine Maske.');
  const dur = clipDuration(clip);
  const dir = objectsDir(project.id);
  const id = makeId('obj');
  const out = path.join(dir, `${id}.webm`);
  const thumb = path.join(dir, `${id}.png`);
  const list = path.join(dir, `${id}_masks.txt`);
  writeMaskList(track.masks, dur, list);

  // Quelle: Original in Timeline-Zeit (Tempo/Rückwärts berücksichtigt) – für Rückwärts-Clips den Proxy benutzen
  const sA = sourceTimeAt(clip, clip.start), sB = sourceTimeAt(clip, clip.start + dur);
  const srcIn = Math.min(sA, sB), srcDur = Math.max(0.01, Math.abs(sB - sA));
  const source = clip.reverse && media.proxyReversed ? media.proxyReversed : media.path;
  const maxW = Math.min(media.info.width || 1920, 1920);
  const feather = clip.cutout?.feather ?? 2, grow = clip.cutout?.grow ?? 0;
  const videoChain = `[0:v]setpts=PTS-STARTPTS${clip.speed !== 1 ? `,setpts=PTS/${clip.speed}` : ''},fps=30,scale=w=${maxW}:h=-2,format=rgba[v]`;
  // Bildgröße einmal messen und die Maske mit einem normalen `scale` anpassen (`scale2ref` bleibt in FFmpeg 7 hängen)
  let size: { w: number; h: number } | null = null;
  try {
    const probePng = path.join(dir, `${id}_size.png`);
    await runFfmpeg(['-ss', srcIn.toFixed(4), '-t', srcDur.toFixed(4), '-i', source, '-filter_complex', videoChain, '-map', '[v]', '-frames:v', '1', probePng]);
    const v = (await probeFile(probePng)).streams.find((x) => x.codec_type === 'video');
    if (v?.width && v?.height) size = { w: v.width, h: v.height };
    fs.rmSync(probePng, { force: true });
  } catch { /* Rückfall auf scale2ref */ }
  const chain = (size
    ? [videoChain, `[1:v]fps=30,${maskChain(feather, grow, false)},scale=${size.w}:${size.h}[m]`, `[v][m]alphamerge,format=yuva420p[out]`]
    : [videoChain, `[1:v]fps=30,${maskChain(feather, grow, false)}[m0]`, `[m0][v]scale2ref[m][vref]`, `[vref][m]alphamerge,format=yuva420p[out]`]
  ).join(';');
  const args = ['-ss', srcIn.toFixed(4), '-t', srcDur.toFixed(4), '-i', source, '-f', 'concat', '-safe', '0', '-i', list,
    '-filter_complex', chain, '-map', '[out]', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
    '-t', dur.toFixed(4), '-an', out];
  await runFfmpeg(args, { onProgress: (p) => onProgress(Math.min(99, Math.round((p.outTime / dur) * 100))) });
  // Vorschaubild mit Schachbrett (zeigt Transparenz)
  await runFfmpeg(['-c:v', 'libvpx-vp9', '-i', out, '-filter_complex', `color=c=#222222:s=320x180[bg];[0:v]scale=320:-2[o];[bg][o]overlay=(W-w)/2:(H-h)/2:shortest=1`, '-frames:v', '1', thumb]);
  fs.rmSync(list, { force: true });
  const stat = fs.statSync(out);
  return {
    id, path: out, name, type: 'video', status: 'ready', addedAt: Date.now(), thumb, proxy: out, hasAlpha: true, isObject: true,
    info: { duration: dur, width: maxW, height: Math.round((maxW * (media.info.height || 9)) / Math.max(1, media.info.width || 16)), fps: 30, hasVideo: true, hasAudio: false, rotation: 0, is360: false, fileSize: stat.size, videoCodec: 'vp9' },
  };
}

export function maskDir(mediaPath: string, trackId: string): string {
  const dir = path.join(mediaCacheDir(mediaPath), 'masks', trackId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

