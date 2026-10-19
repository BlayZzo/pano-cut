// Mehrkamera: aus mehreren Kamera-Clips eine Gruppe bilden (Ton-Synchronisierung), Kamera umschalten, automatisch wechseln.
import type { Clip, MulticamGroup } from '@shared/types';
import { angleAt, angleTemplate, autoSwitchCuts, buildMulticamClips, correlateEnvelopes, normalizeCuts, switchAngle } from '@shared/multicam';
import { beatsOnTimeline } from '@shared/beats';
import { makeId } from '@shared/timeline';
import { beginTransaction, endTransaction, setDirty, useProject } from './store/project';
import { useUi } from './store/ui';
import { engine } from './engine/instance';
import { fmt, t } from './i18n/de';

const api = () => window.panocut;
const MIN_CONFIDENCE = 0.15;
export const MAX_ANGLES = 9;

/** Kann aus der Auswahl eine Mehrkamera-Gruppe werden? */
export function multicamCandidates(ids: string[]): Clip[] {
  const p = useProject.getState().project;
  const order = new Map(p.tracks.map((tr, i) => [tr.id, i]));
  return ids
    .map((id) => p.clips[id])
    .filter((c): c is Clip => !!c && !c.mc && c.kind !== 'title' && p.media[c.mediaId]?.type === 'video' && !p.media[c.mediaId]?.vfx)
    .sort((a, b) => (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0) || a.start - b.start)
    .slice(0, MAX_ANGLES);
}

/** Mehrkamera-Gruppe aus den gewählten Clips: über den Ton synchronisieren, Stücke und Ton anlegen. */
export async function createMulticam(ids: string[]): Promise<void> {
  const clips = multicamCandidates(ids);
  if (clips.length < 2) { useUi.getState().toast(t.multicam.needTwo, 'error'); return; }
  const p0 = useProject.getState().project;
  useUi.getState().toast(t.multicam.syncing, 'info');
  // Ton-Hüllkurven (max. 15 Minuten je Kamera)
  const envs = await Promise.all(clips.map(async (c) => {
    const m = p0.media[c.mediaId];
    if (!m?.info.hasAudio) return null;
    try { return await api().audioEnvelope(m.path, 0, Math.min(900, m.info.duration)); } catch { return null; }
  }));
  const refIdx = envs.findIndex((e) => !!e);
  const ref = refIdx >= 0 ? envs[refIdx]! : null;
  // Beginn jeder Datei relativ zur Bezugs-Kamera (Sekunden)
  const timelineShift = (c: Clip) => c.start - c.in;  // ohne Ton: so, wie die Clips in der Timeline liegen
  const refClip = clips[Math.max(0, refIdx)];
  const shifts: number[] = [];
  const confidence: number[] = [];
  let unsure = 0;
  clips.forEach((c, i) => {
    const e = envs[i];
    if (i === refIdx) { shifts.push(0); confidence.push(1); return; }
    if (ref && e) {
      const r = correlateEnvelopes(ref.env, e.env, ref.hop);
      if (r.confidence >= MIN_CONFIDENCE) { shifts.push(r.lag); confidence.push(r.confidence); return; }
    }
    unsure++;
    shifts.push(timelineShift(c) - timelineShift(refClip));
    confidence.push(0);
  });
  const minShift = Math.min(...shifts);
  const angles = clips.map((c, i) => ({
    mediaId: c.mediaId,
    name: `${i + 1}: ${p0.media[c.mediaId]?.name ?? c.name}`,
    shift: shifts[i] - minShift,
    template: angleTemplate(c),
  }));
  const duration = Math.max(...angles.map((a) => a.shift + (p0.media[a.mediaId]?.info.duration ?? 0)));
  // Gruppe so legen, dass die Bezugs-Kamera dort bleibt, wo ihr Clip-Anfang war (nicht vor 0)
  const refStartInGroup = angles[Math.max(0, refIdx)].shift + refClip.in;
  const start = Math.max(0, refClip.start - refStartInGroup);
  const audioAngle = Math.max(0, refIdx);

  beginTransaction();
  try {
    const st = useProject.getState();
    st.removeClips(clips.map((c) => c.id));
    const topTrack = clips.map((c) => c.trackId).sort((a, b) => st.project.tracks.findIndex((x) => x.id === a) - st.project.tracks.findIndex((x) => x.id === b))[0];
    const trackId = useProject.getState().addVideoTrackAbove(topTrack, t.multicam.trackName);
    const audioTrackId = useProject.getState().addAudioTrack(t.multicam.audioTrackName);
    const group: MulticamGroup = {
      id: makeId('mc'), name: t.multicam.trackName, trackId, audioTrackId, start, duration,
      angles, audioAngle, cuts: [{ t: 0, angle: 0 }], confidence,
    };
    const out = buildMulticamClips(group, useProject.getState().project);
    useProject.getState().setMulticam(group.id, group, out);
    useUi.getState().select(out.filter((c) => c.mc!.angle >= 0).slice(0, 1).map((c) => c.id));
    useUi.getState().setMulticamPanel(group.id);
  } finally {
    endTransaction();
  }
  setDirty(true);
  useUi.getState().toast(unsure > 0 ? fmt(t.multicam.syncUnsure, { n: unsure }) : fmt(t.multicam.created, { n: clips.length }), unsure > 0 ? 'error' : 'success');
}

