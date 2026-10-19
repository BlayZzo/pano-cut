import { create } from 'zustand';
import { temporal } from 'zundo';
import type { Clip, MediaItem, Project, ProjectSettings, Track, TrackKind } from '@shared/types';
import type { Attachment, ChromaKey, Cutout, ObjectTrack, PanoSettings, Stabilization, StitchSettings, SubtitleSegment, TitleStyle, Transition } from '@shared/types';
import {
  clipDuration, clipEnd, createClip, createProject, createTitleClip, createTrack, makeId, MIN_CLIP_DURATION, nextFreeStart, overlaps, sourceLimit, sourceTimeAt,
} from '@shared/timeline';
import { defaultPano, defaultSubtitleStyle } from '@shared/pano';
import { syncLinkedClips } from '@shared/layers';
import { sliceClip } from '@shared/clipslice';

export interface ProjectState {
  project: Project;
  path: string | null;

  setProject(project: Project, path: string | null): void;
  newProject(name: string, width: number, height: number, fps: number): void;
  setPath(path: string | null): void;
  rename(name: string): void;
  updateSettings(patch: Partial<ProjectSettings>): void;

  addMedia(items: MediaItem[]): void;
  updateMedia(item: MediaItem): void;
  removeMedia(id: string): void;

  addClip(mediaId: string, trackId: string, start: number): Clip | null;
  updateClip(id: string, patch: Partial<Clip>): void;
  updateClips(ids: string[], patch: Partial<Clip>): void;
  setSpeed(ids: string[], speed: number): void;
  moveClips(ids: string[], dt: number, trackId?: string, copy?: boolean): string[];
  trimClip(id: string, side: 'start' | 'end', time: number): void;
  splitClipAt(id: string, time: number): string | null;
  removeClips(ids: string[]): void;
  duplicateClips(ids: string[]): string[];

  addTrack(kind: TrackKind): void;
  removeTrack(id: string): void;
  updateTrack(id: string, patch: Partial<Track>): void;
  /** Spur innerhalb ihrer Art verschieben (-1 = nach oben/vorne, 1 = nach unten/hinten). */
  moveTrack(id: string, dir: -1 | 1): void;
  /** Neue Videospur ganz oben (vorderste Ebene) – optional direkt über einer bestimmten Spur. Gibt die ID zurück. */
  addVideoTrackAbove(aboveTrackId: string | null, name?: string): string;
  /** Fertige Clips einfügen (Effekte, Objekt-Kopien). */
  insertClips(clips: Clip[]): void;

  addTitleClip(trackId: string, start: number, title: TitleStyle): Clip | null;
  setPano(id: string, pano: PanoSettings | undefined): void;
  setTransition(id: string, transition: Transition | undefined): void;
  setStabilize(id: string, s: Stabilization | undefined): void;
  setSubtitles(id: string, segments: SubtitleSegment[] | null, style?: Partial<Omit<TitleStyle, 'text'>>, enabled?: boolean): void;
  setSubtitleOptions(id: string, patch: { showTranslation?: boolean; translationColor?: string; translationOnly?: boolean }): void;
  updateMediaStitch(mediaId: string, patch: Partial<StitchSettings>): void;

  addObjectTrack(clipId: string, track: ObjectTrack): void;
  updateObjectTrack(clipId: string, trackId: string, patch: Partial<ObjectTrack>): void;
  removeObjectTrack(clipId: string, trackId: string): void;
  setCutout(clipId: string, cutout: Cutout | undefined): void;
  setChroma(clipId: string, chroma: ChromaKey | undefined): void;
  setAttach(clipId: string, attach: Attachment | undefined, target: 'title' | 'subtitles'): void;
}

const HISTORY_LIMIT = 200;

type SetState = (partial: Partial<ProjectState> | ((s: ProjectState) => Partial<ProjectState>)) => void;

/** Jede Änderung am Projekt führt verknüpfte Clips (Lichtschein, Objekt-Kopien) automatisch nach. */
function withLinkSync(rawSet: SetState): SetState {
  return (partial) => rawSet((s) => {
    const r = typeof partial === 'function' ? partial(s) : partial;
    if (r && r.project) return { ...r, project: syncLinkedClips(r.project) };
    return r;
  });
}

