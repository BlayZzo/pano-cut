import path from 'node:path';
import fs from 'node:fs';
import log from 'electron-log';
import type { MediaInfo, MediaItem, MediaType } from '@shared/types';
import { makeId } from '@shared/timeline';
import { probeFile, runFfmpeg } from './ffmpeg';
import { fileExists, mediaCacheDir } from './paths';
import { reverseVideo } from './reverse';
import { needsStitching, stitchChain } from './stitch';
import { availableFilters } from './ffmpeg';
import { escapeFilterPath } from './fonts';
import { defaultStitch } from '@shared/pano';
import type { StitchSettings } from '@shared/types';

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
const PANO_PROXY_HEIGHT = 960;
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
    const probe = await probeFile(file);
    const videoStreams = probe.streams.filter((s) => s.codec_type === 'video' && !s.attachedPic);
    const v = videoStreams[0];
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    const rotation = v?.rotation ?? 0;
    let width = v?.width ?? 0;
    let height = v?.height ?? 0;
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    const duration = probe.format.duration ?? 0;
    const fps = v?.fps ?? 0;

    // 360°: Insta360-Rohdateien (zwei Fisheye-Bilder) oder fertige Equirectangular-Videos (2:1)
    const ext = path.extname(file).toLowerCase();
    let stitch: StitchSettings | undefined;
    if (type === 'video' && v) {
      const aspect = width / Math.max(1, height);
      if (ext === '.insv' && videoStreams.length >= 2 && Math.abs(aspect - 1) < 0.05) {
        stitch = defaultStitch('dualfisheye-2streams');
        width = width * 2;               // Equirectangular-Größe nach dem Stitching
      } else if ((ext === '.insv' || ext === '.lrv') && Math.abs(aspect - 2) < 0.05) {
        stitch = defaultStitch('dualfisheye-sbs');
      } else if (Math.abs(aspect - 2) < 0.02 && width >= 1024) {
        stitch = defaultStitch('equirect');
      }
    }

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
      is360: !!stitch,
      fileSize: stat.size,
    };
    if (stitch) base.stitch = stitch;
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
export async function prepareMedia(item: MediaItem, update: MediaUpdateFn, proxyHeight = 540, options: { reversed?: boolean; stabilized?: number } = {}): Promise<void> {
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
    // 360°-Rohvideos: zuerst den gestitchten Proxy erzeugen; Vorschaubilder kommen dann daraus.
    const stitched = needsStitching(work.stitch);
    let visualSource = work.path;
    if (stitched && work.stitch) {
      const proxy = await buildProxy(work, dir, Math.max(proxyHeight, PANO_PROXY_HEIGHT), emit);
      work.proxy = proxy;
      visualSource = proxy;
      emit();
    }

    const thumb = path.join(dir, 'thumb.jpg');
    if (!fileExists(thumb)) {
      const at = Math.min(Math.max(0, dur * 0.1), 3);
      await runFfmpeg(['-ss', at.toFixed(3), '-i', visualSource, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '4', thumb], { lowPriority: true });
    }
    work.thumb = thumb;
    emit();

    // Hover-Streifen: 24 Bilder gleichmäßig verteilt in einem Bild
    const sprite = path.join(dir, 'sprite.jpg');
    const frames = dur > 0 ? SPRITE_FRAMES : 1;
    if (!fileExists(sprite)) {
      const rate = dur > 0 ? frames / dur : 1;
      await runFfmpeg([
        '-i', visualSource,
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
    if (!stitched) work.proxy = await buildProxy(work, dir, proxyHeight, emit);
    work.status = 'ready';
    emit();

    if (options.reversed) {
      await ensureReversedProxy(work, update);
    }
    if (options.stabilized) {
      await ensureStabilizedProxy(work, update, options.stabilized);
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

/** Erzeugt die Vorschau-Datei (Proxy); 360°-Rohvideos werden dabei zusammengesetzt. */
async function buildProxy(work: MediaItem, dir: string, height: number, emit: () => void): Promise<string> {
  const stitched = needsStitching(work.stitch);
  const key = stitched && work.stitch ? `${height}_s${Math.round(work.stitch.fov * 10)}_${Math.round(work.stitch.yaw * 10)}_${Math.round(work.stitch.pitch * 10)}_${Math.round(work.stitch.roll * 10)}` : `${height}`;
  const proxy = path.join(dir, `proxy_${key}.mp4`);
  if (fileExists(proxy)) return proxy;
  const h = stitched ? height : Math.min(height, work.info.height || height);
  const args = ['-i', work.path];
  if (stitched && work.stitch) {
    const two = work.stitch.mode === 'dualfisheye-2streams';
    const inputs = two ? ['[0:v:0]', '[0:v:1]'] : ['[0:v:0]'];
    const w = Math.round(h * 2);
    const chain = stitchChain(work.stitch, inputs, w, h) + ',format=yuv420p[v]';
    args.push('-filter_complex', chain, '-map', '[v]');
  } else {
    args.push('-map', '0:v:0', '-vf', `scale=-2:${h}`);
  }
  if (work.info.hasAudio) args.push('-map', '0:a:0?');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-threads', '0', proxy,
  );
  void emit;
  await runFfmpeg(args, { lowPriority: true });
  return proxy;
}

/** Erzeugt eine stabilisierte Variante des Proxys (vidstab in zwei Durchgängen, sonst deshake). */
export async function ensureStabilizedProxy(item: MediaItem, update: MediaUpdateFn, strength = 5): Promise<void> {
  if (!item.proxy || !fileExists(item.proxy)) return;
  const stab = item.proxy.replace(/\.mp4$/, '_stab.mp4');
  if (!fileExists(stab)) {
    const filters = await availableFilters();
    const common = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'];
    if (filters.has('vidstabdetect')) {
      const trf = stab + '.trf';
      const shak = Math.max(1, Math.min(10, Math.round(strength)));
      await runFfmpeg(['-i', item.proxy, '-vf', `vidstabdetect=shakiness=${shak}:accuracy=15:result='${escapeFilterPath(trf)}'`, '-f', 'null', '-'], { lowPriority: true });
      await runFfmpeg(['-i', item.proxy, '-vf', `vidstabtransform=input='${escapeFilterPath(trf)}':smoothing=${Math.round(5 + strength * 3)}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6:3:3:0`, ...common, stab], { lowPriority: true });
      try { fs.rmSync(trf, { force: true }); } catch { /* ignorieren */ }
    } else if (filters.has('deshake')) {
      await runFfmpeg(['-i', item.proxy, '-vf', `deshake=rx=${Math.round(16 + strength * 2)}:ry=${Math.round(16 + strength * 2)}:edge=mirror`, ...common, stab], { lowPriority: true });
    } else {
      return;
    }
  }
  update({ ...item, proxyStabilized: stab });
}
