import path from 'node:path';
import fs from 'node:fs';
import log from 'electron-log';
import type { MediaInfo, MediaItem, MediaType } from '@shared/types';
import { makeId } from '@shared/timeline';
import { parseFps, runFfmpeg, runFfprobe } from './ffmpeg';
import { fileExists, mediaCacheDir } from './paths';
import { reverseVideo } from './reverse';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts', '.ts', '.mxf', '.insv', '.360', '.wmv', '.flv', '.3gp', '.lrv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.wma']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.insp', '.dng']);

export const SUPPORTED_EXTENSIONS = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].map((e) => e.slice(1));

export function mediaTypeFor(file: string): MediaType | null {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

const SPRITE_FRAMES = 24;
const SPRITE_WIDTH = 160;

/** Liest die Metadaten einer Datei und legt den Medien-Eintrag an (noch ohne Vorschau-Dateien). */
export async function probeMedia(file: string): Promise<MediaItem> {
  const type = mediaTypeFor(file);
  if (!type) throw new Error(`Dateityp wird nicht unterstützt: ${path.basename(file)}`);
  const stat = fs.statSync(file);
  const base: MediaItem = {
    id: makeId('m'),
    path: file,
    name: path.basename(file),
    type,
    status: 'analyzing',
    addedAt: Date.now(),
    info: { duration: 0, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: false, rotation: 0, is360: false, fileSize: stat.size },
  };
  try {
    const probe = await runFfprobe(file);
    const v = probe.streams.find((s) => s.codec_type === 'video' && !(s.tags?.mimetype ?? '').startsWith('image/') );
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    let rotation = 0;
    const sd = v?.side_data_list?.find((s) => typeof s.rotation === 'number');
    if (sd?.rotation) rotation = sd.rotation;
    else if (v?.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
    let width = v?.width ?? 0;
    let height = v?.height ?? 0;
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    const duration = Number(probe.format.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
    const fps = parseFps(v?.avg_frame_rate) || parseFps(v?.r_frame_rate) || 0;
    const info: MediaInfo = {
      duration: type === 'image' ? 0 : duration,
      width,
      height,
      fps: type === 'image' ? 0 : fps,
      hasVideo: !!v && type !== 'audio',
      hasAudio: !!a,
      videoCodec: v?.codec_name,
      audioCodec: a?.codec_name,
      rotation,
      // 360°: Equirectangular (2:1) oder Insta360/GoPro-Rohdateien (Dual-Fisheye)
      is360: type === 'video' && (['.insv', '.lrv', '.360'].includes(path.extname(file).toLowerCase()) || (width > 0 && Math.abs(width / Math.max(1, height) - 2) < 0.05)),
      fileSize: stat.size,
    };
    if (type === 'video' && !v) {
      // z. B. reine Tonspur in .mp4
      base.type = 'audio';
      info.hasVideo = false;
    }
    base.info = info;
    base.status = 'processing';
  } catch (err) {
    base.status = 'error';
    base.error = (err as Error).message;
    log.warn('probe fehlgeschlagen', file, err);
  }
  return base;
}

export type MediaUpdateFn = (item: MediaItem) => void;

/**
 * Erzeugt Vorschaubild, Hover-Streifen, Proxy und Wellenform.
 * Ruft `update` nach jedem Schritt auf, damit die Oberfläche sofort etwas anzeigen kann.
 */
export async function prepareMedia(item: MediaItem, update: MediaUpdateFn, proxyHeight = 540, options: { reversed?: boolean } = {}): Promise<void> {
  if (item.status === 'error') return;
  const dir = mediaCacheDir(item.path);
  const work: MediaItem = { ...item };
  const emit = () => update({ ...work });
  const dur = work.info.duration;

  try {
    if (work.type === 'image') {
      const thumb = path.join(dir, 'thumb.jpg');
      if (!fileExists(thumb)) {
        await runFfmpeg(['-i', work.path, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '4', thumb], { lowPriority: true });
      }
      work.thumb = thumb;
      work.status = 'ready';
      emit();
      return;
    }

    if (work.type === 'audio') {
      const wave = path.join(dir, 'wave.png');
      if (!fileExists(wave)) {
        await runFfmpeg([
          '-i', work.path,
          '-filter_complex', 'aformat=channel_layouts=mono,compand=gain=-2,showwavespic=s=2000x80:colors=#5eead4:scale=sqrt',
          '-frames:v', '1', wave,
        ], { lowPriority: true });
      }
      work.waveform = wave;
      work.status = 'ready';
      emit();
      return;
    }

    // ---- Video ----
    const thumb = path.join(dir, 'thumb.jpg');
    if (!fileExists(thumb)) {
      const at = Math.min(Math.max(0, dur * 0.1), 3);
      await runFfmpeg(['-ss', at.toFixed(3), '-i', work.path, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '4', thumb], { lowPriority: true });
    }
    work.thumb = thumb;
    emit();

    // Hover-Streifen: 24 Bilder gleichmäßig verteilt in einem Bild
    const sprite = path.join(dir, 'sprite.jpg');
    const frames = dur > 0 ? SPRITE_FRAMES : 1;
    if (!fileExists(sprite)) {
      const rate = dur > 0 ? frames / dur : 1;
      await runFfmpeg([
        '-i', work.path,
        '-vf', `fps=${rate.toFixed(6)},scale=${SPRITE_WIDTH}:-2,tile=${frames}x1`,
        '-frames:v', '1', '-q:v', '5', sprite,
      ], { lowPriority: true });
    }
    const sh = Math.round((SPRITE_WIDTH * work.info.height) / Math.max(1, work.info.width) / 2) * 2;
    work.sprite = { path: sprite, frames, frameWidth: SPRITE_WIDTH, frameHeight: sh || 90 };
    emit();

    if (work.info.hasAudio) {
      const wave = path.join(dir, 'wave.png');
      if (!fileExists(wave)) {
        try {
          await runFfmpeg([
            '-i', work.path,
            '-filter_complex', 'aformat=channel_layouts=mono,compand=gain=-2,showwavespic=s=2000x80:colors=#5eead4:scale=sqrt',
            '-frames:v', '1', wave,
          ], { lowPriority: true });
          work.waveform = wave;
        } catch (e) {
          log.warn('Wellenform fehlgeschlagen', e);
        }
      } else work.waveform = wave;
      emit();
    }

    // Proxy: kleine, schnell spulbare Vorschau-Datei
    const proxy = path.join(dir, `proxy_${proxyHeight}.mp4`);
    if (!fileExists(proxy)) {
      const h = Math.min(proxyHeight, work.info.height || proxyHeight);
      const args = ['-i', work.path, '-map', '0:v:0'];
      if (work.info.hasAudio) args.push('-map', '0:a:0');
      args.push(
        '-vf', `scale=-2:${h}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart', '-threads', '0', proxy,
      );
      await runFfmpeg(args, { lowPriority: true });
    }
    work.proxy = proxy;
    work.status = 'ready';
    emit();

    if (options.reversed) {
      await ensureReversedProxy(work, update);
    }
  } catch (err) {
    work.status = 'error';
    work.error = (err as Error).message;
    log.warn('Vorbereitung fehlgeschlagen', work.path, err);
    emit();
  }
}

/** Erzeugt eine rückwärts laufende Variante des Proxys (für die Vorschau von Rückwärts-Clips). */
export async function ensureReversedProxy(item: MediaItem, update: MediaUpdateFn): Promise<void> {
  if (!item.proxy || !fileExists(item.proxy)) return;
  const rev = item.proxy.replace(/\.mp4$/, '_rev.mp4');
  if (!fileExists(rev)) {
    const h = Math.min(540, item.info.height || 540);
    const w = Math.round((h * (item.info.width || 960)) / Math.max(1, item.info.height || 540));
    await reverseVideo(item.proxy, rev, { hasAudio: item.info.hasAudio, width: w, height: h, fps: 30, crf: 23 });
  }
  update({ ...item, proxyReversed: rev });
}
