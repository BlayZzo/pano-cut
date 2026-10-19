// Effekt-Simulationen: Die Oberfläche rendert Bild für Bild (WebGL), hier werden die Bilder zu einem Video kodiert.
// Effekte mit Transparenz → WebM (VP9 mit Alpha), Lichtschein → WebM ohne Alpha (schwarzer Grund, Mischmodus „Negativ multiplizieren“).
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem, VfxSpec } from '@shared/types';
import { makeId } from '@shared/timeline';
import { vfxLabel } from '@shared/vfx';
import { pipeFfmpeg, runFfmpeg, type FfmpegPipe } from './ffmpeg';

interface VfxJob {
  pipe: FfmpegPipe;
  out: string;
  spec: VfxSpec;
  role: 'effect' | 'light';
  width: number;
  height: number;
  frames: number;
  mediaId: string;
  name: string;
}

const jobs = new Map<string, VfxJob>();

export function effectsDir(projectId: string): string {
  const dir = path.join(app.getPath('userData'), 'effects', projectId.replace(/[^\w-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface VfxBeginRequest {
  projectId: string;
  spec: VfxSpec;
  role: 'effect' | 'light';
  width: number;
  height: number;
  mediaId?: string;   // beim Neu-Rendern: bestehende Medien-ID behalten
  name?: string;
}

export function vfxBegin(req: VfxBeginRequest): string {
  const id = makeId('vfxjob');
  const mediaId = req.mediaId ?? makeId('media');
  const dir = effectsDir(req.projectId);
  const stamp = Date.now().toString(36);
  const fps = req.spec.fps;
  const input = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${req.width}x${req.height}`, '-r', String(fps), '-i', 'pipe:0'];
  let out: string;
  let args: string[];
  if (req.role === 'effect') {
    out = path.join(dir, `${mediaId}_${stamp}.webm`);
    args = [...input, '-vf', 'vflip', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-an', out];
  } else {
    out = path.join(dir, `${mediaId}_${stamp}_licht.webm`);
    args = [...input, '-vf', 'vflip,format=yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5', '-an', out];
  }
  const name = req.name ?? (req.role === 'light' ? `${vfxLabel(req.spec)} – Licht` : vfxLabel(req.spec));
  jobs.set(id, { pipe: pipeFfmpeg(args), out, spec: req.spec, role: req.role, width: req.width, height: req.height, frames: 0, mediaId, name });
  return id;
}

export async function vfxFrame(jobId: string, data: Uint8Array): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Effekt-Auftrag nicht gefunden');
  if (data.byteLength !== job.width * job.height * 4) throw new Error('Falsche Bildgröße');
  await job.pipe.write(data);
  job.frames++;
}

export function vfxCancel(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.pipe.kill();
  jobs.delete(jobId);
  fs.rmSync(job.out, { force: true });
}

export async function vfxEnd(jobId: string): Promise<MediaItem> {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Effekt-Auftrag nicht gefunden');
  jobs.delete(jobId);
  await job.pipe.end();
  const duration = job.frames / job.spec.fps;
  // Vorschaubild: Effekt auf dunklem Grund (Transparenz sichtbar), an einer aussagekräftigen Stelle
  const thumb = job.out.replace(/\.webm$/, '.jpg');
  const at = job.spec.kind === 'explosion' ? Math.min(duration * 0.3, 0.9) : job.spec.kind === 'lightning' ? 0.12 : duration * 0.5;
  const dec = ['-c:v', 'libvpx-vp9'];
  try {
    await runFfmpeg([...dec, '-ss', at.toFixed(3), '-i', job.out, '-filter_complex', 'color=c=#2a2f3a:s=320x180[bg];[0:v]scale=320:180:force_original_aspect_ratio=decrease[o];[bg][o]overlay=(W-w)/2:(H-h)/2:shortest=1', '-frames:v', '1', '-q:v', '4', thumb]);
  } catch { /* Vorschaubild ist nicht wichtig */ }
  const stat = fs.statSync(job.out);
  return {
    id: job.mediaId,
    path: job.out,
    name: job.name,
    type: 'video',
    status: 'ready',
    addedAt: Date.now(),
    thumb: fs.existsSync(thumb) ? thumb : undefined,
    proxy: job.out,
    hasAlpha: job.role === 'effect',
    vfx: job.spec,
    vfxRole: job.role,
    info: { duration, width: job.width, height: job.height, fps: job.spec.fps, hasVideo: true, hasAudio: false, rotation: 0, is360: false, fileSize: stat.size, videoCodec: 'vp9' },
  };
}