export const useProject = create<ProjectState>()(
  temporal(
    (rawSet, get) => {
      const set = withLinkSync(rawSet as SetState);
      return {
      project: createProject(),
      path: null,

      setProject: (project, path) => set({ project, path }),
      newProject: (name, width, height, fps) => set({ project: createProject(name, width, height, fps), path: null }),
      setPath: (path) => set({ path }),
      rename: (name) => set((s) => ({ project: { ...s.project, name } })),
      updateSettings: (patch) => set((s) => ({ project: { ...s.project, settings: { ...s.project.settings, ...patch } } })),

      addMedia: (items) => set((s) => {
        const media = { ...s.project.media };
        for (const it of items) media[it.id] = it;
        return { project: { ...s.project, media } };
      }),
      updateMedia: (item) => set((s) => {
        if (!s.project.media[item.id]) return {};
        return { project: { ...s.project, media: { ...s.project.media, [item.id]: { ...s.project.media[item.id], ...item } } } };
      }),
      removeMedia: (id) => set((s) => {
        const media = { ...s.project.media };
        delete media[id];
        const clips = { ...s.project.clips };
        for (const c of Object.values(clips)) if (c.mediaId === id) delete clips[c.id];
        return { project: { ...s.project, media, clips } };
      }),

      addClip: (mediaId, trackId, start) => {
        const s = get();
        const media = s.project.media[mediaId];
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (!media || !track || track.locked) return null;
        if (track.kind === 'audio' && media.type === 'image') return null;
        const clip = createClip(media, trackId, Math.max(0, start));
        if (media.info.is360 && track.kind === 'video') clip.pano = defaultPano(s.project.settings.is360 ? 'equirect' : 'flat');
        clip.start = nextFreeStart(s.project, clip, clip.start, trackId);
        set({ project: { ...s.project, clips: { ...s.project.clips, [clip.id]: clip } } });
        return clip;
      },
      updateClip: (id, patch) => set((s) => {
        const c = s.project.clips[id];
        if (!c) return {};
        return { project: { ...s.project, clips: { ...s.project.clips, [id]: { ...c, ...patch } } } };
      }),
      updateClips: (ids, patch) => set((s) => {
        const clips = { ...s.project.clips };
        for (const id of ids) if (clips[id]) clips[id] = { ...clips[id], ...patch };
        return { project: { ...s.project, clips } };
      }),

      moveClips: (ids, dt, trackId, copy) => {
        const s = get();
        const project = s.project;
        const moving = ids.map((id) => project.clips[id]).filter(Boolean) as Clip[];
        if (moving.length === 0) return [];
        // Frühester Clip darf nicht vor 0 rutschen
        const minStart = Math.min(...moving.map((c) => c.start));
        const delta = Math.max(dt, -minStart);
        const ignore = new Set(copy ? [] : ids);
        const clips = { ...project.clips };
        const resultIds: string[] = [];
        // Spurwechsel nur, wenn alle Clips von derselben Spur kommen und die Zielspur passt
        const sameTrack = moving.every((c) => c.trackId === moving[0].trackId);
        const target = trackId && sameTrack ? project.tracks.find((t) => t.id === trackId) : undefined;
        for (const c of moving) {
          const media = project.media[c.mediaId];
          let newTrack = c.trackId;
          if (target && !target.locked) {
            const srcTrack = project.tracks.find((t) => t.id === c.trackId);
            const kindOk = target.kind === srcTrack?.kind || (target.kind === 'audio' && media?.type !== 'image') || (target.kind === 'video' && media?.type !== 'audio');
            if (kindOk) newTrack = target.id;
          }
          const newStart = Math.max(0, c.start + delta);
          if (overlaps(project, c, newStart, newTrack, ignore)) return []; // Kollision: nichts ändern
          const id = copy ? makeId('clip') : c.id;
          clips[id] = { ...c, id, start: newStart, trackId: newTrack };
          resultIds.push(id);
        }
        set({ project: { ...project, clips } });
        return resultIds;
      },

      setSpeed: (ids, speed) => set((s) => {
        const clips = { ...s.project.clips };
        for (const id of ids) {
          const c = clips[id];
          if (!c) continue;
          const sp = Math.min(100, Math.max(0.05, speed));
          const next: Clip = { ...c, speed: sp };
          // Darf nicht in den nächsten Clip der Spur hineinwachsen
          const following = Object.values(clips).filter((o) => o.trackId === c.trackId && o.id !== c.id && o.start >= clipEnd(c) - 1e-6).sort((a, b) => a.start - b.start)[0];
          const limit = following ? following.start : Number.POSITIVE_INFINITY;
          if (clipEnd(next) > limit + 1e-6) {
            const srcLen = Math.max(MIN_CLIP_DURATION * sp, (limit - c.start) * sp);
            if (c.reverse) next.in = Math.max(0, c.out - srcLen); else next.out = c.in + srcLen;
          }
          clips[id] = next;
        }
        return { project: { ...s.project, clips } };
      }),

      trimClip: (id, side, time) => set((s) => {
        const c = s.project.clips[id];
        if (!c) return {};
        const media = s.project.media[c.mediaId];
        const srcMax = sourceLimit(c, media);
        let next: Clip;
        if (side === 'start') {
          // Neuer Anfang auf der Timeline; In-Punkt entsprechend verschieben
          const end = clipEnd(c);
          const newStart = Math.min(Math.max(0, time), end - MIN_CLIP_DURATION);
          const dSrc = (newStart - c.start) * c.speed;
          if (c.reverse) {
            const newOut = Math.min(srcMax, c.out - dSrc);
            if (newOut - c.in < MIN_CLIP_DURATION) return {};
            next = { ...c, start: newStart, out: newOut };
          } else {
            const newIn = Math.max(0, c.in + dSrc);
            if (c.out - newIn < MIN_CLIP_DURATION) return {};
            next = { ...c, start: newStart, in: newIn };
          }
        } else {
          const newEnd = Math.max(c.start + MIN_CLIP_DURATION, time);
          const newDurSrc = (newEnd - c.start) * c.speed;
          if (c.reverse) {
            const newIn = Math.max(0, c.out - newDurSrc);
            next = { ...c, in: newIn };
          } else {
            const newOut = Math.min(srcMax, c.in + newDurSrc);
            next = { ...c, out: newOut };
          }
        }
        if (overlaps(s.project, next, next.start, next.trackId)) return {};
        return { project: { ...s.project, clips: { ...s.project.clips, [id]: next } } };
      }),

      splitClipAt: (id, time) => {
        const s = get();
        const c = s.project.clips[id];
        if (!c) return null;
        const end = clipEnd(c);
        if (time <= c.start + MIN_CLIP_DURATION || time >= end - MIN_CLIP_DURATION) return null;
        // Clip-lokale Zeiten (360°-Blick, Animation, Untertitel, Objekte) mit aufteilen
        const rightId = makeId('clip');
        const left = sliceClip(c, 0, time - c.start, c.id);
        const right = sliceClip(c, time - c.start, end - c.start, rightId);
        set({ project: { ...s.project, clips: { ...s.project.clips, [id]: left, [rightId]: right } } });
        return rightId;
      },

      removeClips: (ids) => set((s) => {
        const clips = { ...s.project.clips };
        for (const id of ids) delete clips[id];
        return { project: { ...s.project, clips } };
      }),

      duplicateClips: (ids) => {
        const s = get();
        const clips = { ...s.project.clips };
        const out: string[] = [];
        for (const id of ids) {
          const c = clips[id];
          if (!c) continue;
          const copy: Clip = { ...c, id: makeId('clip') };
          copy.start = nextFreeStart({ ...s.project, clips }, copy, clipEnd(c), c.trackId);
          clips[copy.id] = copy;
          out.push(copy.id);
        }
        set({ project: { ...s.project, clips } });
        return out;
      },

      addTrack: (kind) => set((s) => {
        const count = s.project.tracks.filter((t) => t.kind === kind).length + 1;
        const track = createTrack(kind, count);
        const tracks = kind === 'video' ? [track, ...s.project.tracks] : [...s.project.tracks, track];
        return { project: { ...s.project, tracks } };
      }),
      removeTrack: (id) => set((s) => {
        const track = s.project.tracks.find((t) => t.id === id);
        if (!track) return {};
        if (s.project.tracks.filter((t) => t.kind === track.kind).length <= 1) return {};
        const clips = { ...s.project.clips };
        for (const c of Object.values(clips)) if (c.trackId === id) delete clips[c.id];
        return { project: { ...s.project, tracks: s.project.tracks.filter((t) => t.id !== id), clips } };
      }),
      updateTrack: (id, patch) => set((s) => ({
        project: { ...s.project, tracks: s.project.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) },
      })),
      moveTrack: (id, dir) => set((s) => {
        const tracks = [...s.project.tracks];
        const i = tracks.findIndex((t) => t.id === id);
        if (i < 0) return {};
        const j = i + dir;
        if (j < 0 || j >= tracks.length || tracks[j].kind !== tracks[i].kind) return {};
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
        return { project: { ...s.project, tracks } };
      }),
      addVideoTrackAbove: (aboveTrackId, name) => {
        const s = get();
        const count = s.project.tracks.filter((t) => t.kind === 'video').length + 1;
        const track = createTrack('video', count);
        if (name) track.name = name;
        const tracks = [...s.project.tracks];
        const idx = aboveTrackId ? tracks.findIndex((t) => t.id === aboveTrackId) : -1;
        tracks.splice(idx >= 0 ? idx : 0, 0, track);
        set({ project: { ...s.project, tracks } });
        return track.id;
      },
      insertClips: (newClips) => set((s) => {
        const clips = { ...s.project.clips };
        for (const c of newClips) clips[c.id] = c;
        return { project: { ...s.project, clips } };
      }),

      addTitleClip: (trackId, start, title) => {
        const s = get();
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (!track || track.kind !== 'video' || track.locked) return null;
        const clip = createTitleClip(trackId, Math.max(0, start), title);
        clip.start = nextFreeStart(s.project, clip, clip.start, trackId);
        set({ project: { ...s.project, clips: { ...s.project.clips, [clip.id]: clip } } });
        return clip;
      },
      setPano: (id, pano) => set((s) => {
        const c = s.project.clips[id];
        if (!c) return {};
        const next = { ...c };
        if (pano) next.pano = pano; else delete next.pano;
        return { project: { ...s.project, clips: { ...s.project.clips, [id]: next } } };
      }),
      setTransition: (id, transition) => set((s) => {
        const c = s.project.clips[id];
        if (!c) return {};
        const next = { ...c };
        if (transition) next.transition = transition; else delete next.transition;
        return { project: { ...s.project, clips: { ...s.project.clips, [id]: next } } };
      }),
      setStabilize: (id, st) => set((s) => {
        const c = s.project.clips[id];
        if (!c) return {};
        const next = { ...c };
        if (st) next.stabilize = st; else delete next.stabilize;
        return { project: { ...s.project, clips: { ...s.project.clips, [id]: next } } };
      }),
      setSubtitles: (id, segments, style, enabled) => set((s) => {
        const c = s.project.clips[id];
        if (!c) return {};
        const next = { ...c };
        if (segments === null) { delete next.subtitles; }
        else {
          next.subtitles = {
            ...(c.subtitles ?? {}),
            segments,
            style: { ...(c.subtitles?.style ?? defaultSubtitleStyle()), ...(style ?? {}) },
            enabled: enabled ?? c.subtitles?.enabled ?? true,
          };
        }
        return { project: { ...s.project, clips: { ...s.project.clips, [id]: next } } };
      }),
      setSubtitleOptions: (id, patch) => set((s) => {
        const c = s.project.clips[id];
        if (!c?.subtitles) return {};
        return { project: { ...s.project, clips: { ...s.project.clips, [id]: { ...c, subtitles: { ...c.subtitles, ...patch } } } } };
      }),
      updateMediaStitch: (mediaId, patch) => set((s) => {
        const m = s.project.media[mediaId];
        if (!m || !m.stitch) return {};
        return { project: { ...s.project, media: { ...s.project.media, [mediaId]: { ...m, stitch: { ...m.stitch, ...patch } } } } };
      }),

      addObjectTrack: (clipId, track) => set((s) => {
        const c = s.project.clips[clipId];
        if (!c) return {};
        return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: { ...c, objects: [...(c.objects ?? []), track] } } } };
      }),
      updateObjectTrack: (clipId, trackId, patch) => set((s) => {
        const c = s.project.clips[clipId];
        if (!c?.objects) return {};
        return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: { ...c, objects: c.objects.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) } } } };
      }),
      removeObjectTrack: (clipId, trackId) => set((s) => {
        const c = s.project.clips[clipId];
        if (!c?.objects) return {};
        const next: Clip = { ...c, objects: c.objects.filter((t) => t.id !== trackId) };
        if (next.cutout?.trackId === trackId) delete next.cutout;
        return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: next } } };
      }),
      setCutout: (clipId, cutout) => set((s) => {
        const c = s.project.clips[clipId];
        if (!c) return {};
        const next = { ...c };
        if (cutout) next.cutout = cutout; else delete next.cutout;
        return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: next } } };
      }),
      setChroma: (clipId, chroma) => set((s) => {
        const c = s.project.clips[clipId];
        if (!c) return {};
        const next = { ...c };
        if (chroma) next.chroma = chroma; else delete next.chroma;
        return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: next } } };
      }),
      setAttach: (clipId, attach, target) => set((s) => {
        const c = s.project.clips[clipId];
        if (!c) return {};
        const next = { ...c };
        if (target === 'title') { if (attach) next.attach = attach; else delete next.attach; }
        else if (next.subtitles) { next.subtitles = { ...next.subtitles, attach }; if (!attach) delete next.subtitles.attach; }
        return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: next } } };
      }),
    };
    },
    {
      limit: HISTORY_LIMIT,
      partialize: (s) => ({ project: s.project }),
      equality: (a, b) => a.project === b.project,
    },
  ),
);

