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
      pixFmt: v?.pix_fmt,
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
export interface PrepareOptions {
  reversed?: boolean;
  stabilized?: number;
  /** 'quick' = nur Vorschaubild, Streifen, Wellenform; 'heavy' = nur Proxy & Varianten; Standard: alles */
  stage?: 'quick' | 'heavy' | 'all';
  proxyMode?: 'auto' | 'always';
  skipProxy?: boolean;   // vom Nutzer übersprungen
}

export async function prepareMedia(item: MediaItem, update: MediaUpdateFn, proxyHeight = 540, options: PrepareOptions = {}): Promise<void> {
  const quick = options.stage !== 'heavy';
  const heavy = options.stage !== 'quick';
  if (item.status === 'error') return;
  const dir = mediaCacheDir(item.path);
  const work: MediaItem = { ...item };
  const emit = () => update({ ...work });
  const dur = work.info.duration;
  // Fortschritt melden (höchstens 3× pro Sekunde), mit geschätzter Restzeit
  let lastReport = 0;
  const report = (stage: NonNullable<MediaItem['prep']>['stage'], percent: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 300) return;
    lastReport = now;
    const prev = work.prep;
    const startedAt = prev && prev.stage === stage && prev.startedAt ? prev.startedAt : now;
    const elapsed = (now - startedAt) / 1000;
    const etaSec = percent > 2 && elapsed > 1.5 ? Math.round((elapsed * (100 - percent)) / percent) : undefined;
    work.prep = { stage, percent: Math.max(0, Math.min(100, Math.round(percent))), etaSec, startedAt };
    emit();
  };

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
    // Braucht die Datei eine eigene Vorschau-Datei? Normale Full-HD-H.264-Videos (Handy, Kamera) spielen direkt flüssig.
    const willProxy = !options.skipProxy && needsProxy(work, options.proxyMode ?? 'auto');
    // 360°-Rohvideos: zuerst den gestitchten Proxy erzeugen; Vorschaubilder kommen dann daraus.
    const stitched = needsStitching(work.stitch);
    let visualSource = work.path;
    if (stitched && work.stitch) {
      if (!heavy) {
        // Schnell: erst ein Rohbild als Vorschaubild – das Zusammensetzen (dauert) folgt im Hintergrund
        const done = path.join(dir, 'thumb.jpg');
        const raw = path.join(dir, 'thumb_raw.jpg');
        if (!fileExists(done) && !fileExists(raw)) {
          const at = Math.min(Math.max(0, dur * 0.1), 3);
          await runFfmpeg(['-ss', at.toFixed(3), '-i', work.path, '-map', '0:v:0', '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '4', raw], { lowPriority: true });
        }
        work.thumb = fileExists(done) ? done : raw;
        emit();
        return;
      }
      report('stitch', 0, true);
      const proxy = await buildProxy(work, dir, Math.max(proxyHeight, PANO_PROXY_HEIGHT), (pc) => report('stitch', pc));
      work.proxy = proxy;
      visualSource = proxy;
      emit();
    }

    if (quick || stitched) {
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
      // Nur Schlüsselbilder dekodieren (viel schneller bei langen 4K-Videos); bei sehr kurzen Videos alle Bilder
      const keyOnly = dur > SPRITE_FRAMES * 1.5 ? ['-skip_frame', 'nokey'] : [];
      const spriteArgs = (extra: string[]) => [
        ...extra, '-i', visualSource,
        '-vf', `fps=${rate.toFixed(6)},scale=${SPRITE_WIDTH}:-2,tile=${frames}x1`,
        '-frames:v', '1', '-q:v', '5', sprite,
      ];
      try {
        await runFfmpeg(spriteArgs(keyOnly), { lowPriority: true });
      } catch (e) {
        if (!keyOnly.length) throw e;
        await runFfmpeg(spriteArgs([]), { lowPriority: true });
      }
    }
    const sh = Math.round((SPRITE_WIDTH * work.info.height) / Math.max(1, work.info.width) / 2) * 2;
    work.sprite = { path: sprite, frames, frameWidth: SPRITE_WIDTH, frameHeight: sh || 90 };
    emit();

    if (work.info.hasAudio && (!willProxy || fileExists(path.join(dir, 'wave.png')))) {
      const wave = path.join(dir, 'wave.png');
      if (!fileExists(wave)) {
        try {
          await runFfmpeg([
            '-vn', '-i', work.path,
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
    }
    if (!heavy) return;

    // Proxy: kleine, schnell spulbare Vorschau-Datei
    if (!stitched && willProxy) {
      report('proxy', 0, true);
      work.proxy = await buildProxy(work, dir, proxyHeight, (pc) => report('proxy', pc));
    }
    // Tonwelle aus der kleinen Vorschau-Datei (viel schneller als aus dem Original)
    const wave = path.join(dir, 'wave.png');
    if (work.info.hasAudio && !fileExists(wave) && work.proxy) {
      report('wave', 100, true);
      try {
        await runFfmpeg(['-vn', '-i', work.proxy, '-filter_complex', 'aformat=channel_layouts=mono,compand=gain=-2,showwavespic=s=2000x80:colors=#5eead4:scale=sqrt', '-frames:v', '1', wave], { lowPriority: true });
        work.waveform = wave;
      } catch (e) { log.warn('Wellenform fehlgeschlagen', e); }
    } else if (fileExists(wave)) work.waveform = wave;
    work.prep = undefined;
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
  const src = item.proxy && fileExists(item.proxy) ? item.proxy : item.path;
  const rev = path.join(mediaCacheDir(item.path), item.proxy ? `${path.basename(item.proxy, '.mp4')}_rev.mp4` : 'orig_rev.mp4');
  if (!fileExists(rev)) {
    const h = Math.min(540, item.info.height || 540);
    const w = Math.round((h * (item.info.width || 960)) / Math.max(1, item.info.height || 540));
    await reverseVideo(src, rev, { hasAudio: item.info.hasAudio, width: w, height: h, fps: 30, crf: 23 });
  }
  update({ ...item, proxyReversed: rev });
}

/** Erzeugt die Vorschau-Datei (Proxy); 360°-Rohvideos werden dabei zusammengesetzt. */
async function buildProxy(work: MediaItem, dir: string, height: number, onPercent: (p: number) => void): Promise<string> {
  const stitched = needsStitching(work.stitch);
  const key = stitched && work.stitch ? `${height}_s${Math.round(work.stitch.fov * 10)}_${Math.round(work.stitch.yaw * 10)}_${Math.round(work.stitch.pitch * 10)}_${Math.round(work.stitch.roll * 10)}` : `${height}`;
  const proxy = path.join(dir, `proxy_${key}.mp4`);
  if (fileExists(proxy)) return proxy;
  // Erst in eine Zwischendatei schreiben – ein abgebrochener Lauf hinterlässt so keine kaputte Vorschau-Datei
  const part = path.join(dir, `proxy_${key}.part.mp4`);
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
  const tail = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', part];
  const software = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p', '-threads', '0'];
  const dur = Math.max(0.1, work.info.duration);
  const onProgress = (p: { outTime: number }) => onPercent((p.outTime / dur) * 100);
  const finish = () => { fs.renameSync(part, proxy); return proxy; };
  // Mac: Grafikchip dekodiert und kodiert (spart Akku und ist mehrfach schneller); bei Problemen normal weiter
  if (process.platform === 'darwin') {
    const bitrate = `${Math.max(1, Math.round((h / 540) * (stitched ? 5 : 3.5)))}M`;
    try {
      await runFfmpeg(['-hwaccel', 'videotoolbox', ...args, '-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-g', '15', '-pix_fmt', 'yuv420p', '-allow_sw', '1', ...tail], { lowPriority: true, onProgress });
      return finish();
    } catch (e) {
      log.warn('Proxy per Grafikchip fehlgeschlagen, nehme Software', (e as Error).message);
      try { fs.rmSync(part, { force: true }); } catch { /* egal */ }
    }
  }
  await runFfmpeg([...args, ...software, ...tail], { lowPriority: true, onProgress });
  return finish();
}

/** Braucht diese Datei eine eigene Vorschau-Datei? (Full-HD-H.264 in 8 Bit spielt direkt flüssig.) */
export function needsProxy(item: MediaItem, mode: 'auto' | 'always'): boolean {
  if (item.type !== 'video') return false;
  if (mode === 'always' || needsStitching(item.stitch)) return true;
  const i = item.info;
  const ext = path.extname(item.path).toLowerCase();
  const easy = i.videoCodec === 'h264' && (!i.pixFmt || /^yuvj?420p$/.test(i.pixFmt))
    && Math.min(i.width, i.height) <= 1088 && Math.max(i.width, i.height) <= 1928 && (i.fps || 30) <= 61
    && ['.mp4', '.mov', '.m4v'].includes(ext) && !i.is360;
  return !easy;
}

/** Erzeugt eine stabilisierte Variante des Proxys (vidstab in zwei Durchgängen, sonst deshake). */
export async function ensureStabilizedProxy(item: MediaItem, update: MediaUpdateFn, strength = 5): Promise<void> {
  const src = item.proxy && fileExists(item.proxy) ? item.proxy : item.path;
  const stab = path.join(mediaCacheDir(item.path), item.proxy ? `${path.basename(item.proxy, '.mp4')}_stab.mp4` : 'orig_stab.mp4');
  if (!fileExists(stab)) {
    const filters = await availableFilters();
    const common = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
    const small = src === item.path ? 'scale=-2:540,' : '';
    if (filters.has('vidstabdetect')) {
      const trf = stab + '.trf';
      const shak = Math.max(1, Math.min(10, Math.round(strength)));
      await runFfmpeg(['-i', src, '-vf', `${small}vidstabdetect=shakiness=${shak}:accuracy=15:result='${escapeFilterPath(trf)}'`, '-f', 'null', '-'], { lowPriority: true });
      await runFfmpeg(['-i', src, '-vf', `${small}vidstabtransform=input='${escapeFilterPath(trf)}':smoothing=${Math.round(5 + strength * 3)}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6:3:3:0`, ...common, stab], { lowPriority: true });
      try { fs.rmSync(trf, { force: true }); } catch { /* ignorieren */ }
    } else if (filters.has('deshake')) {
      await runFfmpeg(['-i', src, '-vf', `${small}deshake=rx=${Math.round(16 + strength * 2)}:ry=${Math.round(16 + strength * 2)}:edge=mirror`, ...common, stab], { lowPriority: true });
    } else {
      return;
    }
  }
  update({ ...item, proxyStabilized: stab });
}
