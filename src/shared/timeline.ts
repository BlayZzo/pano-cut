import type { Clip, ColorGrade, MediaItem, Project, TitleStyle, Track, Transform } from './types';

export const MIN_CLIP_DURATION = 0.04;
export const DEFAULT_IMAGE_DURATION = 5;

export function clipDuration(clip: Clip): number {
  return Math.max(MIN_CLIP_DURATION, (clip.out - clip.in) / clip.speed);
}

export function clipEnd(clip: Clip): number {
  return clip.start + clipDuration(clip);
}

/** Quellzeit (Sekunden in der Originaldatei) für eine Timeline-Zeit innerhalb des Clips. */
export function sourceTimeAt(clip: Clip, t: number): number {
  const local = Math.max(0, Math.min(clipDuration(clip), t - clip.start)) * clip.speed;
  return clip.reverse ? clip.out - local : clip.in + local;
}

export function clipsOnTrack(project: Project, trackId: string): Clip[] {
  return Object.values(project.clips)
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

export function clipAt(project: Project, trackId: string, t: number): Clip | undefined {
  for (const c of Object.values(project.clips)) {
    if (c.trackId === trackId && t >= c.start && t < clipEnd(c)) return c;
  }
  return undefined;
}

export function projectDuration(project: Project): number {
  let end = 0;
  for (const c of Object.values(project.clips)) end = Math.max(end, clipEnd(c));
  return end;
}

/** Prüft, ob ein Clip (mit optional neuer Position/Spur) mit anderen Clips kollidiert. */
export function overlaps(project: Project, clip: Clip, start: number, trackId: string, ignore: Set<string> = new Set()): boolean {
  const end = start + clipDuration(clip);
  for (const other of Object.values(project.clips)) {
    if (other.id === clip.id || ignore.has(other.id) || other.trackId !== trackId) continue;
    const oEnd = clipEnd(other);
    if (start < oEnd - 1e-6 && end > other.start + 1e-6) return true;
  }
  return false;
}

/** Findet die nächste freie Position ≥ start auf einer Spur. */
export function nextFreeStart(project: Project, clip: Clip, start: number, trackId: string, ignore: Set<string> = new Set()): number {
  let s = Math.max(0, start);
  const dur = clipDuration(clip);
  const others = Object.values(project.clips)
    .filter((o) => o.trackId === trackId && o.id !== clip.id && !ignore.has(o.id))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < 50; i++) {
    const hit = others.find((o) => s < clipEnd(o) - 1e-6 && s + dur > o.start + 1e-6);
    if (!hit) return s;
    s = clipEnd(hit);
  }
  return s;
}

export function defaultTransform(): Transform {
  return { x: 0, y: 0, scale: 1, rotation: 0 };
}

export function defaultColor(): ColorGrade {
  return { brightness: 0, contrast: 1, saturation: 1, hue: 0 };
}

export function makeId(prefix = ''): string {
  const r = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return prefix ? `${prefix}_${r}` : r;
}

export function createClip(media: MediaItem, trackId: string, start: number): Clip {
  const dur = media.type === 'image' ? DEFAULT_IMAGE_DURATION : media.info.duration;
  return {
    id: makeId('clip'),
    trackId,
    mediaId: media.id,
    name: media.name,
    start,
    in: 0,
    out: dur,
    speed: 1,
    reverse: false,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    fit: 'contain',
    transform: defaultTransform(),
    color: defaultColor(),
  };
}

export const DEFAULT_TITLE_DURATION = 4;

export function createTitleClip(trackId: string, start: number, title: TitleStyle, duration = DEFAULT_TITLE_DURATION): Clip {
  return {
    id: makeId('clip'),
    trackId,
    mediaId: '',
    name: title.text.split('\n')[0] || 'Titel',
    start,
    in: 0,
    out: duration,
    speed: 1,
    reverse: false,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    fit: 'contain',
    transform: defaultTransform(),
    color: defaultColor(),
    kind: 'title',
    title,
  };
}

/** Maximale Quelllänge eines Clips (Bilder und Titel sind beliebig lang). */
export function sourceLimit(clip: Clip, media: MediaItem | undefined): number {
  if (clip.kind === 'title' || media?.type === 'image') return Number.POSITIVE_INFINITY;
  return media?.info.duration ?? clip.out;
}

export function createTrack(kind: Track['kind'], index: number): Track {
  return {
    id: makeId(kind === 'video' ? 'v' : 'a'),
    kind,
    name: kind === 'video' ? `Video ${index}` : `Audio ${index}`,
    muted: false,
    locked: false,
    hidden: false,
  };
}

export function createProject(name = 'Unbenanntes Projekt', width = 1920, height = 1080, fps = 30): Project {
  const now = Date.now();
  return {
    version: 1,
    id: makeId('proj'),
    name,
    settings: { width, height, fps, background: '#000000' },
    media: {},
    tracks: [createTrack('video', 2), createTrack('video', 1), createTrack('audio', 1), createTrack('audio', 2)],
    clips: {},
    createdAt: now,
    modifiedAt: now,
  };
}

/** Spuren in Zeichenreihenfolge (unterste Videospur zuerst). Die Spurliste ist von oben nach unten sortiert. */
export function videoTracksBottomUp(project: Project): Track[] {
  return project.tracks.filter((t) => t.kind === 'video').reverse();
}

export function formatTime(seconds: number, fps = 30, withFrames = true): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalFrames = Math.round(seconds * fps);
  const f = totalFrames % fps;
  const s = Math.floor(totalFrames / fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => n.toString().padStart(2, '0');
  const base = h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  return withFrames ? `${base}.${p(f)}` : base;
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds)) return '–';
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')} min`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