// ---------- Verlauf (Rückgängig / Wiederholen) ----------

type Snapshot = { project: Project };
let txSnapshot: Snapshot | null = null;

/** Beginnt eine zusammengefasste Änderung (z. B. Schieberegler ziehen): nur EIN Rückgängig-Schritt. */
export function beginTransaction(): void {
  if (txSnapshot) return;
  txSnapshot = { project: useProject.getState().project };
  useProject.temporal.getState().pause();
}

export function endTransaction(): void {
  if (!txSnapshot) return;
  const temporal = useProject.temporal;
  temporal.getState().resume();
  const current = useProject.getState().project;
  if (current !== txSnapshot.project) {
    const past = [...temporal.getState().pastStates, txSnapshot].slice(-HISTORY_LIMIT);
    temporal.setState({ pastStates: past as Snapshot[], futureStates: [] });
    markDirty();
  }
  txSnapshot = null;
}

/** Änderung ohne Verlaufseintrag (z. B. Status-Updates aus dem Hauptprozess). */
export function untracked(fn: () => void): void {
  const temporal = useProject.temporal.getState();
  const wasTracking = temporal.isTracking;
  if (wasTracking) temporal.pause();
  try { fn(); } finally { if (wasTracking) useProject.temporal.getState().resume(); }
}

