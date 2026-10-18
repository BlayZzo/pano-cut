import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import log from 'electron-log';
import type { Clip, ExportOptions, ExportProgress, MediaItem, Project } from '@shared/types';
import { clipEnd, projectDuration, sourceTimeAt, videoTracksBottomUp } from '@shared/timeline';
import { availableEncoders, FfmpegError, runFfmpeg } from './ffmpeg';
import { reverseVideo } from './reverse';

type ProgressFn = (p: Omit<ExportProgress, 'jobId'>) => void;

interface Segment {
  clip: Clip;
  media: MediaItem;
  file: string;        // tatsächliche Eingabedatei (ggf. vorab umgekehrt)
  srcIn: number;       // Quell-Startpunkt in `file`
  srcDur: number;      // Länge in der Quelle (Sekunden)
  tlStart: number;     // Position auf der Timeline (relativ zum Exportbereich)
  tlDur: number;       // Länge auf der Timeline
  isImage: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  inputIndex: number;
}

function fnum(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toString();
}

function esc(v: string): string {
  // Werte in Filterausdrücken: Kommas/Doppelpunkte maskieren
  return v.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/'/g, "\\'");
}

function atempoChain(speed: number): string[] {
  const parts: string[] = [];
  let s = speed;
  while (s > 100) { parts.push('atempo=100'); s /= 100; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) parts.push(`atempo=${fnum(s)}`);
  return parts;
}

function qualityCrf(codec: string, q: ExportOptions['quality']): number {
  const table: Record<string, Record<string, number>> = {
    h264: { low: 28, medium: 23, high: 19, max: 15 },
    h265: { low: 30, medium: 26, high: 22, max: 18 },
    vp9: { low: 40, medium: 33, high: 28, max: 22 },
  };
  return table[codec]?.[q] ?? 20;
}

function qualityBitrate(opts: ExportOptions): number {
  const bpp = { low: 0.05, medium: 0.08, high: 0.12, max: 0.2 }[opts.quality];
  return Math.round(opts.width * opts.height * opts.fps * bpp);
}

export class ExportJob {
  private controller = new AbortController();
  private tempDir: string;

