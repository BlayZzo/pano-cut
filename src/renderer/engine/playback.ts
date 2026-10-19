import type { Clip, MediaItem, Project, Track, TransitionType } from '@shared/types';
import { clamp, clipAt, clipDuration, clipEnd, clipsOnTrack, defaultColor, projectDuration, sourceTimeAt, videoTracksBottomUp } from '@shared/timeline';
import { panoViewAt } from '@shared/pano';
import { maskAt, trackBoxAt } from '@shared/ai';
import type { Attachment } from '@shared/types';
import { sharedPanoGL } from './panogl';
import { sharedChromaGL } from './chromagl';
import { sharedColorGL } from './colorgl';
import { motionAt } from '@shared/effects';
import { drawStyledText } from './text';
import { blendDef, hasShadow, shadowPixels } from '@shared/layers';
import { exposureGainAt, gradeForLut } from '@shared/color';
import { dynTransitionAt, isDynamicTransition, type DynLayer } from '@shared/transitions';

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

interface Slot {
  el: MediaEl;
  src: string;
  isVideo: boolean;
  isImage: boolean;
  lastSeek: number;
  work?: HTMLCanvasElement;   // Zwischen-Canvas für Freistellen
}

// Masken sind Graustufen-PNGs (hell = Objekt). Für die Vorschau wird die Helligkeit zu Transparenz umgerechnet.
const maskImages = new Map<string, { img: HTMLImageElement; canvas: HTMLCanvasElement | null }>();
export function maskCanvas(path: string, onLoad: () => void): HTMLCanvasElement | null {
  let entry = maskImages.get(path);
  if (!entry) {
    const img = new Image();
    const e: { img: HTMLImageElement; canvas: HTMLCanvasElement | null } = { img, canvas: null };
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cx = c.getContext('2d', { willReadFrequently: true })!;
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) { d.data[i + 3] = d.data[i]; d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255; }
      cx.putImageData(d, 0, 0);
      e.canvas = c;
      onLoad();
    };
    img.src = window.panocut.toMediaUrl(path);
    maskImages.set(path, e);
    entry = e;
  }
  return entry.canvas;
}
/** Nach dem Bearbeiten einer Maske den Zwischenspeicher leeren. */
export function forgetMask(path: string): void { maskImages.delete(path); }

interface DrawExtra {
  alpha?: number;
  dx?: number;        // Pixel-Versatz (Übergänge)
  dy?: number;
  clipPath?: (ctx: CanvasRenderingContext2D) => void;
  localT?: number;    // Clip-lokale Zeit (für 360°-Keyframes)
}

const RATE_MIN = 0.0625;
const RATE_MAX = 16;
const SYNC_TOLERANCE = 0.12;

const DISPLAYABLE_IMAGES = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

function isDisplayableImage(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return DISPLAYABLE_IMAGES.has(ext);
}

/** Quellzeit ohne Begrenzung auf den Clip (für Übergänge, die über das Clip-Ende hinausreichen). */
function sourceTimeUnclamped(clip: Clip, t: number): number {
  const local = (t - clip.start) * clip.speed;
  return clip.reverse ? clip.out - local : clip.in + local;
}

interface ActiveTransition { a: Clip; b: Clip; type: TransitionType; progress: number; duration: number; cut: number; intensity: number }

/** Zwischen-Canvas in Bildgröße (für dynamische Übergänge), wiederverwendet. */
const scratch: HTMLCanvasElement[] = [];
function scratchCanvas(i: number, W: number, H: number): { c: HTMLCanvasElement; x: CanvasRenderingContext2D } {
  let c = scratch[i];
  if (!c) { c = document.createElement('canvas'); scratch[i] = c; }
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const x = c.getContext('2d')!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
  x.clearRect(0, 0, W, H);
  return { c, x };
}

/**
 * Die Vorschau-Engine: zeichnet die Timeline auf ein Canvas und spielt die Proxy-Dateien
 * der Clips synchron ab. Sie ist bewusst unabhängig von React.
 */
