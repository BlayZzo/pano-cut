import type { Clip, MediaItem, Project, Track } from '@shared/types';
import { clamp, clipAt, clipDuration, projectDuration, sourceTimeAt, videoTracksBottomUp } from '@shared/timeline';

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

interface Slot {
  el: MediaEl;
  src: string;
  isVideo: boolean;
  isImage: boolean;
  lastSeek: number;
}

const RATE_MIN = 0.0625;
const RATE_MAX = 16;
const SYNC_TOLERANCE = 0.12;

const DISPLAYABLE_IMAGES = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

function isDisplayableImage(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return DISPLAYABLE_IMAGES.has(ext);
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
  onTime: (t: number) => void = () => {};
  onEnded: () => void = () => {};
  /** Wird gerufen, wenn für einen Rückwärts-Clip noch keine Rückwärts-Vorschau existiert. */
  onNeedReversed: (media: MediaItem) => void = () => {};
  private requestedReversed = new Set<string>();

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
    // Elemente für gelöschte Clips entsorgen
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
  private fileTime(clip: Clip, media: MediaItem, t: number, reversedFile: boolean): number {
    const src = sourceTimeAt(clip, t);
    if (reversedFile) return Math.max(0, media.info.duration - src);
    return src;
  }

  private syncMedia(slot: Slot, clip: Clip, media: MediaItem, track: Track, t: number): void {
    const m = slot.el as HTMLMediaElement;
    const { reversedFile } = this.desiredSrc(clip, media);
    const target = this.fileTime(clip, media, t, reversedFile);
    const needsSeekMode = (clip.reverse && !reversedFile) || clip.speed < RATE_MIN || clip.speed > RATE_MAX;

    if (clip.reverse && !media.proxyReversed && media.proxy && !this.requestedReversed.has(media.id)) {
      this.requestedReversed.add(media.id);
      this.onNeedReversed(media);
    }

    // Lautstärke mit Ein-/Ausblenden
    const local = t - clip.start;
    const dur = clipDuration(clip);
    let gain = clamp(clip.volume, 0, 1);
    if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= clamp(local / clip.fadeIn, 0, 1);
    if (clip.fadeOut > 0 && dur - local < clip.fadeOut) gain *= clamp((dur - local) / clip.fadeOut, 0, 1);
    m.volume = clamp(gain, 0, 1);
    m.muted = this.muted || clip.muted || track.muted || needsSeekMode;

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

  private drawClip(ctx: CanvasRenderingContext2D, slot: Slot, clip: Clip, W: number, H: number): void {
    const el = slot.el;
    let vw = 0, vh = 0;
    if (slot.isImage) { vw = (el as HTMLImageElement).naturalWidth; vh = (el as HTMLImageElement).naturalHeight; }
    else if (slot.isVideo) {
      const v = el as HTMLVideoElement;
      if (v.readyState < 2) return;
      vw = v.videoWidth; vh = v.videoHeight;
    } else return;
    if (!vw || !vh) return;

    const tr = clip.transform;
    const col = clip.color;
    ctx.save();
    ctx.globalAlpha = clamp(clip.opacity, 0, 1);
    const filters: string[] = [];
    if (Math.abs(col.brightness) > 1e-4) filters.push(`brightness(${1 + col.brightness})`);
    if (Math.abs(col.contrast - 1) > 1e-4) filters.push(`contrast(${col.contrast})`);
    if (Math.abs(col.saturation - 1) > 1e-4) filters.push(`saturate(${col.saturation})`);
    if (Math.abs(col.hue) > 1e-4) filters.push(`hue-rotate(${col.hue}deg)`);
    ctx.filter = filters.length ? filters.join(' ') : 'none';
    ctx.translate(W / 2 + (tr.x / 100) * W, H / 2 + (tr.y / 100) * H);
    ctx.rotate((tr.rotation * Math.PI) / 180);
    const sc = Math.max(0.01, tr.scale);
    if (clip.fit === 'cover') {
      const s = Math.max(W / vw, H / vh);
      const sw = W / s, sh = H / s;
      ctx.drawImage(el as CanvasImageSource, (vw - sw) / 2, (vh - sh) / 2, sw, sh, (-W * sc) / 2, (-H * sc) / 2, W * sc, H * sc);
    } else if (clip.fit === 'stretch') {
      ctx.drawImage(el as CanvasImageSource, (-W * sc) / 2, (-H * sc) / 2, W * sc, H * sc);
    } else {
      const s = Math.min(W / vw, H / vh) * sc;
      const dw = vw * s, dh = vh * s;
      ctx.drawImage(el as CanvasImageSource, -dw / 2, -dh / 2, dw, dh);
    }
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
      if (!clip) continue;
      const media = project.media[clip.mediaId];
      if (!media || media.status === 'error' || media.type === 'image') continue;
      const slot = this.getSlot(clip, media);
      activeIds.add(clip.id);
      this.syncMedia(slot, clip, media, track, t);
    }

    if (ctx && this.canvas) {
      const W = this.canvas.width, H = this.canvas.height;
      ctx.save();
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.fillStyle = project.settings.background || '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      for (const track of videoTracksBottomUp(project)) {
        if (track.hidden) continue;
        const clip = clipAt(project, track.id, t);
        if (!clip) continue;
        const media = project.media[clip.mediaId];
        if (!media || media.status === 'error' || media.type === 'audio') continue;
        const slot = this.getSlot(clip, media);
        activeIds.add(clip.id);
        if (!slot.isImage) this.syncMedia(slot, clip, media, track, t);
        this.drawClip(ctx, slot, clip, W, H);
      }
    } else {
      // Ohne Canvas trotzdem den Ton synchron halten
      for (const track of videoTracksBottomUp(project)) {
        if (track.hidden) continue;
        const clip = clipAt(project, track.id, t);
        if (!clip) continue;
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
        if (clip && !slot.isImage) {
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