export function undo(): void { useProject.temporal.getState().undo(); markDirty(); }
export function redo(): void { useProject.temporal.getState().redo(); markDirty(); }
export function canUndo(): boolean { return useProject.temporal.getState().pastStates.length > 0; }
export function canRedo(): boolean { return useProject.temporal.getState().futureStates.length > 0; }
export function clearHistory(): void { useProject.temporal.getState().clear(); }

// ---------- Ungespeicherte Änderungen ----------

let dirtyListeners: Array<(d: boolean) => void> = [];
let dirtyFlag = false;
export function isDirty(): boolean { return dirtyFlag; }
export function setDirty(d: boolean): void {
  if (dirtyFlag === d) return;
  dirtyFlag = d;
  window.panocut?.setDirty(d);
  dirtyListeners.forEach((l) => l(d));
}
export function markDirty(): void { setDirty(true); }
export function onDirtyChange(l: (d: boolean) => void): () => void {
  dirtyListeners.push(l);
  return () => { dirtyListeners = dirtyListeners.filter((x) => x !== l); };
}

// Jede im Verlauf gespeicherte Änderung markiert das Projekt als ungespeichert.
useProject.temporal.getState().setOnSave(() => markDirty());

export function clipDurationOf(id: string): number {
  const c = useProject.getState().project.clips[id];
  return c ? clipDuration(c) : 0;
}