export class PlaybackEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private project: Project;
  private slots = new Map<string, Slot>();
  private playing = false;
  private startWall = 0;
  private startTime = 0;
  private current = 0;
  private raf = 0;
  private lastEmit = 0;
  loop = false;
  muted = false;
  /** Vergleich: Bild ohne Farbkorrektur zeigen (Bild-Assistent „Vorher“). */
  compareOriginal = false;
  onTime: (t: number) => void = () => {};
  onEnded: () => void = () => {};
  /** Wird gerufen, wenn für einen Rückwärts-Clip noch keine Rückwärts-Vorschau existiert. */
  onNeedReversed: (media: MediaItem) => void = () => {};
  /** Wird gerufen, wenn für einen stabilisierten Clip noch keine stabilisierte Vorschau existiert. */
  onNeedStabilized: (media: MediaItem, strength: number) => void = () => {};
  private requestedReversed = new Set<string>();
  private requestedStabilized = new Set<string>();

  constructor(project: Project) {
    this.project = project;
  }

  setCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
    this.render(this.current);
  }

  setProject(project: Project): void {
    const changed = this.project !== project;
    this.project = project;
    if (!changed) return;
    for (const [id, slot] of this.slots) {
      if (!project.clips[id]) {
        this.disposeSlot(slot);
        this.slots.delete(id);
      }
    }
    if (!this.playing) this.render(this.current);
  }

  get time(): number { return this.current; }
  get isPlaying(): boolean { return this.playing; }

  seek(t: number): void {
    const dur = projectDuration(this.project);
    this.current = clamp(t, 0, Math.max(0, dur));
    if (this.playing) {
      this.startTime = this.current;
      this.startWall = performance.now();
    }
    this.render(this.current);
    this.onTime(this.current);
  }

  play(): void {
    if (this.playing) return;
    const dur = projectDuration(this.project);
    if (dur <= 0) return;
    if (this.current >= dur - 0.001) this.current = 0;
    this.playing = true;
    this.startTime = this.current;
    this.startWall = performance.now();
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const slot of this.slots.values()) this.pauseSlot(slot);
    this.render(this.current);
    this.onTime(this.current);
  }

  toggle(): void {
    if (this.playing) this.pause(); else this.play();
  }

  /** Erzwingt ein Neuzeichnen (z. B. nach Änderung von Einstellungen ohne Projektwechsel). */
  redraw(): void {
    if (!this.playing) this.render(this.current);
  }

  destroy(): void {
    this.pause();
    for (const slot of this.slots.values()) this.disposeSlot(slot);
    this.slots.clear();
  }

  // ---------- intern ----------

  private tick = (): void => {
    if (!this.playing) return;
    const dur = projectDuration(this.project);
    const t = this.startTime + (performance.now() - this.startWall) / 1000;
    if (t >= dur) {
      if (this.loop && dur > 0) {
        this.current = 0;
        this.startTime = 0;
        this.startWall = performance.now();
      } else {
        this.current = dur;
        this.playing = false;
        for (const slot of this.slots.values()) this.pauseSlot(slot);
        this.render(this.current);
        this.onTime(this.current);
        this.onEnded();
        return;
      }
    } else {
      this.current = t;
    }
    this.render(this.current);
    const now = performance.now();
    if (now - this.lastEmit > 33) {
      this.lastEmit = now;
      this.onTime(this.current);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private desiredSrc(clip: Clip, media: MediaItem): { src: string; reversedFile: boolean } {
    const url = (p: string) => window.panocut.toMediaUrl(p);
    if (media.type === 'image') {
      const p = isDisplayableImage(media.path) ? media.path : (media.thumb ?? media.path);
      return { src: url(p), reversedFile: false };
    }
    if (clip.reverse && media.proxyReversed) return { src: url(media.proxyReversed), reversedFile: true };
    if (clip.stabilize?.enabled && media.proxyStabilized && !clip.reverse) return { src: url(media.proxyStabilized), reversedFile: false };
    if (media.proxy) return { src: url(media.proxy), reversedFile: false };
    return { src: url(media.path), reversedFile: false };
  }

  private getSlot(clip: Clip, media: MediaItem): Slot {
    const { src } = this.desiredSrc(clip, media);
    let slot = this.slots.get(clip.id);
    if (slot && slot.src === src) return slot;
    if (slot) { this.disposeSlot(slot); this.slots.delete(clip.id); }
    let el: MediaEl;
    const isImage = media.type === 'image';
    const isVideo = media.type === 'video';
    if (isImage) {
      el = new Image();
      el.onload = () => { if (!this.playing) this.render(this.current); };
    } else {
      el = isVideo ? document.createElement('video') : document.createElement('audio');
      const m = el as HTMLMediaElement;
      m.preload = 'auto';
      m.muted = false;
      (m as HTMLVideoElement).playsInline = true;
      m.addEventListener('seeked', () => { if (!this.playing) this.render(this.current); });
      m.addEventListener('loadeddata', () => { if (!this.playing) this.render(this.current); });
    }
    el.src = src;
    slot = { el, src, isVideo, isImage, lastSeek: -1 };
    this.slots.set(clip.id, slot);
    return slot;
  }

  private pauseSlot(slot: Slot): void {
    if (slot.isImage) return;
    const m = slot.el as HTMLMediaElement;
    if (!m.paused) m.pause();
  }

  private disposeSlot(slot: Slot): void {
    if (slot.isImage) { (slot.el as HTMLImageElement).src = ''; return; }
    const m = slot.el as HTMLMediaElement;
    try { m.pause(); m.removeAttribute('src'); m.load(); } catch { /* ignorieren */ }
  }

  /** Zeit innerhalb der tatsächlich geladenen Datei (Proxy, ggf. rückwärts). */
  private fileTime(clip: Clip, media: MediaItem, t: number, reversedFile: boolean, unclamped = false): number {
    const src = unclamped ? sourceTimeUnclamped(clip, t) : sourceTimeAt(clip, t);
    if (reversedFile) return Math.max(0, media.info.duration - src);
    return Math.max(0, src);
  }

  /** Lautstärke-Multiplikator durch Übergänge (Ton weich überblenden). */
  private transitionGain(clip: Clip, t: number): number {
    let gain = 1;
    const tr = clip.transition;
    if (tr) {
      const half = Math.min(tr.duration, clipDuration(clip)) / 2;
      const local = t - clip.start;
      if (local < half) gain *= clamp(local / half, 0, 1);
    }
    // Übergang des nächsten Clips (dieser Clip blendet aus)
    const next = clipsOnTrack(this.project, clip.trackId).find((c) => c.transition && Math.abs(c.start - clipEnd(clip)) < 1 / 30);
    if (next?.transition) {
      const half = Math.min(next.transition.duration, clipDuration(next), clipDuration(clip)) / 2;
      const remain = clipEnd(clip) - t;
      if (remain < half) gain *= clamp(remain / half, 0, 1);
    }
    return gain;
  }

  /** Läuft gerade anderer Ton (z. B. Sprache), wegen dem die Musik leiser werden soll? */
  private otherAudioActive(clip: Clip, t: number): boolean {
    for (const c of Object.values(this.project.clips)) {
      if (c.id === clip.id || c.ducking?.enabled || c.muted || c.kind === 'title') continue;
      if (t < c.start || t >= clipEnd(c)) continue;
      const m = this.project.media[c.mediaId];
      const tr = this.project.tracks.find((x) => x.id === c.trackId);
      if (m?.info.hasAudio && !tr?.muted && c.volume > 0.05) return true;
    }
    return false;
  }

  private syncMedia(slot: Slot, clip: Clip, media: MediaItem, track: Track, t: number, unclamped = false): void {
    const m = slot.el as HTMLMediaElement;
    const { reversedFile } = this.desiredSrc(clip, media);
    const target = this.fileTime(clip, media, t, reversedFile, unclamped);
    const needsSeekMode = (clip.reverse && !reversedFile) || clip.speed < RATE_MIN || clip.speed > RATE_MAX;

    if (clip.reverse && !media.proxyReversed && media.proxy && !this.requestedReversed.has(media.id)) {
      this.requestedReversed.add(media.id);
      this.onNeedReversed(media);
    }
    if (clip.stabilize?.enabled && !media.proxyStabilized && media.proxy && !this.requestedStabilized.has(media.id)) {
      this.requestedStabilized.add(media.id);
      this.onNeedStabilized(media, clip.stabilize.strength);
    }

    const local = t - clip.start;
    const dur = clipDuration(clip);
    let gain = clamp(clip.volume, 0, 1);
    if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= clamp(local / clip.fadeIn, 0, 1);
    if (clip.fadeOut > 0 && dur - local < clip.fadeOut) gain *= clamp((dur - local) / clip.fadeOut, 0, 1);
    gain *= this.transitionGain(clip, t);
    if (clip.ducking?.enabled && this.otherAudioActive(clip, t)) gain *= 1 - 0.75 * clamp(clip.ducking.amount, 0, 1);
    m.volume = clamp(gain, 0, 1);
    const outside = local < 0 || local > dur;
    m.muted = this.muted || clip.muted || track.muted || needsSeekMode || outside;

    if (this.playing && !needsSeekMode) {
      const rate = clamp(clip.speed, RATE_MIN, RATE_MAX);
      if (Math.abs(m.playbackRate - rate) > 1e-3) m.playbackRate = rate;
      if (m.readyState >= 2) {
        if (Math.abs(m.currentTime - target) > SYNC_TOLERANCE) m.currentTime = target;
        if (m.paused) void m.play().catch(() => {});
      }
    } else {
      if (!m.paused) m.pause();
      if (Math.abs(m.currentTime - target) > 0.02 && Math.abs(slot.lastSeek - target) > 0.005) {
        slot.lastSeek = target;
        m.currentTime = target;
      }
    }
  }

  private drawClip(ctx: CanvasRenderingContext2D, slot: Slot, clip: Clip, media: MediaItem, W: number, H: number, extra: DrawExtra = {}): void {
    let source: CanvasImageSource = slot.el as CanvasImageSource;
    let vw = 0, vh = 0;
    if (slot.isImage) { vw = (slot.el as HTMLImageElement).naturalWidth; vh = (slot.el as HTMLImageElement).naturalHeight; }
    else if (slot.isVideo) {
      const v = slot.el as HTMLVideoElement;
      if (v.readyState < 2) return;
      vw = v.videoWidth; vh = v.videoHeight;
    } else return;
    if (!vw || !vh) return;

    // 360°: Ansicht per WebGL berechnen
    const localT = extra.localT ?? (this.current - clip.start);
    if (media.info.is360 && clip.pano) {
      const pgl = sharedPanoGL();
      if (pgl.available) {
        const view = panoViewAt(clip.pano, localT);
        const mode = clip.pano.mode;
        const outW = mode === 'equirect' ? Math.min(vw, 2048) : W;
        const outH = mode === 'equirect' ? Math.round(outW / 2) : H;
        const srcTime = slot.isVideo ? (slot.el as HTMLVideoElement).currentTime : 0;
        const out = pgl.render(source as TexImageSource, outW, outH, mode, view, srcTime);
        if (out) { source = out; vw = outW; vh = outH; }
      }
    }

    // Zuschnitt, Spiegeln, Farbe (LUT) und Vignette – wie im Export
    const cr = clip.crop;
    const crop = cr && cr.left + cr.right + cr.top + cr.bottom > 0.01
      ? { x: cr.left / 100, y: cr.top / 100, w: Math.max(0.05, 1 - (cr.left + cr.right) / 100), h: Math.max(0.05, 1 - (cr.top + cr.bottom) / 100) }
      : null;
    const cgl = sharedColorGL();
    if (cgl.available) {
      // Vergleich „Vorher“: Farbe und Vignette auslassen
      const original = this.compareOriginal;
      const grade = original ? defaultColor() : gradeForLut(clip.color);
      const gain = original ? 1 : exposureGainAt(clip.color, localT);
      const out = cgl.render(source as TexImageSource, vw, vh, grade, original ? 0 : clip.fx?.vignette ?? 0, crop, !!clip.fx?.mirror, !!clip.fx?.flip, () => { if (!this.playing) this.render(this.current); }, gain);
      if (out) { source = out; vw = out.width; vh = out.height; }
    }

    // Green Screen (WebGL)
    if (clip.chroma?.enabled) {
      const kgl = sharedChromaGL();
      if (kgl.available) {
        const out = kgl.render(source as TexImageSource, Math.min(vw, 1920), Math.round((Math.min(vw, 1920) * vh) / vw), clip.chroma.color, clip.chroma.similarity, clip.chroma.blend, clip.chroma.despill);
        if (out) { source = out; vw = out.width; vh = out.height; }
      }
    }
    // Freistellen anhand der Objektmaske
    const cut = clip.cutout;
    const track = cut?.enabled ? clip.objects?.find((tr) => tr.id === cut.trackId) : undefined;
    if (cut && track?.masks?.length) {
      const m = maskAt(track, localT);
      if (m) {
        const img = maskCanvas(m.path, () => { if (!this.playing) this.render(this.current); });
        if (img) {
          const cw = Math.min(vw, 1280), chh = Math.round((cw * vh) / vw);
          if (!slot.work) slot.work = document.createElement('canvas');
          const wc = slot.work;
          if (wc.width !== cw || wc.height !== chh) { wc.width = cw; wc.height = chh; }
          const wctx = wc.getContext('2d')!;
          wctx.save();
          wctx.globalCompositeOperation = 'source-over';
          wctx.filter = 'none';
          wctx.clearRect(0, 0, cw, chh);
          wctx.drawImage(source, 0, 0, cw, chh);
          wctx.globalCompositeOperation = cut.invert ? 'destination-out' : 'destination-in';
          if (cut.feather > 0) wctx.filter = `blur(${(cut.feather / 2) * (cw / Math.max(1, img.width))}px)`;
          // Maske genauso zuschneiden und spiegeln wie das Bild
          const mw = img.width, mh = img.height;
          const mc = crop ?? { x: 0, y: 0, w: 1, h: 1 };
          wctx.translate(clip.fx?.mirror ? cw : 0, clip.fx?.flip ? chh : 0);
          wctx.scale(clip.fx?.mirror ? -1 : 1, clip.fx?.flip ? -1 : 1);
          wctx.drawImage(img, mc.x * mw, mc.y * mh, mc.w * mw, mc.h * mh, 0, 0, cw, chh);
          wctx.restore();
          source = wc; vw = cw; vh = chh;
        }
      }
    }

    const tr = clip.transform;
    const mo = motionAt(clip.motion, localT);
    ctx.save();
    if (extra.clipPath) extra.clipPath(ctx);
    ctx.globalAlpha = clamp(clip.opacity * mo.opacity, 0, 1) * (extra.alpha ?? 1);
    // Ebene: Mischmodus und Schlagschatten (gleiche Rechnung wie FFmpeg blend/gblur im Export)
    ctx.globalCompositeOperation = blendDef(clip.blend).canvas;
    if (hasShadow(clip)) {
      const sp = shadowPixels(clip.shadow!, H);
      ctx.shadowColor = `rgba(0,0,0,${clamp(clip.shadow!.opacity, 0, 1)})`;
      ctx.shadowBlur = sp.sigma * 2;
      ctx.shadowOffsetX = sp.dx;
      ctx.shadowOffsetY = sp.dy;
    }
    // Weichzeichnen (gleiche Stärke relativ zur Bildhöhe wie im Export)
    ctx.filter = clip.fx && clip.fx.blur > 0.01 ? `blur(${clip.fx.blur * 0.02 * H}px)` : 'none';
    ctx.translate(W / 2 + ((tr.x + mo.x) / 100) * W + (extra.dx ?? 0), H / 2 + ((tr.y + mo.y) / 100) * H + (extra.dy ?? 0));
    ctx.rotate(((tr.rotation + mo.rotation) * Math.PI) / 180);
    const sc = Math.max(0.01, tr.scale * mo.scale);
    if (clip.fit === 'cover') {
      const s = Math.max(W / vw, H / vh);
      const sw = W / s, sh = H / s;
      ctx.drawImage(source, (vw - sw) / 2, (vh - sh) / 2, sw, sh, (-W * sc) / 2, (-H * sc) / 2, W * sc, H * sc);
    } else if (clip.fit === 'stretch') {
      ctx.drawImage(source, (-W * sc) / 2, (-H * sc) / 2, W * sc, H * sc);
    } else {
      const s = Math.min(W / vw, H / vh) * sc;
      const dw = vw * s, dh = vh * s;
      ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
  }

  /** Position (in %) für Elemente, die an ein getracktes Objekt geheftet sind – oder null. */
  private attachedPosition(att: Attachment | undefined, t: number): { x: number; y: number } | null {
    if (!att) return null;
    const objClip = this.project.clips[att.clipId];
    const track = objClip?.objects?.find((tr) => tr.id === att.trackId);
    if (!objClip || !track) return null;
    const b = trackBoxAt(track, t - objClip.start);
    if (!b) return null;
    const x = (b.x + b.w / 2) * 100 + att.dx;
    let y = (b.y + b.h / 2) * 100;
    if (att.anchor === 'above') y = b.y * 100 - 2;
    else if (att.anchor === 'below') y = (b.y + b.h) * 100 + 2;
    return { x, y: y + att.dy };
  }

  private drawTitle(ctx: CanvasRenderingContext2D, clip: Clip, W: number, H: number, t: number): void {
    if (!clip.title) return;
    ctx.save();
    ctx.globalAlpha = clamp(clip.opacity, 0, 1);
    const pos = this.attachedPosition(clip.attach, t);
    const style = pos ? { ...clip.title, x: pos.x, y: pos.y } : clip.title;
    drawStyledText(ctx, style, clip.title.text, W, H, { localT: t - clip.start, duration: clipDuration(clip), animate: true });
    ctx.restore();
  }

  private drawSubtitles(ctx: CanvasRenderingContext2D, clip: Clip, W: number, H: number, t: number): void {
    const subs = clip.subtitles;
    if (!subs || !subs.enabled) return;
    const local = t - clip.start;
    const pos = this.attachedPosition(subs.attach, t);
    const style = pos ? { ...subs.style, x: pos.x, y: pos.y } : subs.style;
    const showTr = !!subs.showTranslation;
    const trColor = subs.translationColor ?? '#ffe066';
    for (const seg of subs.segments) {
      if (local >= seg.start && local < seg.end && seg.text.trim()) {
        // gleiche Regeln wie im Export (exporter.ts: mainText/secondText)
        const main = showTr && subs.translationOnly && seg.translation ? seg.translation : seg.text;
        const second = showTr && !subs.translationOnly && seg.translation ? { text: seg.translation, color: trColor } : undefined;
        drawStyledText(ctx, style, main, W, H, { localT: 0, duration: 1, animate: false }, second);
      }
    }
  }

  // ---------- Frames für die KI ----------

  private grabVideos = new Map<string, HTMLVideoElement>();

  /** Holt ein Einzelbild eines Clips zur Clip-Zeit `localT` (aus dem Proxy), max. `maxWidth` breit. */
  async grabFrame(clip: Clip, media: MediaItem, localT: number, maxWidth = 640): Promise<ImageData | null> {
    const t = clip.start + Math.max(0, Math.min(clipDuration(clip), localT));
    let source: CanvasImageSource;
    let sw = 0, sh = 0;
    if (media.type === 'image') {
      const img = new Image();
      img.src = window.panocut.toMediaUrl(isDisplayableImage(media.path) ? media.path : (media.thumb ?? media.path));
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Bild konnte nicht geladen werden')); });
      source = img; sw = img.naturalWidth; sh = img.naturalHeight;
    } else {
      const src = window.panocut.toMediaUrl(media.proxy ?? media.path);
      let v = this.grabVideos.get(src);
      if (!v) {
        v = document.createElement('video');
        v.muted = true; v.preload = 'auto'; v.src = src;
        this.grabVideos.set(src, v);
        await new Promise<void>((res, rej) => { v!.onloadeddata = () => res(); v!.onerror = () => rej(new Error('Video konnte nicht geladen werden')); });
      }
      const ft = this.fileTime(clip, media, t, false);
      if (Math.abs(v.currentTime - ft) > 0.01) {
        v.currentTime = ft;
        await new Promise<void>((res) => { const done = () => { v!.removeEventListener('seeked', done); res(); }; v!.addEventListener('seeked', done); setTimeout(done, 3000); });
      }
      source = v; sw = v.videoWidth; sh = v.videoHeight;
    }
    if (!sw || !sh) return null;
    const scale = Math.min(1, maxWidth / sw);
    const w = Math.max(2, Math.round(sw * scale)), h = Math.max(2, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** Läuft gerade ein Übergang auf dieser Spur? */
  private transitionAt(track: Track, t: number): ActiveTransition | null {
    for (const b of clipsOnTrack(this.project, track.id)) {
      const tr = b.transition;
      if (!tr) continue;
      const a = clipsOnTrack(this.project, track.id).find((c) => c.id !== b.id && Math.abs(clipEnd(c) - b.start) < 1 / 30);
      if (!a) continue;
      const d = Math.min(tr.duration, clipDuration(a), clipDuration(b));
      const start = b.start - d / 2;
      if (t >= start && t < start + d) {
        return { a, b, type: tr.type, progress: (t - start) / d, duration: d, cut: b.start, intensity: tr.intensity ?? 1 };
      }
    }
    return null;
  }

  private drawTransition(ctx: CanvasRenderingContext2D, tr: ActiveTransition, track: Track, W: number, H: number, t: number): void {
    const { a, b, progress: p } = tr;
    const mediaA = this.project.media[a.mediaId];
    const mediaB = this.project.media[b.mediaId];
    const draw = (clip: Clip, media: MediaItem | undefined, extra: DrawExtra) => {
      if (clip.kind === 'title') { this.drawTitle(ctx, clip, W, H, t); return; }
      if (!media || media.status === 'error' || media.type === 'audio') return;
      const slot = this.getSlot(clip, media);
      if (!slot.isImage) this.syncMedia(slot, clip, media, track, t, true);
      this.drawClip(ctx, slot, clip, media, W, H, { ...extra, localT: t - clip.start });
    };
    const type = tr.type;
    if (isDynamicTransition(type)) {
      // Dynamisch: beide Clips einzeln zeichnen, dann bewegt/verwischt übereinanderlegen (wie im Export)
      const f = dynTransitionAt(type, tr.intensity, p, tr.duration, W / H);
      const layerOf = (clip: Clip, media: MediaItem | undefined, i: number): HTMLCanvasElement => {
        const { c, x } = scratchCanvas(i, W, H);
        if (clip.kind === 'title') this.drawTitle(x, clip, W, H, t);
        else if (media && media.status !== 'error' && media.type !== 'audio') {
          const slot = this.getSlot(clip, media);
          if (!slot.isImage) this.syncMedia(slot, clip, media, track, t, true);
          this.drawClip(x, slot, clip, media, W, H, { localT: t - clip.start });
        }
        return c;
      };
      if (f.a.alpha > 0.001) this.composeLayer(ctx, layerOf(a, mediaA, 0), f.a, W, H);
      if (f.b.alpha > 0.001) this.composeLayer(ctx, layerOf(b, mediaB, 1), f.b, W, H);
      if (f.flash > 0.002) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, f.flash);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      return;
    }
    const rect = (x: number, y: number, w: number, h: number) => (c: CanvasRenderingContext2D) => { c.beginPath(); c.rect(x, y, w, h); c.clip(); };
    const circle = (r: number, inside: boolean) => (c: CanvasRenderingContext2D) => {
      c.beginPath();
      if (inside) c.arc(W / 2, H / 2, r, 0, Math.PI * 2);
      else { c.rect(0, 0, W, H); c.arc(W / 2, H / 2, r, 0, Math.PI * 2, true); }
      c.clip();
    };
    const R = Math.hypot(W, H) / 2;
    switch (type) {
      case 'fadeblack':
      case 'fadewhite': {
        ctx.fillStyle = type === 'fadeblack' ? '#000' : '#fff';
        if (p < 0.5) { draw(a, mediaA, {}); ctx.globalAlpha = p * 2; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
        else { ctx.fillRect(0, 0, W, H); draw(b, mediaB, { alpha: (p - 0.5) * 2 }); }
        break;
      }
      case 'wipeleft': draw(a, mediaA, {}); draw(b, mediaB, { clipPath: rect(W * (1 - p), 0, W * p, H) }); break;
      case 'wiperight': draw(a, mediaA, {}); draw(b, mediaB, { clipPath: rect(0, 0, W * p, H) }); break;
      case 'wipeup': draw(a, mediaA, {}); draw(b, mediaB, { clipPath: rect(0, H * (1 - p), W, H * p) }); break;
      case 'wipedown': draw(a, mediaA, {}); draw(b, mediaB, { clipPath: rect(0, 0, W, H * p) }); break;
      case 'smoothleft': draw(a, mediaA, {}); draw(b, mediaB, { clipPath: rect(W * (1 - p), 0, W * p, H), alpha: 1 }); break;
      case 'smoothright': draw(a, mediaA, {}); draw(b, mediaB, { clipPath: rect(0, 0, W * p, H) }); break;
      case 'slideleft': draw(a, mediaA, { dx: -W * p }); draw(b, mediaB, { dx: W * (1 - p) }); break;
      case 'slideright': draw(a, mediaA, { dx: W * p }); draw(b, mediaB, { dx: -W * (1 - p) }); break;
      case 'slideup': draw(a, mediaA, { dy: -H * p }); draw(b, mediaB, { dy: H * (1 - p) }); break;
      case 'slidedown': draw(a, mediaA, { dy: H * p }); draw(b, mediaB, { dy: -H * (1 - p) }); break;
      case 'circleopen': draw(a, mediaA, {}); draw(b, mediaB, { clipPath: circle(R * p, true) }); break;
      case 'circleclose': draw(b, mediaB, {}); draw(a, mediaA, { clipPath: circle(R * (1 - p), true) }); break;
      case 'zoomin': draw(a, mediaA, {}); draw(b, mediaB, { alpha: p }); break;
      default: draw(a, mediaA, {}); draw(b, mediaB, { alpha: p }); break;
    }
  }

  /** Eine Übergangs-Ebene bewegt, verwischt und mit Farbversatz auf das Bild legen (Spiegel von exporter.dynamicTransition). */
  private composeLayer(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, L: DynLayer, W: number, H: number): void {
    let img: HTMLCanvasElement = src;
    const shiftPx = (L.shift / 100) * W;
    if (Math.abs(shiftPx) >= 0.5) {
      // Glitch: Rot nach rechts, Blau nach links (wie rgbashift rh/bh)
      const out = scratchCanvas(3, W, H);
      out.x.globalCompositeOperation = 'lighter';
      for (const [color, dx] of [['#ff0000', Math.round(shiftPx)], ['#00ff00', 0], ['#0000ff', -Math.round(shiftPx)]] as const) {
        const ch = scratchCanvas(4, W, H);
        ch.x.drawImage(src, 0, 0);
        ch.x.globalCompositeOperation = 'multiply';
        ch.x.fillStyle = color;
        ch.x.fillRect(0, 0, W, H);
        ch.x.globalCompositeOperation = 'destination-in';
        ch.x.drawImage(src, 0, 0);
        out.x.drawImage(ch.c, dx, 0);
      }
      img = out.c;
    }
    const sigma = (L.blur / 100) * H;
    const directional = sigma > 0.3 && L.blurDir !== null;
    const tmp = scratchCanvas(2, W, H);
    const taps = directional ? 11 : 1;
    const ang = ((L.blurDir ?? 0) * Math.PI) / 180;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const o = taps === 1 ? 0 : ((k / (taps - 1)) * 2 - 1) * 2 * sigma;
      const w = taps === 1 ? 1 : Math.exp(-0.5 * Math.pow(o / sigma, 2));
      acc += w;
      tmp.x.save();
      tmp.x.globalAlpha = w / acc;   // laufender gewichteter Mittelwert
      tmp.x.translate(W / 2 + (L.x / 100) * W + o * Math.cos(ang), H / 2 + (L.y / 100) * H + o * Math.sin(ang));
      tmp.x.rotate((L.rotation * Math.PI) / 180);
      tmp.x.scale(L.scale, L.scale);
      tmp.x.drawImage(img, -W / 2, -H / 2, W, H);
      tmp.x.restore();
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, L.alpha));
    ctx.filter = sigma > 0.3 && !directional ? `blur(${sigma}px)` : 'none';
    ctx.drawImage(tmp.c, 0, 0);
    ctx.restore();
  }

  render(t: number): void {
    const { project } = this;
    const ctx = this.ctx;
    const activeIds = new Set<string>();

    // Audio-Spuren (nur Ton)
    for (const track of project.tracks) {
      if (track.kind !== 'audio') continue;
      const clip = clipAt(project, track.id, t);
      if (!clip || clip.kind === 'title') continue;
      const media = project.media[clip.mediaId];
      if (!media || media.status === 'error' || media.type === 'image') continue;
      const slot = this.getSlot(clip, media);
      activeIds.add(clip.id);
      this.syncMedia(slot, clip, media, track, t);
    }

    const tracks = videoTracksBottomUp(project);
    if (ctx && this.canvas) {
      const W = this.canvas.width, H = this.canvas.height;
      ctx.save();
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.fillStyle = project.settings.background || '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      for (const track of tracks) {
        if (track.hidden) continue;
        const tr = this.transitionAt(track, t);
        if (tr) {
          activeIds.add(tr.a.id);
          activeIds.add(tr.b.id);
          this.drawTransition(ctx, tr, track, W, H, t);
          const cur = t < tr.cut ? tr.a : tr.b;
          this.drawSubtitles(ctx, cur, W, H, t);
          continue;
        }
        const clip = clipAt(project, track.id, t);
        if (!clip) continue;
        if (clip.kind === 'title') { this.drawTitle(ctx, clip, W, H, t); continue; }
        const media = project.media[clip.mediaId];
        if (!media || media.status === 'error' || media.type === 'audio') continue;
        const slot = this.getSlot(clip, media);
        activeIds.add(clip.id);
        if (!slot.isImage) this.syncMedia(slot, clip, media, track, t);
        this.drawClip(ctx, slot, clip, media, W, H);
        this.drawSubtitles(ctx, clip, W, H, t);
      }
    } else {
      // Ohne Canvas trotzdem den Ton synchron halten
      for (const track of tracks) {
        if (track.hidden) continue;
        const clip = clipAt(project, track.id, t);
        if (!clip || clip.kind === 'title') continue;
        const media = project.media[clip.mediaId];
        if (!media || media.type !== 'video') continue;
        const slot = this.getSlot(clip, media);
        activeIds.add(clip.id);
        this.syncMedia(slot, clip, media, track, t);
      }
    }

    // Nicht sichtbare Clips anhalten; Clips, die bald starten, vorladen
    for (const [id, slot] of this.slots) {
      if (!activeIds.has(id)) {
        this.pauseSlot(slot);
        const clip = project.clips[id];
        if (clip && !slot.isImage && clip.kind !== 'title') {
          const m = slot.el as HTMLMediaElement;
          const media = project.media[clip.mediaId];
          if (media && clip.start > t && clip.start - t < 2) {
            const { reversedFile } = this.desiredSrc(clip, media);
            const ft = this.fileTime(clip, media, clip.start, reversedFile);
            if (Math.abs(m.currentTime - ft) > 0.05 && Math.abs(slot.lastSeek - ft) > 0.005) { slot.lastSeek = ft; m.currentTime = ft; }
          }
        }
      }
    }
  }
}