/** Gruppe, in der eine Timeline-Zeit liegt (bevorzugt die im Panel geöffnete). */
export function groupAt(time: number): MulticamGroup | null {
  const p = useProject.getState().project;
  const open = useUi.getState().multicamPanel;
  const groups = Object.values(p.multicam ?? {});
  const inside = (g: MulticamGroup) => time >= g.start - 1e-6 && time < g.start + g.duration;
  const og = open ? p.multicam?.[open] : undefined;
  if (og && inside(og)) return og;
  return groups.find(inside) ?? og ?? null;
}

function apply(group: MulticamGroup, patch: Partial<MulticamGroup>, tracked = true): void {
  const next = { ...group, ...patch };
  next.cuts = normalizeCuts(next.cuts, next.duration);
  const clips = buildMulticamClips(next, useProject.getState().project);
  if (tracked) beginTransaction();
  useProject.getState().setMulticam(next.id, next, clips);
  if (tracked) endTransaction();
  setDirty(true);
}

/** Kamera umschalten (Taste 1–9 oder Klick im Mehrkamera-Feld). Während der Wiedergabe entsteht ein Schnitt. */
export function switchToAngle(angle: number): void {
  const time = useUi.getState().playhead;
  const g = groupAt(time);
  if (!g || angle < 0 || angle >= g.angles.length) return;
  const local = time - g.start;
  if (local < 0 || local >= g.duration) return;
  apply(g, { cuts: switchAngle(g, local, angle, engine.isPlaying) });
}

export function currentAngle(g: MulticamGroup, time: number): number {
  return angleAt(g, time - g.start);
}

export function setAudioAngle(groupId: string, angle: number): void {
  const g = useProject.getState().project.multicam?.[groupId];
  if (g) apply(g, { audioAngle: angle });
}

export function resetCuts(groupId: string): void {
  const g = useProject.getState().project.multicam?.[groupId];
  if (g) apply(g, { cuts: [{ t: 0, angle: angleAt(g, 0) }] });
}

/** Automatisch zwischen den Kameras wechseln – auf jeden Takt der Musik (falls erkannt) oder alle paar Sekunden. */
export function autoSwitch(groupId: string): void {
  const p = useProject.getState().project;
  const g = p.multicam?.[groupId];
  if (!g) return;
  // Takt-Eins aller Musik-Clips in der Gruppe (ohne den Ton der Gruppe selbst)
  const times: number[] = [];
  for (const c of Object.values(p.clips)) {
    const m = p.media[c.mediaId];
    if (!m?.beats || c.mc) continue;
    for (const b of beatsOnTimeline(m.beats, c, 'downbeats')) {
      const local = b - g.start;
      if (local > 0 && local < g.duration) times.push(local);
    }
  }
  times.sort((a, b) => a - b);
  // höchstens alle 1,5 s wechseln
  const spaced: number[] = [];
  for (const x of times) if (!spaced.length || x - spaced[spaced.length - 1] >= 1.5) spaced.push(x);
  apply(g, { cuts: autoSwitchCuts(g, p, spaced) });
  useUi.getState().toast(spaced.length ? t.multicam.autoBeats : t.multicam.autoTimed, 'success');
}

/** Gruppe auflösen: Stücke bleiben als normale Clips liegen. */
export function dissolveMulticam(groupId: string): void {
  const p = useProject.getState().project;
  const g = p.multicam?.[groupId];
  if (!g) return;
  const clips = Object.values(p.clips).filter((c) => c.mc?.groupId === groupId).map((c) => ({ ...c, mc: undefined, id: makeId('clip') }));
  beginTransaction();
  useProject.getState().setMulticam(groupId, null, clips);
  endTransaction();
  useUi.getState().setMulticamPanel(null);
  setDirty(true);
}
