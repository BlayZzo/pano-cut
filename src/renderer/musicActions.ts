// Auto-Musik-Schnitt: Takt erkennen und Video-Clips auf die Schläge schneiden.
import type { Clip, Project } from '@shared/types';
import { changeTempo } from '@shared/beats';
import { planBeatCut, type BeatCutOptions } from '@shared/beatcut';
import { clipEnd, makeId, videoTracksBottomUp } from '@shared/timeline';
import { beginTransaction, endTransaction, setDirty, untracked, useProject } from './store/project';
import { useUi } from './store/ui';
import { fmt, t } from './i18n/de';

const api = () => window.panocut;

/** Takt einer Mediendatei erkennen (läuft im Hintergrund, Ergebnis wird am Medium gespeichert). */
export async function detectBeats(mediaId: string): Promise<void> {
  const ui = useUi.getState();
  const media = useProject.getState().project.media[mediaId];
  if (!media || ui.beatJobs.includes(mediaId)) return;
  ui.setBeatJob(mediaId, true);
  try {
    const beats = await api().analyzeBeats(media.path);
    const cur = useProject.getState().project.media[mediaId];
    if (cur) untracked(() => useProject.getState().updateMedia({ ...cur, beats }));
    setDirty(true);
    if (beats.beats.length === 0) useUi.getState().toast(t.music.noBeats, 'error');
  } catch (e) {
    useUi.getState().toast(fmt(t.music.failed, { msg: (e as Error).message }), 'error');
  } finally {
    useUi.getState().setBeatJob(mediaId, false);
  }
}

/** Tempo korrigieren (×2 / ÷2), falls die Erkennung eine Oktave daneben lag. */
export function changeBeatTempo(mediaId: string, factor: 2 | 0.5): void {
  const media = useProject.getState().project.media[mediaId];
  if (!media?.beats) return;
  useProject.getState().updateMedia({ ...media, beats: changeTempo(media.beats, factor) });
}

function isVisualClip(project: Project, c: Clip): boolean {
  const tr = project.tracks.find((x) => x.id === c.trackId);
  if (!tr || tr.kind !== 'video' || tr.locked) return false;
  if (c.link) return false;
  if (c.kind === 'title') return false;
  const m = project.media[c.mediaId];
  return !!m && m.type !== 'audio' && !m.vfx;
}

/** Schneidet Video-Clips so, dass jeder Schnitt auf einem Schlag des Musik-Clips liegt. */
export function autoCutToMusic(musicClipId: string, opts: BeatCutOptions): void {
  const store = useProject.getState();
  const project = store.project;
  const music = project.clips[musicClipId];
  const media = music ? project.media[music.mediaId] : undefined;
  if (!music || !media) return;
  if (!media.beats || media.beats.beats.length === 0) { useUi.getState().toast(t.music.needBeats, 'error'); return; }

  // Quellen: ausgewählte Video-Clips, sonst alle Clips der untersten Videospur
  const order = new Map(project.tracks.map((tr, i) => [tr.id, i]));
  let sources = useUi.getState().selection
    .map((id) => project.clips[id])
    .filter((c): c is Clip => !!c && c.id !== music.id && isVisualClip(project, c));
  if (sources.length === 0) {
    const base = videoTracksBottomUp(project)[0];
    sources = Object.values(project.clips).filter((c) => c.trackId === base?.id && isVisualClip(project, c));
  }
  sources.sort((a, b) => a.start - b.start || (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0));
  if (sources.length === 0) { useUi.getState().toast(t.music.needVideo, 'error'); return; }

  const plan = planBeatCut(music, media.beats, sources, opts, () => makeId('clip'), (c) => project.media[c.mediaId]?.type === 'image');
  if (plan.clips.length === 0) { useUi.getState().toast(t.music.needBeats, 'error'); return; }

  beginTransaction();
  try {
    let target = sources[0].trackId;
    store.removeClips(sources.map((c) => c.id));
    // Liegen auf der Zielspur noch andere Clips im Bereich → neue Spur darüber
    const after = useProject.getState().project;
    const S = plan.clips[0].start, E = plan.end;
    const blocked = Object.values(after.clips).some((c) => c.trackId === target && c.start < E - 1e-6 && clipEnd(c) > S + 1e-6);
    if (blocked) target = useProject.getState().addVideoTrackAbove(target, t.music.trackName);
    const clips = plan.clips.map((c) => ({ ...c, trackId: target }));
    useProject.getState().insertClips(clips);
    useUi.getState().select(clips.map((c) => c.id));
  } finally {
    endTransaction();
  }
  setDirty(true);
  useUi.getState().toast(fmt(t.music.done, { n: plan.cuts, bpm: media.beats.bpm }), 'success');
}
