import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import log from 'electron-log';
import type { Attachment, Clip, ExportOptions, ExportProgress, MediaItem, Project, TitleStyle, Track, TransitionType } from '@shared/types';
import { charsPerLine, subtitleChangeTimes, subtitleViewAt } from '@shared/subtitles';
import { dynTransitionAt, isDynamicTransition, type DynamicTransition, type DynLayer } from '@shared/transitions';
import { clipDuration, clipEnd, projectDuration, sourceTimeAt, videoTracksBottomUp } from '@shared/timeline';
import { fontDef, panoViewAt, stereographicVfov, titleAnimationAt, verticalFov } from '@shared/pano';
import { availableEncoders, availableFilters, FfmpegError, probeFile, runFfmpeg } from './ffmpeg';
import { reverseVideo } from './reverse';
import { needsStitching, stitchChain } from './stitch';
import { escapeFilterPath, fontFamilyName, resolveFontFile } from './fonts';
import { injectSphericalMetadata } from './spherical';
import { maskChain, writeMaskList } from './objects';
import { blendDef, hasShadow, shadowPixels } from '@shared/layers';
import { bakeGradeLut, exposureGainAt, gradeForLut, gradeKey, hasExposureCurve, isNeutralGrade, lutToCube, parseCube } from '@shared/color';
import { hasGeometryMotion, hasOpacityMotion } from '@shared/effects';
import { dynCorners, exposureCommands, framePiecewise, opacityCommands, perspectiveCorners } from './motionExpr';
import { trackBoxAt } from '@shared/ai';

type ProgressFn = (p: Omit<ExportProgress, 'jobId'>) => void;

interface Segment {
  clip: Clip;
  track: Track;
  media: MediaItem | null;   // null bei Titel-Clips
  file: string;              // tatsächliche Eingabedatei (ggf. vorab umgekehrt)
  srcIn: number;             // Quell-Startpunkt in `file`
  srcDur: number;            // Länge in der Quelle (Sekunden)
  tlStart: number;           // Position auf der Timeline (relativ zum Exportbereich)
  tlDur: number;             // Länge auf der Timeline
  localOffset: number;       // Clip-lokale Zeit, bei der dieses Segment beginnt (0, außer bei Bereichs-Export)
  isImage: boolean;
  isTitle: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  inputIndex: number;
  reversedFile: boolean;
  stabFile?: string;         // vidstab-Transformdatei
  maskInput?: number;        // Eingabe-Index der Maskensequenz (Freistellen)
  maskList?: string;
  cutSize?: { w: number; h: number };  // Bildgröße des freigestellten Clips vor dem Einrechnen der Maske
}

interface TransitionSeg {
  a: Segment;
  b: Segment;
  type: TransitionType;
  intensity: number;
  duration: number;
  cut: number;               // Schnittpunkt (relativ zum Exportbereich)
  inputA: number;            // zusätzliche Eingaben (Fenster um den Schnitt)
  inputB: number;
  srcA: number; padA: number;
  srcB: number; padB: number;
}

function fnum(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toString();
}