  constructor(private project: Project, private options: ExportOptions, private onProgress: ProgressFn) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panocut-export-'));
  }

  cancel(): void {
    this.controller.abort();
  }

  async run(): Promise<string> {
    try {
      this.onProgress({ phase: 'preparing', percent: 0, message: 'Vorbereitung …' });
      const segments = await this.collectSegments();
      const total = this.totalDuration();
      if (total <= 0 || segments.length === 0) throw new Error('Die Timeline ist leer – es gibt nichts zu exportieren.');

      const encoders = await availableEncoders();
      let hardware = this.options.hardware;
      for (let attempt = 0; attempt < 2; attempt++) {
        const args = this.buildArgs(segments, total, hardware, encoders);
        this.onProgress({ phase: 'rendering', percent: 0, message: hardware ? 'Rendern (Hardware) …' : 'Rendern …' });
        const startedAt = Date.now();
        try {
          await runFfmpeg(args, {
            signal: this.controller.signal,
            onProgress: (p) => {
              const frac = Math.min(1, p.outTime / total);
              const elapsed = (Date.now() - startedAt) / 1000;
              const eta = frac > 0.02 ? elapsed * (1 - frac) / frac : undefined;
              this.onProgress({ phase: 'rendering', percent: Math.round(frac * 100), fps: p.fps, speed: p.speed, eta });
            },
          });
          this.onProgress({ phase: 'done', percent: 100, outputPath: this.options.outputPath, message: 'Fertig' });
          return this.options.outputPath;
        } catch (err) {
          if (this.controller.signal.aborted) throw err;
          if (hardware && err instanceof FfmpegError) {
            log.warn('Hardware-Encoder fehlgeschlagen, wechsle auf Software:', err.message);
            hardware = false;
            continue;
          }
          throw err;
        }
      }
      throw new Error('Export fehlgeschlagen');
    } catch (err) {
      if (this.controller.signal.aborted) {
        this.onProgress({ phase: 'cancelled', percent: 0, message: 'Abgebrochen' });
        try { fs.rmSync(this.options.outputPath, { force: true }); } catch { /* ignorieren */ }
      } else {
        this.onProgress({ phase: 'error', percent: 0, message: (err as Error).message });
      }
      throw err;
    } finally {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  private range(): { start: number; end: number } {
    const dur = projectDuration(this.project);
    const r = this.options.range;
    if (r && r.end > r.start) return { start: Math.max(0, r.start), end: Math.min(dur, r.end) };
    return { start: 0, end: dur };
  }

  private totalDuration(): number {
    const r = this.range();
    return r.end - r.start;
  }

  private async collectSegments(): Promise<Segment[]> {
    const { project } = this;
    const r = this.range();
    const segs: Segment[] = [];
    const videoTracks = videoTracksBottomUp(project).filter((t) => !t.hidden);
    const audioTracks = project.tracks.filter((t) => t.kind === 'audio' && !t.muted);
    const orderedTracks = [...videoTracks, ...audioTracks];

    const reversedJobs: Array<() => Promise<void>> = [];

    for (const track of orderedTracks) {
      const clips = Object.values(project.clips).filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
      for (const clip of clips) {
        const media = project.media[clip.mediaId];
        if (!media || media.status === 'error' || !fs.existsSync(media.path)) continue;
        const segStart = Math.max(clip.start, r.start);
        const segEnd = Math.min(clipEnd(clip), r.end);
        if (segEnd - segStart <= 0.001) continue;
        const sA = sourceTimeAt(clip, segStart);
        const sB = sourceTimeAt(clip, segEnd);
        const srcIn = Math.min(sA, sB);
        const srcDur = Math.max(0.001, Math.abs(sB - sA));
        const isImage = media.type === 'image';
        const hasVideo = track.kind === 'video' && media.type !== 'audio';
        const hasAudio = media.info.hasAudio && !clip.muted && !(track.kind === 'video' && track.muted) && clip.volume > 0;
        const seg: Segment = {
          clip, media, file: media.path, srcIn, srcDur,
          tlStart: segStart - r.start, tlDur: segEnd - segStart,
          isImage, hasAudio, hasVideo, inputIndex: -1,
        };
        if (clip.reverse && !isImage) {
          // Vorab umgekehrt rendern (stückweise, speicherschonend)
          const out = path.join(this.tempDir, `rev_${clip.id}.mov`);
          reversedJobs.push(async () => {
            const fit = `scale=w=${this.options.width}:h=${this.options.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
            await reverseVideo(media.path, out, {
              start: srcIn, duration: srcDur,
              videoFilter: hasVideo ? fit : undefined,
              fps: this.options.fps,
              hasAudio: media.info.hasAudio,
              width: Math.min(media.info.width || this.options.width, this.options.width),
              height: Math.min(media.info.height || this.options.height, this.options.height),
              signal: this.controller.signal,
            });
            seg.file = out;
            seg.srcIn = 0;
          });
        }
        segs.push(seg);
      }
    }

    for (let i = 0; i < reversedJobs.length; i++) {
      this.onProgress({ phase: 'preparing', percent: Math.round((i / reversedJobs.length) * 100), message: `Rückwärts-Clip ${i + 1} von ${reversedJobs.length} vorbereiten …` });
      await reversedJobs[i]();
    }
    segs.forEach((s, i) => (s.inputIndex = i));
    return segs;
  }

  private buildArgs(segs: Segment[], total: number, hardware: boolean, encoders: Set<string>): string[] {
    const o = this.options;
    const { width: W, height: H, fps } = o;
    const args: string[] = [];

    // ---- Eingaben ----
    for (const s of segs) {
      if (s.isImage) {
        args.push('-loop', '1', '-framerate', String(fps), '-t', fnum(s.tlDur), '-i', s.file);
      } else {
        args.push('-ss', fnum(s.srcIn), '-t', fnum(s.srcDur), '-i', s.file);
      }
    }
    // Stille als Basis, damit immer eine Tonspur existiert (GIF hat keinen Ton)
    const wantAudio = o.codec !== 'gif';
    const silenceIdx = segs.length;
    if (wantAudio) args.push('-f', 'lavfi', '-t', fnum(total), '-i', 'anullsrc=r=48000:cl=stereo');

    const filters: string[] = [];
    const bg = this.project.settings.background || '#000000';
    filters.push(`color=c=${esc(bg)}:s=${W}x${H}:r=${fps}:d=${fnum(total)},format=yuv420p[base]`);

    // ---- Video-Ketten ----
    let last = 'base';
    let vi = 0;
    for (const s of segs) {
      if (!s.hasVideo) continue;
      const c = s.clip;
      const chain: string[] = [];
      chain.push('setpts=PTS-STARTPTS');
      if (!s.isImage && Math.abs(c.speed - 1) > 1e-6) chain.push(`setpts=PTS/${fnum(c.speed)}`);
      chain.push(`fps=${fps}`);
      // Einpassen
      if (c.fit === 'cover') chain.push(`scale=w=${W}:h=${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
      else if (c.fit === 'stretch') chain.push(`scale=${W}:${H}`);
      else chain.push(`scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
      // Farbe
      const col = c.color;
      const eqParts: string[] = [];
      if (Math.abs(col.brightness) > 1e-4) eqParts.push(`brightness=${fnum(col.brightness)}`);
      if (Math.abs(col.contrast - 1) > 1e-4) eqParts.push(`contrast=${fnum(col.contrast)}`);
      if (Math.abs(col.saturation - 1) > 1e-4) eqParts.push(`saturation=${fnum(col.saturation)}`);
      if (eqParts.length) chain.push(`eq=${eqParts.join(':')}`);
      if (Math.abs(col.hue) > 1e-4) chain.push(`hue=h=${fnum(col.hue)}`);
      chain.push('format=rgba');
      // Transformation
      const t = c.transform;
      if (Math.abs(t.scale - 1) > 1e-4) chain.push(`scale=w=trunc(iw*${fnum(t.scale)}/2)*2:h=trunc(ih*${fnum(t.scale)}/2)*2:flags=bicubic`);
      if (Math.abs(t.rotation) > 1e-4) chain.push(`rotate=a=${fnum(t.rotation)}*PI/180:ow=ceil(hypot(iw\\,ih)/2)*2:oh=ow:c=none`);
      if (c.opacity < 0.999) chain.push(`colorchannelmixer=aa=${fnum(Math.max(0, c.opacity))}`);
      chain.push(`setpts=PTS+${fnum(s.tlStart)}/TB`);
      const label = `v${vi}`;
      filters.push(`[${s.inputIndex}:v]${chain.join(',')}[${label}]`);
      const dx = (t.x / 100) * W;
      const dy = (t.y / 100) * H;
      const outLabel = `ov${vi}`;
      const end = s.tlStart + s.tlDur;
      filters.push(`[${last}][${label}]overlay=x=(W-w)/2+${fnum(dx)}:y=(H-h)/2+${fnum(dy)}:eof_action=pass:enable='between(t,${fnum(s.tlStart)},${fnum(end)})'[${outLabel}]`);
      last = outLabel;
      vi++;
    }
    const finalPix = o.codec === 'prores' ? 'yuv422p10le' : 'yuv420p';
    let videoOut = 'vout';
    if (o.codec === 'gif') {
      filters.push(`[${last}]format=rgb24,split[gifa][gifb];[gifa]palettegen=stats_mode=diff[pal];[gifb][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]`);
    } else {
      filters.push(`[${last}]format=${finalPix}[vout]`);
    }

    // ---- Audio-Ketten ----
    const audioLabels: string[] = [];
    let ai = 0;
    for (const s of segs) {
      if (!wantAudio || !s.hasAudio || s.isImage) continue;
      const c = s.clip;
      const chain: string[] = ['asetpts=PTS-STARTPTS'];
      chain.push(...atempoChain(c.speed));
      if (Math.abs(c.volume - 1) > 1e-4) chain.push(`volume=${fnum(c.volume)}`);
      if (c.fadeIn > 0.01) chain.push(`afade=t=in:st=0:d=${fnum(Math.min(c.fadeIn, s.tlDur))}`);
      if (c.fadeOut > 0.01) chain.push(`afade=t=out:st=${fnum(Math.max(0, s.tlDur - c.fadeOut))}:d=${fnum(Math.min(c.fadeOut, s.tlDur))}`);
      chain.push(`atrim=0:${fnum(s.tlDur)}`);
      chain.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
      const ms = Math.round(s.tlStart * 1000);
      if (ms > 0) chain.push(`adelay=${ms}:all=1`);
      const label = `a${ai}`;
      filters.push(`[${s.inputIndex}:a]${chain.join(',')}[${label}]`);
      audioLabels.push(label);
      ai++;
    }
    if (wantAudio) {
      const allAudio = [`[${silenceIdx}:a]`, ...audioLabels.map((l) => `[${l}]`)].join('');
      filters.push(`${allAudio}amix=inputs=${audioLabels.length + 1}:duration=first:normalize=0,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
    }

    args.push('-filter_complex', filters.join(';'));
    args.push('-map', '[vout]');
    if (wantAudio) args.push('-map', '[aout]');

    // ---- Encoder ----
    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';
    const crf = qualityCrf(o.codec, o.quality);
    const bitrate = qualityBitrate(o);
    switch (o.codec) {
      case 'h264': {
        if (hardware && isMac && encoders.has('h264_videotoolbox')) {
          args.push('-c:v', 'h264_videotoolbox', '-b:v', String(bitrate), '-allow_sw', '1', '-realtime', '0', '-profile:v', 'high');
        } else if (hardware && isWin && encoders.has('h264_nvenc')) {
          args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0');
        } else if (hardware && isWin && encoders.has('h264_qsv')) {
          args.push('-c:v', 'h264_qsv', '-global_quality', String(crf));
        } else if (hardware && isWin && encoders.has('h264_amf')) {
          args.push('-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', String(bitrate));
        } else {
          args.push('-c:v', 'libx264', '-preset', o.quality === 'max' ? 'slow' : 'medium', '-crf', String(crf), '-profile:v', 'high');
        }
        break;
      }
      case 'h265': {
        if (hardware && isMac && encoders.has('hevc_videotoolbox')) {
          args.push('-c:v', 'hevc_videotoolbox', '-b:v', String(bitrate), '-allow_sw', '1', '-realtime', '0');
        } else if (hardware && isWin && encoders.has('hevc_nvenc')) {
          args.push('-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0');
        } else if (hardware && isWin && encoders.has('hevc_qsv')) {
          args.push('-c:v', 'hevc_qsv', '-global_quality', String(crf));
        } else if (hardware && isWin && encoders.has('hevc_amf')) {
          args.push('-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', String(bitrate));
        } else {
          args.push('-c:v', 'libx265', '-preset', o.quality === 'max' ? 'slow' : 'medium', '-crf', String(crf));
        }
        args.push('-tag:v', 'hvc1');
        break;
      }
      case 'prores':
        args.push('-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-qscale:v', o.quality === 'max' ? '5' : '9');
        break;
      case 'vp9':
        args.push('-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2');
        break;
      case 'gif':
        break;
    }
    if (o.codec !== 'gif') {
      if (o.format === 'webm') args.push('-c:a', 'libopus', '-b:a', `${o.audioBitrate}k`);
      else args.push('-c:a', 'aac', '-b:a', `${o.audioBitrate}k`);
    }
    if (o.format === 'mp4' || o.format === 'mov') args.push('-movflags', '+faststart');
    args.push('-t', fnum(total), '-threads', '0', o.outputPath);
    return args;
  }
}