function esc(v: string): string {
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

/** Farbe '#rrggbb' + Deckkraft → FFmpeg-Farbe '0xrrggbb@a' */
function ffColor(hex: string, alpha = 1): string {
  const h = hex.replace('#', '');
  return `0x${h.length === 6 ? h : 'ffffff'}@${fnum(Math.max(0, Math.min(1, alpha)))}`;
}

export class ExportJob {
  private controller = new AbortController();
  private tempDir: string;
  private tmpCounter = 0;
  private filters = new Set<string>();
  private currentSegments: Segment[] = [];
  private lutCache = new Map<string, string>();

  constructor(private project: Project, private options: ExportOptions, private onProgress: ProgressFn) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panocut-export-'));
  }

  cancel(): void {
    this.controller.abort();
  }

  async run(): Promise<string> {
    try {
      this.onProgress({ phase: 'preparing', percent: 0, message: 'Vorbereitung …' });
      this.filters = await availableFilters();
      const segments = await this.collectSegments();
      const transitions = this.collectTransitions(segments);
      const total = this.totalDuration();
      if (total <= 0 || segments.length === 0) throw new Error('Die Timeline ist leer – es gibt nichts zu exportieren.');
      await this.prepareStabilization(segments);
      await this.prepareCutoutSizes(segments);

      const encoders = await availableEncoders();
      let hardware = this.options.hardware;
      const twoPass = !!this.options.maxSizeMB && !hardware && (this.options.codec === 'h264' || this.options.codec === 'h265');
      for (let attempt = 0; attempt < 2; attempt++) {
        this.onProgress({ phase: 'rendering', percent: 0, message: hardware ? 'Rendern (Hardware) …' : 'Rendern …' });
        const startedAt = Date.now();
        try {
          if (twoPass) {
            const logFile = path.join(this.tempDir, 'pass');
            await this.render(this.buildArgs(segments, transitions, total, hardware, encoders, { pass: 1, logFile }), total, startedAt, 0, 0.5, 'Durchgang 1 von 2 (Analyse) …');
            await this.render(this.buildArgs(segments, transitions, total, hardware, encoders, { pass: 2, logFile }), total, Date.now(), 0.5, 1, 'Durchgang 2 von 2 …');
          } else {
            await this.render(this.buildArgs(segments, transitions, total, hardware, encoders, {}), total, startedAt, 0, 1);
          }
          if (this.options.spherical && (this.options.format === 'mp4' || this.options.format === 'mov')) {
            this.onProgress({ phase: 'rendering', percent: 99, message: '360°-Metadaten einfügen …' });
            try { await injectSphericalMetadata(this.options.outputPath); } catch (e) { log.warn('360°-Metadaten fehlgeschlagen', e); }
          }
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

  private async render(args: string[], total: number, startedAt: number, from: number, to: number, message?: string): Promise<void> {
    await runFfmpeg(args, {
      signal: this.controller.signal,
      onProgress: (p) => {
        const frac = Math.min(1, p.outTime / total);
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = frac > 0.02 ? (elapsed * (1 - frac)) / frac : undefined;
        this.onProgress({ phase: 'rendering', percent: Math.round((from + frac * (to - from)) * 100), fps: p.fps, speed: p.speed, eta, message });
      },
    });
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

  private tmpFile(name: string): string {
    return path.join(this.tempDir, `${this.tmpCounter++}_${name}`);
  }

  // ---------------------------------------------------------------- Segmente

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
        const segStart = Math.max(clip.start, r.start);
        const segEnd = Math.min(clipEnd(clip), r.end);
        if (segEnd - segStart <= 0.001) continue;
        if (clip.kind === 'title') {
          if (track.kind !== 'video') continue;
          segs.push({
            clip, track, media: null, file: '', srcIn: 0, srcDur: segEnd - segStart,
            tlStart: segStart - r.start, tlDur: segEnd - segStart, localOffset: segStart - clip.start,
            isImage: false, isTitle: true, hasAudio: false, hasVideo: true, inputIndex: -1, reversedFile: false,
          });
          continue;
        }
        const media = project.media[clip.mediaId];
        if (!media || media.status === 'error' || !fs.existsSync(media.path)) continue;
        const sA = sourceTimeAt(clip, segStart);
        const sB = sourceTimeAt(clip, segEnd);
        const srcIn = Math.min(sA, sB);
        const srcDur = Math.max(0.001, Math.abs(sB - sA));
        const isImage = media.type === 'image';
        const hasVideo = track.kind === 'video' && media.type !== 'audio';
        const hasAudio = media.info.hasAudio && !clip.muted && !(track.kind === 'video' && track.muted) && clip.volume > 0;
        const seg: Segment = {
          clip, track, media, file: media.path, srcIn, srcDur,
          tlStart: segStart - r.start, tlDur: segEnd - segStart, localOffset: segStart - clip.start,
          isImage, isTitle: false, hasAudio, hasVideo, inputIndex: -1, reversedFile: false,
        };
        if (clip.reverse && !isImage) {
          const out = this.tmpFile(`rev_${clip.id}.mov`);
          reversedJobs.push(async () => {
            const stitched = hasVideo && needsStitching(media.stitch);
            const two = media.stitch?.mode === 'dualfisheye-2streams';
            // Beim Umkehren direkt stitchen, damit die weitere Kette wie bei normalen Clips aussieht
            let videoFilter: string | undefined;
            if (hasVideo) {
              const fit = `scale=w=${this.options.width * (stitched ? 2 : 1)}:h=${this.options.height * (stitched ? 2 : 1)}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
              videoFilter = stitched && media.stitch
                ? stitchChain(media.stitch, ['', ''], media.info.width, media.info.height) + ',' + fit
                : fit;
            }
            await reverseVideo(media.path, out, {
              start: srcIn, duration: srcDur,
              videoFilter,
              complexInputs: two && stitched ? ['[0:v:0]', '[0:v:1]'] : undefined,
              fps: this.options.fps,
              hasAudio: media.info.hasAudio,
              width: Math.min(media.info.width || this.options.width, this.options.width * 2),
              height: Math.min(media.info.height || this.options.height, this.options.height * 2),
              signal: this.controller.signal,
            });
            seg.file = out;
            seg.srcIn = 0;
            seg.reversedFile = true;
          });
        }
        segs.push(seg);
      }
    }

    for (let i = 0; i < reversedJobs.length; i++) {
      this.onProgress({ phase: 'preparing', percent: Math.round((i / reversedJobs.length) * 100), message: `Rückwärts-Clip ${i + 1} von ${reversedJobs.length} vorbereiten …` });
      await reversedJobs[i]();
    }
    let idx = 0;
    for (const s of segs) if (!s.isTitle) s.inputIndex = idx++;
    return segs;
  }

  /** Übergänge zwischen benachbarten Clips derselben Spur. */
  private collectTransitions(segs: Segment[]): TransitionSeg[] {
    const out: TransitionSeg[] = [];
    const fps = this.options.fps;
    const r = this.range();
    for (const b of segs) {
      const tr = b.clip.transition;
      if (!tr || !b.hasVideo || b.isTitle) continue;
      const a = segs.find((s) => s.track.id === b.track.id && s !== b && s.hasVideo && !s.isTitle && Math.abs(clipEnd(s.clip) - b.clip.start) < 1 / fps);
      if (!a) continue;
      const cut = b.clip.start - r.start;
      const d = Math.min(tr.duration, clipDuration(a.clip), clipDuration(b.clip));
      if (d < 2 / fps) continue;
      if (cut - d / 2 < 0 || cut + d / 2 > this.totalDuration()) continue;
      // Quellfenster: A über sein Ende hinaus, B vor seinem Anfang
      const half = d / 2;
      const windowStart = cut - half;
      let srcA: number, padA = 0, srcB: number, padB = 0;
      if (a.reversedFile) {
        srcA = a.srcDur - half * a.clip.speed; // Ende der umgekehrten Datei
        if (srcA < 0) { padA = -srcA / a.clip.speed; srcA = 0; }
      } else {
        srcA = sourceTimeAt(a.clip, windowStart + r.start) + (a.isImage ? 0 : 0);
      }
      if (b.reversedFile) {
        srcB = 0;
        padB = half;
      } else {
        srcB = b.isImage ? 0 : sourceTimeAt(b.clip, cut + r.start) - half * b.clip.speed;
        if (srcB < 0) { padB = -srcB / b.clip.speed; srcB = 0; }
      }
      out.push({ a, b, type: tr.type, intensity: tr.intensity ?? 1, duration: d, cut, inputA: -1, inputB: -1, srcA: Math.max(0, srcA), padA, srcB: Math.max(0, srcB), padB });
    }
    return out;
  }

  /** Stabilisierung: Analyse-Durchgang (vidstabdetect) pro Clip. */
  private async prepareStabilization(segs: Segment[]): Promise<void> {
    const targets = segs.filter((s) => s.hasVideo && !s.isImage && !s.isTitle && s.clip.stabilize?.enabled);
    if (targets.length === 0) return;
    if (!this.filters.has('vidstabdetect')) {
      log.warn('vidstab nicht verfügbar – benutze deshake');
      return;
    }
    for (let i = 0; i < targets.length; i++) {
      const s = targets[i];
      this.onProgress({ phase: 'preparing', percent: Math.round((i / targets.length) * 100), message: `Stabilisierung analysieren (${i + 1}/${targets.length}) …` });
      const trf = this.tmpFile(`stab_${s.clip.id}.trf`);
      const prefix = this.videoChainPrefix(s, { untilFit: true });
      const shak = Math.max(1, Math.min(10, Math.round(s.clip.stabilize!.strength)));
      const chain = `${this.inputLabel(s, 0)}${prefix.join(',')},vidstabdetect=shakiness=${shak}:accuracy=15:result='${escapeFilterPath(trf)}'`;
      const args = ['-ss', fnum(s.srcIn), '-t', fnum(s.srcDur), '-i', s.file, '-filter_complex', chain, '-f', 'null', '-'];
      await runFfmpeg(args, { signal: this.controller.signal });
      s.stabFile = trf;
    }
  }

  /** Hat dieses Segment eine Freistell-Maske, die im Export eingerechnet wird? */
  private cutoutTrack(s: Segment) {
    const cut = s.clip.cutout;
    const track = cut?.enabled ? s.clip.objects?.find((tr) => tr.id === cut.trackId) : undefined;
    return s.hasVideo && track?.masks?.length ? track : undefined;
  }

  /**
   * Freistellen: Bildgröße des Clips vor dem Einrechnen der Maske einmal messen (ein Bild rendern).
   * Damit lässt sich die Maske mit einem normalen `scale` anpassen – `scale2ref` bleibt in FFmpeg 7 hängen.
   */
  private async prepareCutoutSizes(segs: Segment[]): Promise<void> {
    for (const s of segs) {
      if (!this.cutoutTrack(s)) continue;
      try {
        const parts = this.videoChainParts(s);
        const chain = [...parts.pre, ...parts.color, 'format=rgba'].join(',');
        const args: string[] = [];
        if (s.media?.hasAlpha) args.push('-c:v', 'libvpx-vp9');
        if (s.isImage) args.push('-loop', '1', '-framerate', String(this.options.fps), '-t', '1', '-i', s.file);
        else args.push('-ss', fnum(s.srcIn), '-t', fnum(Math.max(0.1, s.srcDur)), '-i', s.file);
        const out = this.tmpFile(`cutsize_${s.clip.id}.png`);
        await runFfmpeg([...args, '-filter_complex', `${this.inputLabel(s, 0)}${chain}[o]`, '-map', '[o]', '-frames:v', '1', out], { signal: this.controller.signal });
        const info = await probeFile(out);
        const v = info.streams.find((x) => x.codec_type === 'video');
        if (v?.width && v?.height) s.cutSize = { w: v.width, h: v.height };
      } catch (err) {
        if (this.controller.signal.aborted) throw err;
        log.warn('Größe des freigestellten Clips nicht ermittelt – benutze scale2ref', (err as Error).message);
      }
    }
  }

  // ---------------------------------------------------------------- Filterketten

  private inputLabel(seg: Segment, index: number): string {
    const two = seg.media?.stitch?.mode === 'dualfisheye-2streams' && needsStitching(seg.media.stitch) && !seg.reversedFile;
    return two ? `[${index}:v:0][${index}:v:1]` : `[${index}:v]`;
  }

  /**
   * Videokette eines Clips bis einschließlich Einpassen/Farbe/Transformation (ohne Zeitversatz).
   * `untilFit`: nur bis zur Einpassung (für die Stabilisierungs-Analyse).
   */
  private videoChainPrefix(seg: Segment, opts: { untilFit?: boolean; localOffset?: number; pad?: { start: number; end: number }; forTransition?: boolean } = {}): string[] {
    const parts = this.videoChainParts(seg, opts);
    if (opts.untilFit) return parts.pre;
    return [...parts.pre, ...parts.color, ...parts.post];
  }

  /**
   * Videokette in drei Teilen: `pre` (bis Einpassen), `color` (Farbkorrektur), `post` (Transformation/Deckkraft).
   * Zwischen `color` und `post` werden Freistellen (alphamerge) und Green Screen eingefügt.
   */
  private videoChainParts(seg: Segment, opts: { untilFit?: boolean; localOffset?: number; pad?: { start: number; end: number }; forTransition?: boolean } = {}): { pre: string[]; color: string[]; post: string[]; fullCanvas: boolean } {
    const { width: W, height: H, fps } = this.options;
    const c = seg.clip;
    const media = seg.media!;
    const chain: string[] = [];
    // 360°-Rohvideo zuerst zusammensetzen (bei zwei Streams muss hstack ganz vorn stehen)
    const stitched = needsStitching(media.stitch) && !seg.reversedFile;
    if (stitched && media.stitch) chain.push(stitchChain(media.stitch, ['', ''], media.info.width, media.info.height));
    chain.push('setpts=PTS-STARTPTS');
    if (!seg.isImage && Math.abs(c.speed - 1) > 1e-6) chain.push(`setpts=PTS/${fnum(c.speed)}`);
    chain.push(`fps=${fps}`);
    if (opts.pad) {
      if (opts.pad.start > 0) chain.push(`tpad=start_mode=clone:start_duration=${fnum(opts.pad.start)}`);
      if (opts.pad.end > 0) chain.push(`tpad=stop_mode=clone:stop_duration=${fnum(opts.pad.end)}`);
    }
    // 360°-Ansicht (Reframing)
    if (media.info.is360 && c.pano) {
      chain.push(...this.panoChain(seg, opts.localOffset ?? seg.localOffset));
    }
    // Zuschnitt und Spiegeln
    const cr = c.crop;
    if (cr && cr.left + cr.right + cr.top + cr.bottom > 0.01) {
      const kw = Math.max(0.05, 1 - (cr.left + cr.right) / 100), kh = Math.max(0.05, 1 - (cr.top + cr.bottom) / 100);
      chain.push(`crop=w=trunc(iw*${fnum(kw)}/2)*2:h=trunc(ih*${fnum(kh)}/2)*2:x=iw*${fnum(cr.left / 100)}:y=ih*${fnum(cr.top / 100)}`);
    }
    if (c.fx?.mirror) chain.push('hflip');
    if (c.fx?.flip) chain.push('vflip');
    // Einpassen
    if (c.fit === 'cover') chain.push(`scale=w=${W}:h=${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
    else if (c.fit === 'stretch') chain.push(`scale=${W}:${H}`);
    else chain.push(`scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
    const pre = chain;
    if (opts.untilFit) return { pre, color: [], post: [], fullCanvas: false };
    const color: string[] = [];
    // Stabilisierung
    if (c.stabilize?.enabled && !opts.forTransition) {
      const st = c.stabilize;
      if (seg.stabFile) {
        color.push(`vidstabtransform=input='${escapeFilterPath(seg.stabFile)}':smoothing=${Math.round(5 + st.strength * 3)}:zoom=${fnum(st.zoom)}:optzoom=${st.zoom > 0 ? 0 : 1}:interpol=bicubic,unsharp=5:5:0.6:3:3:0`);
      } else if (this.filters.has('deshake')) {
        color.push(`deshake=rx=${Math.round(16 + st.strength * 2)}:ry=${Math.round(16 + st.strength * 2)}:edge=mirror`);
      }
    }
    // Farbe: alle Einstellungen als 3D-LUT (gleiche Rechnung wie die Vorschau)
    const col = c.color;
    const lutGrade = gradeForLut(col);
    if (hasExposureCurve(col)) {
      // Belichtung über die Zeit: Faktor (≤ 1) vor der LUT, in 16 Bit, per sendcmd weich interpoliert
      const id = `x${c.id.replace(/[^a-zA-Z0-9]/g, '')}${Math.round((opts.localOffset ?? seg.localOffset) * 1000)}`;
      const file = this.tmpFile(`exposure_${id}.txt`);
      fs.writeFileSync(file, exposureCommands(col, id, opts.localOffset ?? seg.localOffset, (t) => exposureGainAt(col, t)));
      const g0 = fnum(exposureGainAt(col, opts.localOffset ?? seg.localOffset));
      color.push('format=rgb48le', `sendcmd=f='${escapeFilterPath(file)}'`, `colorchannelmixer@${id}=rr=${g0}:gg=${g0}:bb=${g0}`);
    }
    if (!isNeutralGrade(lutGrade)) {
      const cube = this.lutFile(lutGrade);
      if (cube) color.push(`lut3d=file='${escapeFilterPath(cube)}':interp=tetrahedral`);
    }
    // Bild-Effekte
    const fx = c.fx;
    const alphaSrc = !!media.hasAlpha;
    if (fx) {
      if (fx.denoise > 0.01 && !alphaSrc) { const d = fx.denoise; color.push(`hqdn3d=${fnum(2 + 6 * d)}:${fnum(1.5 + 4.5 * d)}:${fnum(3 + 8 * d)}:${fnum(2.25 + 6.75 * d)}`); }
      if (fx.sharpen > 0.01) color.push(`unsharp=5:5:${fnum(fx.sharpen * 1.6)}:5:5:0`);
      if (fx.blur > 0.01) color.push(`gblur=sigma=${fnum(fx.blur * 0.02 * H)}`);
      if (fx.vignette > 0.01 && !alphaSrc) color.push(`vignette=angle=${fnum(0.15 + fx.vignette * 0.95)}`);
      if (fx.grain > 0.01 && !alphaSrc) color.push(`noise=alls=${Math.round(fx.grain * 28)}:allf=t`);
    }
    // Green Screen
    if (c.chroma?.enabled && !opts.forTransition) {
      const ch = c.chroma;
      const hex = ch.color.replace('#', '');
      color.push(`format=yuva420p`, `chromakey=color=0x${hex}:similarity=${fnum(Math.max(0.01, ch.similarity))}:blend=${fnum(Math.max(0, ch.blend))}`);
      if (ch.despill) {
        const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
        color.push(`despill=type=${g >= b && g >= r ? 'green' : 'blue'}:mix=0.5:expand=0`);
      }
    }
    const post: string[] = ['format=rgba'];
    const t = c.transform;
    const localOffset = opts.localOffset ?? seg.localOffset;
    const geo = hasGeometryMotion(c.motion);
    if (geo && c.motion) {
      // Animation: Bild auf eine transparente Fläche in Ausgabegröße legen und per perspective bewegen
      // perspective setzt Pixel außerhalb des Bildes auf die Randfarbe → transparenter Rand von 4 px
      const B = 4;
      post.push(`pad=${W + 2 * B}:${H + 2 * B}:(ow-iw)/2:(oh-ih)/2:color=black@0`, 'format=yuva444p');
      const k = perspectiveCorners(c.motion, t, W, H, fps, localOffset, B);
      post.push(`perspective=x0='${k[0]}':y0='${k[1]}':x1='${k[2]}':y1='${k[3]}':x2='${k[4]}':y2='${k[5]}':x3='${k[6]}':y3='${k[7]}':sense=destination:eval=frame:interpolation=linear`, `crop=${W}:${H}:${B}:${B}`, 'format=rgba');
    } else {
      // Feste Transformation
      if (Math.abs(t.scale - 1) > 1e-4) post.push(`scale=w=trunc(iw*${fnum(t.scale)}/2)*2:h=trunc(ih*${fnum(t.scale)}/2)*2:flags=bicubic`);
      if (Math.abs(t.rotation) > 1e-4) post.push(`rotate=a=${fnum(t.rotation)}*PI/180:ow=ceil(hypot(iw\\,ih)/2)*2:oh=ow:c=none`);
    }
    if (hasOpacityMotion(c.motion) && c.motion) {
      const id = `o${c.id.replace(/[^a-zA-Z0-9]/g, '')}${Math.round(localOffset * 1000)}`;
      const file = this.tmpFile(`opacity_${id}.txt`);
      fs.writeFileSync(file, opacityCommands(c.motion, Math.max(0, c.opacity), id, localOffset));
      post.push(`sendcmd=f='${escapeFilterPath(file)}'`, `colorchannelmixer@${id}=aa=${fnum(Math.max(0, c.opacity))}`);
    } else if (c.opacity < 0.999) {
      post.push(`colorchannelmixer=aa=${fnum(Math.max(0, c.opacity))}`);
    }
    return { pre, color, post, fullCanvas: geo };
  }

  /**
   * Dynamischer Übergang – Spiegel von PlaybackEngine.composeLayer: pro Bild Bewegung (perspective),
   * Unschärfe (gblur / dblur), Farbversatz (rgbashift) und Deckkraft über sendcmd, weißer Blitz als Fläche.
   * Eingänge: zwei Fenster in Ausgabegröße (Zeit ab 0, Dauer d). Rückgabe: Label des gemischten Fensters.
   */
  private dynamicTransition(type: DynamicTransition, intensity: number, d: number, la: string, lb: string, vi: number, filters: string[]): string {
    const { width: W, height: H, fps } = this.options;
    const n = Math.max(2, Math.round(d * fps) + 1);
    const frames = Array.from({ length: n }, (_, k) => dynTransitionAt(type, intensity, Math.min(1, k / fps / d), d, W / H));
    const B = 4;
    const iv = (k: number) => `${fnum(Math.max(0, (k - 0.5) / fps))}-${fnum((k + 0.5) / fps)}`;
    const layer = (inLbl: string, which: 'a' | 'b'): string => {
      const L: DynLayer[] = frames.map((f) => f[which]);
      const id = `dt${which}${vi}`;
      const head: string[] = ['format=rgba'];
      const chain: string[] = [];
      const cmds: string[][] = L.map(() => []);
      // Bewegung: Ecken pro Bild als stückweise lineare Funktion der Bildnummer
      const moving = L.some((l) => Math.abs(l.x) + Math.abs(l.y) + Math.abs(l.rotation) > 1e-4 || Math.abs(l.scale - 1) > 1e-4);
      if (moving) {
        const corners = L.map((l) => dynCorners(l, W, H, B));
        const e = (ci: number) => framePiecewise(corners.map((c) => c[ci]), 0.05);
        chain.push(`pad=${W + 2 * B}:${H + 2 * B}:${B}:${B}:color=black@0`, 'format=yuva444p');
        chain.push(`perspective=x0='${e(0)}':y0='${e(1)}':x1='${e(2)}':y1='${e(3)}':x2='${e(4)}':y2='${e(5)}':x3='${e(6)}':y3='${e(7)}':sense=destination:eval=frame:interpolation=linear`);
        chain.push(`crop=${W}:${H}:${B}:${B}`, 'format=rgba');
      }
      // Unschärfe (Bewegungsunschärfe in eine Richtung oder rundum); dblur-Radius ≈ Standardabweichung / 1,35
      const sig = L.map((l) => (l.blur / 100) * H);
      if (sig.some((s) => s > 0.3)) {
        const dir = L.find((l) => l.blurDir !== null)?.blurDir ?? null;
        if (dir !== null && this.filters.has('dblur')) {
          chain.push(`dblur@${id}b=angle=${fnum(dir)}:radius=0`);
          sig.forEach((s, k) => cmds[k].push(`dblur@${id}b radius ${fnum(s > 0.3 ? s / 1.35 : 0)}`));
        } else {
          chain.push(`gblur@${id}b=sigma=0`);
          sig.forEach((s, k) => cmds[k].push(`gblur@${id}b sigma ${fnum(s > 0.3 ? s : 0)}`));
        }
      }
      // Glitch: Farbkanäle versetzen
      if (L.some((l) => Math.abs(l.shift) > 1e-3)) {
        chain.push(`rgbashift@${id}s=rh=0:bh=0`);
        L.forEach((l, k) => {
          const px = Math.max(-255, Math.min(255, Math.round((l.shift / 100) * W)));
          cmds[k].push(`rgbashift@${id}s rh ${px}`, `rgbashift@${id}s bh ${-px}`);
        });
      }
      // Deckkraft (Überblendung)
      if (L.some((l) => l.alpha < 0.999)) {
        chain.push(`colorchannelmixer@${id}a=aa=${fnum(L[0].alpha)}`);
        L.forEach((l, k) => cmds[k].push(`colorchannelmixer@${id}a aa ${fnum(Math.max(0, Math.min(1, l.alpha)))}`));
      }
      if (cmds.some((c) => c.length)) {
        const file = this.tmpFile(`trans_${id}.txt`);
        fs.writeFileSync(file, cmds.map((c, k) => (c.length ? `${iv(k)} ${c.join(', ')};` : '')).filter(Boolean).join('\n') + '\n');
        head.push(`sendcmd=f='${escapeFilterPath(file)}'`);
      }
      const out = `${id}o`;
      filters.push(`[${inLbl}]${[...head, ...chain, 'format=rgba'].join(',')}[${out}]`);
      return out;
    };
    const A = layer(la, 'a');
    const Bl = layer(lb, 'b');
    let mixed = `dtm${vi}`;
    filters.push(`[${A}][${Bl}]overlay=x=0:y=0:format=rgb:eof_action=pass[${mixed}]`);
    if (frames.some((f) => f.flash > 0.002)) {
      const id = `dtf${vi}`;
      const file = this.tmpFile(`trans_${id}.txt`);
      fs.writeFileSync(file, frames.map((f, k) => `${iv(k)} colorchannelmixer@${id} aa ${fnum(Math.max(0, Math.min(1, f.flash)))};`).join('\n') + '\n');
      filters.push(`color=c=white:s=${W}x${H}:r=${fps}:d=${fnum(d)},format=rgba,sendcmd=f='${escapeFilterPath(file)}',colorchannelmixer@${id}=aa=0[${id}]`);
      filters.push(`[${mixed}][${id}]overlay=x=0:y=0:format=rgb:eof_action=pass[${id}m]`);
      mixed = `${id}m`;
    }
    filters.push(`[${mixed}]format=yuva420p[${mixed}y]`);
    return `${mixed}y`;
  }

  /** Farbeinstellung als .cube-Datei (zwischengespeichert pro Einstellung). */
  private lutFile(col: Clip['color']): string | null {
    const key = gradeKey(col);
    const cached = this.lutCache.get(key);
    if (cached) return cached;
    let user = null;
    if (col.lut && fs.existsSync(col.lut)) {
      try { user = parseCube(fs.readFileSync(col.lut, 'utf8')); } catch (e) { log.warn('LUT konnte nicht gelesen werden', e); }
    }
    const file = this.tmpFile('grade.cube');
    fs.writeFileSync(file, lutToCube(bakeGradeLut(col, user)));
    this.lutCache.set(key, file);
    return file;
  }

  /** Liegt das Clip-Bild nach der Kette bereits auf einer Fläche in Ausgabegröße (dann Overlay bei 0,0)? */
  private isFullCanvas(clip: Clip): boolean {
    return hasGeometryMotion(clip.motion);
  }

  /** Position eines Elements, das an ein getracktes Objekt geheftet ist, als FFmpeg-Ausdruck in t (Pixel). */
  private attachmentExpr(att: Attachment, segs: Segment[], rangeStart: number): { x: string; y: string; xAt: (t: number) => number; yAt: (t: number) => number } | null {
    const { width: W, height: H } = this.options;
    const objSeg = segs.find((sg) => sg.clip.id === att.clipId);
    const objClip = objSeg?.clip ?? this.project.clips[att.clipId];
    const track = objClip?.objects?.find((tr) => tr.id === att.trackId);
    if (!objClip || !track || track.boxes.length === 0) return null;
    const clipStart = objClip.start - rangeStart;
    const pos = (t: number) => {
      const b = trackBoxAt(track, t - clipStart);
      if (!b) return { x: W / 2, y: H / 2 };
      const cx = (b.x + b.w / 2) * W + (att.dx / 100) * W;
      let cy = (b.y + b.h / 2) * H;
      if (att.anchor === 'above') cy = b.y * H - 0.02 * H;
      else if (att.anchor === 'below') cy = (b.y + b.h) * H + 0.02 * H;
      return { x: cx, y: cy + (att.dy / 100) * H };
    };
    // Stützstellen (max. 120) → verschachtelte if()-Ausdrücke
    const times = track.boxes.map((b) => b.t + clipStart);
    const step = Math.max(1, Math.ceil(times.length / 120));
    const pts = times.filter((_, i) => i % step === 0 || i === times.length - 1).map((t) => ({ t, ...pos(t) }));
    const piece = (key: 'x' | 'y') => {
      if (pts.length === 1) return fnum(pts[0][key]);
      let expr = fnum(pts[pts.length - 1][key]);
      for (let i = pts.length - 2; i >= 0; i--) {
        const a = pts[i], b = pts[i + 1];
        const span = Math.max(1e-3, b.t - a.t);
        expr = `if(lt(t\\,${fnum(b.t)})\\,${fnum(a[key])}+(${fnum(b[key] - a[key])})*(t-${fnum(a.t)})/${fnum(span)}\\,${expr})`;
      }
      return expr;
    };
    return { x: piece('x'), y: piece('y'), xAt: (t) => pos(t).x, yAt: (t) => pos(t).y };
  }

  /** 360°-Ansicht (v360) inkl. Keyframe-Animation über sendcmd. */
  private panoChain(seg: Segment, localOffset: number): string[] {
    const { width: W, height: H } = this.options;
    const pano = seg.clip.pano!;
    const id = `p${seg.clip.id.replace(/[^a-zA-Z0-9]/g, '')}${Math.round(localOffset * 1000)}`;
    const view0 = panoViewAt(pano, localOffset);
    const chain: string[] = [];
    let v360: string;
    const rot = (v: { yaw: number; pitch: number; roll: number }) => `:yaw=${fnum(v.yaw)}:pitch=${fnum(v.pitch)}:roll=${fnum(v.roll)}`;
    if (pano.mode === 'flat') {
      v360 = `v360@${id}=input=equirect:output=flat:h_fov=${fnum(view0.fov)}:v_fov=${fnum(verticalFov(view0.fov, W, H))}:w=${W}:h=${H}${rot(view0)}`;
    } else if (pano.mode === 'littleplanet') {
      v360 = `v360@${id}=input=equirect:output=sg:h_fov=${fnum(view0.fov)}:v_fov=${fnum(stereographicVfov(view0.fov, W, H))}:w=${W}:h=${H}${rot(view0)}`;
    } else {
      const static0 = pano.keyframes.length <= 1 && Math.abs(view0.yaw) + Math.abs(view0.pitch) + Math.abs(view0.roll) < 1e-6;
      if (static0) return [];
      v360 = `v360@${id}=input=equirect:output=equirect${rot(view0)}`;
    }
    if (pano.keyframes.length > 1) {
      // Befehlsdatei: pro Keyframe-Abschnitt lineare/weiche Interpolation
      const lines: string[] = [];
      const kfs = pano.keyframes;
      const ease = pano.smooth ? 'TI*TI*(3-2*TI)' : 'TI';
      const vf = (fov: number) => pano.mode === 'littleplanet' ? stereographicVfov(fov, W, H) : verticalFov(fov, W, H);
      const cmd = (t0: number, t1: number, a: typeof kfs[0], b: typeof kfs[0]) => {
        const yawB = a.yaw + (((b.yaw - a.yaw) % 360 + 540) % 360 - 180);
        const rollB = a.roll + (((b.roll - a.roll) % 360 + 540) % 360 - 180);
        const parts = [
          `[expr] v360@${id} yaw 'lerp(${fnum(a.yaw)},${fnum(yawB)},${ease})'`,
          `[expr] v360@${id} pitch 'lerp(${fnum(a.pitch)},${fnum(b.pitch)},${ease})'`,
          `[expr] v360@${id} roll 'lerp(${fnum(a.roll)},${fnum(rollB)},${ease})'`,
        ];
        if (pano.mode !== 'equirect') {
          parts.push(`[expr] v360@${id} h_fov 'lerp(${fnum(a.fov)},${fnum(b.fov)},${ease})'`);
          parts.push(`[expr] v360@${id} v_fov 'lerp(${fnum(vf(a.fov))},${fnum(vf(b.fov))},${ease})'`);
        }
        lines.push(`${fnum(Math.max(0, t0))}-${fnum(t1)} ${parts.join(', ')};`);
      };
      for (let i = 0; i < kfs.length - 1; i++) {
        const t0 = kfs[i].t - localOffset;
        const t1 = kfs[i + 1].t - localOffset;
        if (t1 <= 0) continue;
        cmd(Math.max(0, t0), t1, kfs[i], kfs[i + 1]);
      }
      const last = kfs[kfs.length - 1];
      const tail = last.t - localOffset;
      lines.push(`${fnum(Math.max(0, tail))}-${fnum(Math.max(0, tail) + 100000)} [expr] v360@${id} yaw '${fnum(last.yaw)}', [expr] v360@${id} pitch '${fnum(last.pitch)}', [expr] v360@${id} roll '${fnum(last.roll)}'${pano.mode !== 'equirect' ? `, [expr] v360@${id} h_fov '${fnum(last.fov)}', [expr] v360@${id} v_fov '${fnum(vf(last.fov))}'` : ''};`);
      const file = this.tmpFile(`pano_${id}.txt`);
      fs.writeFileSync(file, lines.join('\n') + '\n');
      chain.push(`sendcmd=f='${escapeFilterPath(file)}'`);
    }
    chain.push(v360);
    return chain;
  }

  /** drawtext-Filter für einen Titel (oder Untertitel-Segment). */
  private drawText(style: TitleStyle, text: string, start: number, end: number, animate: boolean, pos?: { x: string; y: string }): string[] {
    const { width: W, height: H } = this.options;
    const fontSize = Math.max(4, Math.round((style.size / 100) * H));
    const def = fontDef(style.font);
    const fontFile = resolveFontFile(style.font);
    const fontOpt = fontFile ? `fontfile='${escapeFilterPath(fontFile)}'` : `font='${esc(fontFamilyName(def.key))}'`;
    const dur = end - start;
    const xBase = pos ? `(${pos.x})` : `w*${fnum(style.x / 100)}`;
    const xExpr = style.align === 'left' ? xBase : style.align === 'right' ? `${xBase}-text_w` : `${xBase}-text_w/2`;
    const common: string[] = [fontOpt, `fontsize=${fontSize}`, `fontcolor=${ffColor(style.color, 1)}`, `x=${xExpr}`, 'line_spacing=4'];
    if (style.background) common.push('box=1', `boxcolor=${ffColor(style.background, style.backgroundOpacity)}`, `boxborderw=${Math.round(fontSize * 0.35)}`);
    if (style.shadow) common.push('shadowcolor=0x000000@0.6', `shadowx=${Math.max(1, Math.round(fontSize * 0.04))}`, `shadowy=${Math.max(1, Math.round(fontSize * 0.04))}`);
    if (style.outline) common.push(`borderw=${Math.max(1, Math.round(fontSize * 0.08))}`, 'bordercolor=0x000000@1');
    const inD = Math.min(0.6, dur / 3), outD = Math.min(0.6, dur / 3);
    const relT = `(t-${fnum(start)})`;
    const alphaExpr = `if(lt(${relT},${fnum(inD)}),${relT}/${fnum(inD)},if(gt(${relT},${fnum(dur - outD)}),(${fnum(end)}-t)/${fnum(outD)},1))`;
    const filters: string[] = [];
    const textFile = (s: string) => {
      const f = this.tmpFile('text.txt');
      fs.writeFileSync(f, s.replace(/%/g, '%%'));
      return `textfile='${escapeFilterPath(f)}'`;
    };
    const yBase = pos ? `(${pos.y})-text_h/2` : `h*${fnum(style.y / 100)}-text_h/2`;
    if (animate && style.animation === 'typewriter') {
      const chars = Array.from(text);
      const n = Math.min(chars.length, 80);
      for (let k = 1; k <= n; k++) {
        const t0 = start + (k - 1) * 0.06;
        const t1 = k === n ? end : start + k * 0.06;
        if (t0 >= end) break;
        const alpha = k === n ? `if(gt(${relT},${fnum(dur - outD)}),(${fnum(end)}-t)/${fnum(outD)},1)` : '1';
        filters.push(`drawtext=${[...common, textFile(chars.slice(0, k).join('')), `y=${yBase}`, `alpha='${alpha}'`, `enable='between(t,${fnum(t0)},${fnum(Math.min(t1, end))})'`].join(':')}`);
      }
      return filters;
    }
    const parts = [...common, textFile(text), `enable='between(t,${fnum(start)},${fnum(end)})'`];
    if (animate && (style.animation === 'fade' || style.animation === 'slideup')) {
      parts.push(`alpha='${alphaExpr}'`);
      if (style.animation === 'slideup') parts.push(`y=${yBase}+h*0.06*max(0\\,1-${relT}/${fnum(inD)})`);
      else parts.push(`y=${yBase}`);
    } else {
      parts.push(`y=${yBase}`);
    }
    filters.push(`drawtext=${parts.join(':')}`);
    return filters;
  }

  /**
   * ASS-Untertiteldatei (libass) für Text-Einblendungen – wird für Untertitel benutzt und für Titel,
   * wenn FFmpeg kein drawtext hat (z. B. Linux-Build).
   */
  private assFilter(events: Array<{ a: number; b: number; text: string; rich?: (toAss: (hex: string, alpha: number) => string, clean: (t: string) => string) => string; second?: { text: string; color: string }; animation?: TitleStyle['animation']; from?: { x: number; y: number }; to?: { x: number; y: number } }>, style: Omit<TitleStyle, 'text'>, name: string): string | null {
    if (!this.filters.has('subtitles') || events.length === 0) return null;
    const { width: W, height: H } = this.options;
    const toAss = (hex: string, alpha: number) => {
      const h = hex.replace('#', '').padEnd(6, '0');
      const a = Math.round((1 - alpha) * 255).toString(16).padStart(2, '0').toUpperCase();
      return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
    };
    const fontSize = Math.max(4, Math.round((style.size / 100) * H));
    const align = style.align === 'left' ? 4 : style.align === 'right' ? 6 : 5; // mittlere Zeile, Anker links/mitte/rechts
    const borderStyle = style.background ? 3 : 1;
    const outline = style.outline ? Math.max(1, Math.round(fontSize * 0.08)) : style.background ? Math.round(fontSize * 0.3) : 0;
    const shadow = style.shadow ? Math.max(1, Math.round(fontSize * 0.04)) : 0;
    const backColor = style.background ? toAss(style.background, style.backgroundOpacity) : '&H80000000';
    const outlineColor = style.background ? backColor : '&H00000000';
    const fmt = (t: number) => {
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      return `${h}:${m.toString().padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
    };
    const header = [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: PanoCut,${fontFamilyName(style.font)},${fontSize},${toAss(style.color, 1)},&H000000FF,${outlineColor},${backColor},${style.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${align},0,0,0,1`,
      '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const x = Math.round((style.x / 100) * W), y = Math.round((style.y / 100) * H);
    const clean = (t: string) => t.replace(/\r?\n/g, '\\N').replace(/[{}]/g, '');
    const lines: string[] = [];
    for (const ev of events) {
      const dur = ev.b - ev.a;
      const inMs = Math.round(Math.min(0.6, dur / 3) * 1000), outMs = inMs;
      let tag = `{\\pos(${x},${y})}`;
      if (ev.from && ev.to) tag = `{\\move(${Math.round(ev.from.x)},${Math.round(ev.from.y)},${Math.round(ev.to.x)},${Math.round(ev.to.y)})${ev.animation === 'fade' ? `\\fad(${inMs},${outMs})` : ''}}`;
      else if (ev.animation === 'fade') tag = `{\\pos(${x},${y})\\fad(${inMs},${outMs})}`;
      else if (ev.animation === 'slideup') tag = `{\\move(${x},${Math.round(y + H * 0.06)},${x},${y},0,${inMs})\\fad(${inMs},${outMs})}`;
      if (ev.animation === 'typewriter') {
        const chars = Array.from(ev.text);
        const n = Math.min(chars.length, 80);
        for (let k = 1; k <= n; k++) {
          const t0 = ev.a + (k - 1) * 0.06;
          const t1 = k === n ? ev.b : Math.min(ev.b, ev.a + k * 0.06);
          if (t0 >= ev.b) break;
          const tg = k === n ? `{\\pos(${x},${y})\\fad(0,${outMs})}` : `{\\pos(${x},${y})}`;
          lines.push(`Dialogue: 0,${fmt(t0)},${fmt(t1)},PanoCut,,0,0,0,,${tg}${clean(chars.slice(0, k).join(''))}`);
        }
        continue;
      }
      const second = ev.second && ev.second.text.trim() ? `\\N{\\c${toAss(ev.second.color, 1)}\\fs${Math.round(fontSize * 0.8)}}${clean(ev.second.text)}` : '';
      const body = ev.rich ? ev.rich(toAss, clean) : clean(ev.text);
      lines.push(`Dialogue: 0,${fmt(ev.a)},${fmt(ev.b)},PanoCut,,0,0,0,,${tag}${body}${second}`);
    }
    const file = this.tmpFile(`${name}.ass`);
    fs.writeFileSync(file, header.concat(lines).join('\n') + '\n', 'utf8');
    return `subtitles=filename='${escapeFilterPath(file)}'`;
  }

  /** Untertitel eines Clips als ASS-Datei (libass) – oder drawtext als Rückfall. */
  private subtitleFilters(seg: Segment): string[] {
    const subs = seg.clip.subtitles;
    if (!subs || !subs.enabled || subs.segments.length === 0) return [];
    const style = subs.style;
    const visible = subs.segments
      .map((sg) => ({ ...sg, a: seg.tlStart + (sg.start - seg.localOffset), b: seg.tlStart + (sg.end - seg.localOffset) }))
      .filter((sg) => sg.b > seg.tlStart && sg.a < seg.tlStart + seg.tlDur && sg.text.trim())
      .map((sg) => ({ ...sg, a: Math.max(seg.tlStart, sg.a), b: Math.min(seg.tlStart + seg.tlDur, sg.b) }));
    if (visible.length === 0) return [];
    const att = subs.attach ? this.attachmentExpr(subs.attach, this.currentSegments, this.range().start) : null;
    const showTr = !!subs.showTranslation;
    const trColor = subs.translationColor ?? '#ffe066';
    const mainText = (sg: { text: string; translation?: string }) => (showTr && subs.translationOnly && sg.translation ? sg.translation : sg.text);
    const secondText = (sg: { translation?: string }) => (showTr && !subs.translationOnly && sg.translation ? { text: subs.uppercase ? sg.translation.toLocaleUpperCase('de-DE') : sg.translation, color: trColor } : undefined);
    // Je Segment ein Ereignis pro Wortwechsel (Hervorhebung/Wortgruppen) – gleiche Rechnung wie die Vorschau
    const { width: W, height: H } = this.options;
    const perLine = charsPerLine(style, W, H);
    const toTl = (local: number) => seg.tlStart + (local - seg.localOffset);
    const events: Parameters<ExportJob['assFilter']>[0] = [];
    for (const sg of visible) {
      const times = subtitleChangeTimes(subs, sg).concat([sg.end]);
      for (let i = 0; i < times.length - 1; i++) {
        const a = Math.max(sg.a, toTl(times[i])), b = Math.min(sg.b, toTl(times[i + 1]));
        if (b - a < 0.01) continue;
        const view = subtitleViewAt(subs, sg, times[i] + 1e-4, perLine);
        if (!view) continue;
        const plain = view.lines.map((ln) => ln.map((r) => r.text).join(' ')).join('\n');
        events.push({
          a, b, text: plain,
          rich: (toAss, clean) => view.lines.map((ln) => ln.map((r) => (r.active && subs.highlight ? `{\\c${toAss(subs.highlight, 1)}}${clean(r.text)}{\\c${toAss(style.color, 1)}}` : clean(r.text))).join(' ')).join('\\N'),
          second: secondText(sg),
          from: att ? { x: att.xAt(a), y: att.yAt(a) } : undefined, to: att ? { x: att.xAt(b), y: att.yAt(b) } : undefined,
        });
      }
    }
    void mainText;
    const ass = this.assFilter(events, style, `subs_${seg.clip.id}`);
    if (ass) return [ass];
    // Rückfall ohne libass: drawtext pro Segment
    const out: string[] = [];
    for (const sg of visible) {
      const sec = secondText(sg);
      const txt = mainText(sg) + (sec ? `\n${sec.text}` : '');
      out.push(...this.drawText({ ...style, text: txt }, txt, sg.a, sg.b, false));
    }
    return out;
  }

  // ---------------------------------------------------------------- Argumente

  private buildArgs(segs: Segment[], transitions: TransitionSeg[], total: number, hardware: boolean, encoders: Set<string>, pass: { pass?: 1 | 2; logFile?: string }): string[] {
    const o = this.options;
    const { width: W, height: H, fps } = o;
    const args: string[] = [];

    // ---- Eingaben ----
    let inputCount = 0;
    this.currentSegments = segs;
    for (const s of segs) {
      if (s.isTitle) continue;
      if (s.media?.hasAlpha) args.push('-c:v', 'libvpx-vp9');
      if (s.isImage) args.push('-loop', '1', '-framerate', String(fps), '-t', fnum(s.tlDur), '-i', s.file);
      else args.push('-ss', fnum(s.srcIn), '-t', fnum(s.srcDur), '-i', s.file);
      inputCount++;
    }
    // Maskensequenzen für freigestellte Clips
    for (const s of segs) {
      const track = this.cutoutTrack(s);
      if (!track?.masks?.length) continue;
      const list = this.tmpFile(`masks_${s.clip.id}.txt`);
      writeMaskList(track.masks, s.localOffset + s.tlDur, list);
      args.push('-ss', fnum(s.localOffset), '-f', 'concat', '-safe', '0', '-i', list);
      s.maskInput = inputCount++;
      s.maskList = list;
    }
    // Zusätzliche Fenster-Eingaben für Übergänge
    for (const tr of transitions) {
      const winA = tr.duration * tr.a.clip.speed, winB = tr.duration * tr.b.clip.speed;
      if (tr.a.isImage) args.push('-loop', '1', '-framerate', String(fps), '-t', fnum(tr.duration), '-i', tr.a.file);
      else args.push('-ss', fnum(tr.srcA), '-t', fnum(winA), '-i', tr.a.file);
      tr.inputA = inputCount++;
      if (tr.b.isImage) args.push('-loop', '1', '-framerate', String(fps), '-t', fnum(tr.duration), '-i', tr.b.file);
      else args.push('-ss', fnum(tr.srcB), '-t', fnum(winB), '-i', tr.b.file);
      tr.inputB = inputCount++;
    }
    const wantAudio = o.codec !== 'gif' && pass.pass !== 1; // Durchgang 1 analysiert nur das Bild
    const silenceIdx = inputCount;
    if (wantAudio) args.push('-f', 'lavfi', '-t', fnum(total), '-i', 'anullsrc=r=48000:cl=stereo');

    const filters: string[] = [];
    const bg = this.project.settings.background || '#000000';
    filters.push(`color=c=${esc(bg)}:s=${W}x${H}:r=${fps}:d=${fnum(total)},format=yuv420p[base]`);

    // ---- Video-Ketten ----
    let last = 'base';
    let vi = 0;
    const transitionsByB = new Map<Segment, TransitionSeg>();
    for (const tr of transitions) transitionsByB.set(tr.b, tr);

    for (const s of segs) {
      if (!s.hasVideo) continue;
      if (s.isTitle) {
        const title = s.clip.title!;
        const att = s.clip.attach ? this.attachmentExpr(s.clip.attach, segs, this.range().start) : null;
        const a0 = s.tlStart, b0 = s.tlStart + s.tlDur;
        const dts = this.filters.has('drawtext')
          ? this.drawText(title, title.text, a0, b0, true, att ? { x: att.x, y: att.y } : undefined)
          : [this.assFilter([{ a: a0, b: b0, text: title.text, animation: title.animation, from: att ? { x: att.xAt(a0), y: att.yAt(a0) } : undefined, to: att ? { x: att.xAt(b0), y: att.yAt(b0) } : undefined }], title, `title_${s.clip.id}`)].filter((x): x is string => !!x);
        for (const dt of dts) {
          const outLabel = `t${vi++}`;
          filters.push(`[${last}]${dt}[${outLabel}]`);
          last = outLabel;
        }
        continue;
      }
      const c = s.clip;
      const label = `v${vi}`;
      if (s.maskInput !== undefined && c.cutout) {
        // Freistellen: Maske zeitlich und in der Größe anpassen, dann als Alphakanal einrechnen
        const parts = this.videoChainParts(s);
        const cutColor = [...parts.pre, ...parts.color];
        filters.push(`${this.inputLabel(s, s.inputIndex)}${cutColor.join(',')}[cc${vi}]`);
        // Maske genauso zuschneiden und spiegeln wie das Bild
        const mcr = c.crop;
        const maskGeo: string[] = [];
        if (mcr && mcr.left + mcr.right + mcr.top + mcr.bottom > 0.01) {
          maskGeo.push(`crop=w=iw*${fnum(Math.max(0.05, 1 - (mcr.left + mcr.right) / 100))}:h=ih*${fnum(Math.max(0.05, 1 - (mcr.top + mcr.bottom) / 100))}:x=iw*${fnum(mcr.left / 100)}:y=ih*${fnum(mcr.top / 100)}`);
        }
        if (c.fx?.mirror) maskGeo.push('hflip');
        if (c.fx?.flip) maskGeo.push('vflip');
        const maskOps = [...maskGeo, maskChain(c.cutout.feather, c.cutout.grow, c.cutout.invert)];
        if (s.cutSize) {
          // Maske direkt auf die gemessene Größe bringen (stabil in FFmpeg 6 und 7)
          filters.push(`[${s.maskInput}:v]fps=${fps},${[...maskOps, `scale=${s.cutSize.w}:${s.cutSize.h}`].join(',')}[cms${vi}]`);
          filters.push(`[cc${vi}][cms${vi}]alphamerge,${parts.post.join(',')},setpts=PTS+${fnum(s.tlStart)}/TB[${label}]`);
        } else {
          filters.push(`[${s.maskInput}:v]fps=${fps},${maskOps.join(',')}[cm${vi}]`);
          filters.push(`[cm${vi}][cc${vi}]scale2ref[cms${vi}][ccr${vi}]`);
          filters.push(`[ccr${vi}][cms${vi}]alphamerge,${parts.post.join(',')},setpts=PTS+${fnum(s.tlStart)}/TB[${label}]`);
        }
      } else {
        const chain = this.videoChainPrefix(s);
        chain.push(`setpts=PTS+${fnum(s.tlStart)}/TB`);
        filters.push(`${this.inputLabel(s, s.inputIndex)}${chain.join(',')}[${label}]`);
      }
      const t = c.transform;
      const full = this.isFullCanvas(c);
      const dx = full ? 0 : (t.x / 100) * W;
      const dy = full ? 0 : (t.y / 100) * H;
      const outLabel = `ov${vi}`;
      const end = s.tlStart + s.tlDur;
      const enable = `enable='between(t,${fnum(s.tlStart)},${fnum(end)})'`;
      let layer = label;
      // Schlagschatten: Form des Clips schwarz, weich, versetzt – unter den Clip legen (wie Canvas shadowBlur)
      if (hasShadow(c)) {
        const sp = shadowPixels(c.shadow!, H);
        const pad = Math.ceil(sp.sigma * 3) + 2;
        filters.push(`[${label}]split[${label}m][${label}s]`);
        filters.push(`[${label}s]format=rgba,colorchannelmixer=rr=0:gg=0:bb=0:aa=${fnum(Math.min(1, c.shadow!.opacity))},pad=iw+${2 * pad}:ih+${2 * pad}:${pad}:${pad}:color=black@0${sp.sigma > 0.3 ? `,gblur=sigma=${fnum(sp.sigma)}` : ''}[${label}sh]`);
        filters.push(`[${last}][${label}sh]overlay=x=(W-w)/2+${fnum(dx + sp.dx)}:y=(H-h)/2+${fnum(dy + sp.dy)}:eof_action=pass:${enable}[${label}so]`);
        last = `${label}so`;
        layer = `${label}m`;
      }
      const mode = blendDef(c.blend).ffmpeg;
      if (mode !== 'normal') {
        // Mischmodus: Clip auf eine transparente Fläche in Ausgabegröße legen, mit der Szene verrechnen und
        // über die Deckkraft (Alpha) des Clips einblenden: Ergebnis = Szene·(1−a) + Mischung(Szene, Clip)·a
        const L = `lay${vi}`;
        filters.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${fnum(total)},format=rgba[${L}c]`);
        filters.push(`[${L}c][${layer}]overlay=x=(W-w)/2+${fnum(dx)}:y=(H-h)/2+${fnum(dy)}:eof_action=pass:format=rgb:${enable}[${L}]`);
        filters.push(`[${last}]format=gbrp,split[${L}b1][${L}b2]`);
        filters.push(`[${L}]split[${L}l1][${L}l2]`);
        filters.push(`[${L}l1]format=gbrp[${L}rgb]`);
        filters.push(`[${L}b1][${L}rgb]blend=all_mode=${mode}[${L}bl]`);
        filters.push(`[${L}l2]alphaextract[${L}a]`);
        filters.push(`[${L}bl][${L}a]alphamerge[${L}ba]`);
        filters.push(`[${L}b2][${L}ba]overlay=format=rgb,format=yuv420p[${outLabel}]`);
      } else {
        filters.push(`[${last}][${layer}]overlay=x=(W-w)/2+${fnum(dx)}:y=(H-h)/2+${fnum(dy)}:eof_action=pass:${enable}[${outLabel}]`);
      }
      last = outLabel;
      vi++;

      // Übergang in diesen Clip: Fenster um den Schnitt rendern und oben drauf legen
      const tr = transitionsByB.get(s);
      if (tr) {
        const d = tr.duration;
        const wStart = tr.cut - d / 2;
        const make = (seg: Segment, input: number, pad: number, which: 'a' | 'b') => {
          const chainW = this.videoChainPrefix(seg, {
            localOffset: wStart - (seg.tlStart - seg.localOffset),
            pad: which === 'a' ? { start: 0, end: d } : { start: pad, end: d },
            forTransition: true,
          });
          chainW.push(`trim=duration=${fnum(d)}`, 'setpts=PTS-STARTPTS');
          const lbl = `w${which}${vi}`;
          filters.push(`${this.inputLabel(seg, input)}${chainW.join(',')}[${lbl}]`);
          // auf transparente Leinwand legen, damit beide Fenster gleich groß sind
          const tt = seg.clip.transform;
          const fullT = this.isFullCanvas(seg.clip);
          const cx = fullT ? 0 : (tt.x / 100) * W, cy = fullT ? 0 : (tt.y / 100) * H;
          const canvasLbl = `wc${which}${vi}`;
          filters.push(`color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${fnum(d)},format=yuva420p[${canvasLbl}]`);
          const outL = `wo${which}${vi}`;
          filters.push(`[${canvasLbl}][${lbl}]overlay=x=(W-w)/2+${fnum(cx)}:y=(H-h)/2+${fnum(cy)}:format=yuv420:shortest=1,format=yuva420p[${outL}]`);
          return outL;
        };
        const la = make(tr.a, tr.inputA, tr.padA, 'a');
        const lb = make(tr.b, tr.inputB, tr.padB, 'b');
        const xf = `xf${vi}`;
        if (isDynamicTransition(tr.type)) {
          const mixed = this.dynamicTransition(tr.type, tr.intensity, d, la, lb, vi, filters);
          filters.push(`[${mixed}]setpts=PTS+${fnum(wStart)}/TB[${xf}]`);
        } else {
          filters.push(`[${la}][${lb}]xfade=transition=${tr.type}:duration=${fnum(d)}:offset=0,setpts=PTS+${fnum(wStart)}/TB[${xf}]`);
        }
        const outT = `ovt${vi}`;
        filters.push(`[${last}][${xf}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${fnum(wStart)},${fnum(wStart + d)})'[${outT}]`);
        last = outT;
        vi++;
      }

      // Untertitel des Clips
      for (const sf of this.subtitleFilters(s)) {
        const outLabel2 = `s${vi++}`;
        filters.push(`[${last}]${sf}[${outLabel2}]`);
        last = outLabel2;
      }
    }
    const finalPix = o.codec === 'prores' ? 'yuv422p10le' : 'yuv420p';
    if (o.codec === 'gif') {
      filters.push(`[${last}]format=rgb24,split[gifa][gifb];[gifa]palettegen=stats_mode=diff[pal];[gifb][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]`);
    } else {
      filters.push(`[${last}]format=${finalPix}[vout]`);
    }

    // ---- Audio-Ketten ----
    const audioLabels: string[] = [];
    const ducked: Array<{ label: string; amount: number }> = [];
    let ai = 0;
    const transitionsByA = new Map<Segment, TransitionSeg>();
    for (const tr of transitions) transitionsByA.set(tr.a, tr);
    for (const s of segs) {
      if (!wantAudio || !s.hasAudio || s.isImage || s.isTitle) continue;
      const c = s.clip;
      const chain: string[] = ['asetpts=PTS-STARTPTS'];
      chain.push(...atempoChain(c.speed));
      if (Math.abs(c.volume - 1) > 1e-4) chain.push(`volume=${fnum(c.volume)}`);
      if (c.fadeIn > 0.01) chain.push(`afade=t=in:st=0:d=${fnum(Math.min(c.fadeIn, s.tlDur))}`);
      if (c.fadeOut > 0.01) chain.push(`afade=t=out:st=${fnum(Math.max(0, s.tlDur - c.fadeOut))}:d=${fnum(Math.min(c.fadeOut, s.tlDur))}`);
      // Übergänge: weiche Tonüberblendung
      const trA = transitionsByA.get(s);
      if (trA) chain.push(`afade=t=out:st=${fnum(Math.max(0, s.tlDur - trA.duration / 2))}:d=${fnum(trA.duration / 2)}`);
      const trB = transitionsByB.get(s);
      if (trB) chain.push(`afade=t=in:st=0:d=${fnum(trB.duration / 2)}`);
      chain.push(`atrim=0:${fnum(s.tlDur)}`);
      chain.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
      const ms = Math.round(s.tlStart * 1000);
      if (ms > 0) chain.push(`adelay=${ms}:all=1`);
      const label = `a${ai}`;
      filters.push(`[${s.inputIndex}:a]${chain.join(',')}[${label}]`);
      if (c.ducking?.enabled) ducked.push({ label, amount: c.ducking.amount });
      else audioLabels.push(label);
      ai++;
    }
    if (wantAudio) {
      const finalLabels = [`[${silenceIdx}:a]`];
      if (ducked.length > 0 && audioLabels.length > 0 && this.filters.has('sidechaincompress')) {
        // Ducking: Musik wird automatisch leiser, sobald der übrige Ton (Sprache) laut wird
        const amount = Math.max(...ducked.map((d) => d.amount));
        filters.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,asplit=2[voice][voicesc]`);
        filters.push(`${ducked.map((d) => `[${d.label}]`).join('')}amix=inputs=${ducked.length}:duration=longest:normalize=0[music]`);
        filters.push(`[music][voicesc]sidechaincompress=threshold=${fnum(0.03 - 0.02 * amount)}:ratio=${fnum(2 + 18 * amount)}:attack=30:release=500:makeup=1[musicd]`);
        finalLabels.push('[voice]', '[musicd]');
      } else {
        finalLabels.push(...[...audioLabels, ...ducked.map((d) => d.label)].map((l) => `[${l}]`));
      }
      filters.push(`${finalLabels.join('')}amix=inputs=${finalLabels.length}:duration=first:normalize=0,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
    }

    const graphFile = this.tmpFile(`graph_${pass.pass ?? 0}.txt`);
    fs.writeFileSync(graphFile, filters.join(';\n'));
    args.push('-filter_complex_script', graphFile);
    args.push('-map', '[vout]');
    if (wantAudio) args.push('-map', '[aout]');

    // ---- Encoder ----
    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';
    const crf = qualityCrf(o.codec, o.quality);
    let bitrate = qualityBitrate(o);
    let sizeLimited = false;
    if (o.maxSizeMB && o.maxSizeMB > 0) {
      const totalBits = o.maxSizeMB * 8 * 1024 * 1024 * 0.96;
      const audioBits = o.codec !== 'gif' ? o.audioBitrate * 1000 * total : 0;
      bitrate = Math.max(150_000, Math.floor((totalBits - audioBits) / Math.max(0.1, total)));
      sizeLimited = true;
    }
    const rate = (): string[] => sizeLimited ? ['-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.15)), '-bufsize', String(bitrate * 2)] : [];
    switch (o.codec) {
      case 'h264': {
        if (hardware && isMac && encoders.has('h264_videotoolbox')) {
          args.push('-c:v', 'h264_videotoolbox', '-b:v', String(bitrate), '-allow_sw', '1', '-realtime', '0', '-profile:v', 'high');
        } else if (hardware && isWin && encoders.has('h264_nvenc')) {
          args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', ...(sizeLimited ? rate() : ['-cq', String(crf), '-b:v', '0']));
        } else if (hardware && isWin && encoders.has('h264_qsv')) {
          args.push('-c:v', 'h264_qsv', ...(sizeLimited ? rate() : ['-global_quality', String(crf)]));
        } else if (hardware && isWin && encoders.has('h264_amf')) {
          args.push('-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', String(bitrate));
        } else {
          args.push('-c:v', 'libx264', '-preset', o.quality === 'max' ? 'slow' : 'medium', '-profile:v', 'high', ...(sizeLimited ? rate() : ['-crf', String(crf)]));
        }
        break;
      }
      case 'h265': {
        if (hardware && isMac && encoders.has('hevc_videotoolbox')) {
          args.push('-c:v', 'hevc_videotoolbox', '-b:v', String(bitrate), '-allow_sw', '1', '-realtime', '0');
        } else if (hardware && isWin && encoders.has('hevc_nvenc')) {
          args.push('-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', ...(sizeLimited ? rate() : ['-cq', String(crf), '-b:v', '0']));
        } else if (hardware && isWin && encoders.has('hevc_qsv')) {
          args.push('-c:v', 'hevc_qsv', ...(sizeLimited ? rate() : ['-global_quality', String(crf)]));
        } else if (hardware && isWin && encoders.has('hevc_amf')) {
          args.push('-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', String(bitrate));
        } else {
          args.push('-c:v', 'libx265', '-preset', o.quality === 'max' ? 'slow' : 'medium', ...(sizeLimited ? rate() : ['-crf', String(crf)]));
        }
        args.push('-tag:v', 'hvc1');
        break;
      }
      case 'prores':
        args.push('-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-qscale:v', o.quality === 'max' ? '5' : '9');
        break;
      case 'vp9':
        args.push('-c:v', 'libvpx-vp9', ...(sizeLimited ? rate() : ['-crf', String(crf), '-b:v', '0']), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2');
        break;
      case 'gif':
        break;
    }
    if (pass.pass && pass.logFile) {
      args.push('-pass', String(pass.pass), '-passlogfile', pass.logFile);
      if (o.codec === 'h265') args.push('-x265-params', `pass=${pass.pass}:stats=${pass.logFile}.x265`);
    }
    if (wantAudio) {
      if (o.format === 'webm') args.push('-c:a', 'libopus', '-b:a', `${o.audioBitrate}k`);
      else args.push('-c:a', 'aac', '-b:a', `${o.audioBitrate}k`);
    }
    if (pass.pass === 1) {
      args.push('-an', '-t', fnum(total), '-threads', '0', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null');
      return args;
    }
    if (o.format === 'mp4' || o.format === 'mov') args.push('-movflags', '+faststart');
    args.push('-t', fnum(total), '-threads', '0', o.outputPath);
    return args;
  }
}
