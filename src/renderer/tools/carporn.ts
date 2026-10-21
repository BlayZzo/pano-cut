// 🏎 Carporn-Werkzeuge: fertige Schnitt-Varianten und Looks aus vorhandenen Bausteinen
// (Tempo-Rampen, Beat-Schnitt, Stöße, Wisch-Schwenks, Looks, Kino-Balken, Objekt vor Text).
import type { Clip, Project, TransitionType } from '@shared/types';
import { speedRampPieces, type SpeedRamp } from '@shared/cameraMoves';
import { shakeKeyframes } from '@shared/vfx';
import { beatsOnTimeline } from '@shared/beats';
import { clipDuration, clipEnd, videoTracksBottomUp } from '@shared/timeline';
import { defaultTitle } from '@shared/pano';
import { NEUTRAL_FX } from '@shared/effects';
import { DEFAULT_BEAT_CUT } from '@shared/beatcut';
import { beginTransaction, endTransaction, setDirty, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { applyTransitionToClip } from '../actions';
import { bringObjectToFront } from '../vfx/actions';
import { autoCutToMusic, detectBeats } from '../musicActions';
import { fmt, t } from '../i18n/de';

function isVisual(p: Project, c: Clip): boolean {
  const tr = p.tracks.find((x) => x.id === c.trackId);
  const m = p.media[c.mediaId];
  return !!tr && tr.kind === 'video' && !tr.locked && c.kind !== 'title' && !c.link && !!m && m.type === 'video' && !m.vfx;
}

/** Ausgewählte Video-Clips – sonst alle auf der untersten Videospur. Zeitlich sortiert. */
export function targetClips(): Clip[] {
  const p = useProject.getState().project;
  let list = useUi.getState().selection.map((id) => p.clips[id]).filter((c): c is Clip => !!c && isVisual(p, c));
  if (!list.length) {
    const base = videoTracksBottomUp(p)[0];
    list = Object.values(p.clips).filter((c) => c.trackId === base?.id && isVisual(p, c));
  }
  return list.sort((a, b) => a.start - b.start);
}

/** Betonte Zeitpunkte: Marker, sonst Höhepunkte (bzw. Takt-Einsen) der Musik auf der Timeline. */
export function accentTimes(p: Project): number[] {
  if (p.markers?.length) return p.markers.map((m) => m.t);
  const out: number[] = [];
  for (const c of Object.values(p.clips)) {
    const info = p.media[c.mediaId]?.beats;
    if (!info) continue;
    const hits = info.hits?.length ? info.hits : info.downbeats;
    out.push(...beatsOnTimeline({ ...info, beats: hits }, c, 'beats'));
  }
  return out.sort((a, b) => a - b);
}

/** Tempo-Rampe in jeden Clip – die Zeitlupe sitzt auf dem ersten Höhepunkt/Marker im Clip (sonst in der Mitte). */
export function rampOnAccents(ramp: SpeedRamp, strength: number): number {
  const p = useProject.getState().project;
  const clips = targetClips();
  const acc = accentTimes(p);
  if (!clips.length) { useUi.getState().toast(t.carporn.needClips, 'error'); return 0; }
  beginTransaction();
  try {
    for (const c of clips) {
      const D = clipDuration(c);
      if (D < 0.6) continue;
      const hit = acc.find((x) => x > c.start + 0.15 * D && x < clipEnd(c) - 0.1 * D);
      const center = hit !== undefined ? (hit - c.start) / D : 0.5;
      const pieces = speedRampPieces(c, ramp, strength, 20, center);
      useProject.getState().removeClips([c.id]);
      useProject.getState().insertClips(pieces);
    }
  } finally { endTransaction(); }
  setDirty(true);
  return clips.length;
}

/** Rig-Shot-Look: starke Bewegungsunschärfe (Hintergrund verwischt, das mitfahrende Auto bleibt scharf) + leichtes Vibrieren. */
export function rigLook(strength: number): number {
  const clips = targetClips();
  if (!clips.length) { useUi.getState().toast(t.carporn.needClips, 'error'); return 0; }
  beginTransaction();
  for (const c of clips) {
    const fx = { ...NEUTRAL_FX, ...(c.fx ?? {}), motionBlur: Math.min(1, 0.55 + 0.3 * strength) };
    const motion = c.motion && c.motion.keyframes.length
      ? { ...c.motion, osc: { kind: 'shake' as const, amp: 0.12 * strength } }
      : { preset: 'custom' as const, intensity: 1, smooth: true, keyframes: [{ t: 0, x: 0, y: 0, scale: 1.04, rotation: 0, opacity: 1 }], osc: { kind: 'shake' as const, amp: 0.12 * strength } };
    useProject.getState().updateClip(c.id, { fx, motion });
  }
  endTransaction();
  setDirty(true);
  return clips.length;
}

/** Kamera-Stoß auf jeden Höhepunkt/Marker (im Clip, der dann im Bild ist). */
export function shakesOnAccents(strength: number): number {
  const p = useProject.getState().project;
  const acc = accentTimes(p);
  if (!acc.length) { useUi.getState().toast(t.carporn.needAccents, 'error'); return 0; }
  const order = new Map(p.tracks.map((x, i) => [x.id, i]));
  let n = 0;
  beginTransaction();
  for (const at of acc) {
    const cur = useProject.getState().project;
    // vorderster sichtbarer Video-Clip zu diesem Zeitpunkt
    const c = Object.values(cur.clips).filter((x) => isVisual(cur, x) && at >= x.start && at < clipEnd(x))
      .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))[0];
    if (!c || (c.motion && c.motion.preset !== 'custom')) continue;
    const local = at - c.start;
    const keep = (c.motion?.keyframes ?? []).filter((k) => k.t < local - 0.05 || k.t > local + 0.8);
    const kfs = [...keep, ...shakeKeyframes(local, strength, clipDuration(c))].sort((a, b) => a.t - b.t);
    useProject.getState().updateClip(c.id, { motion: { ...(c.motion ?? { preset: 'custom', intensity: 1, smooth: true, keyframes: [] }), preset: 'custom', keyframes: kfs } });
    n++;
  }
  endTransaction();
  setDirty(true);
  return n;
}

/** Wisch-Schwenks zwischen allen aufeinanderfolgenden Clips (abwechselnd links/rechts). */
export function whipBetween(): number {
  const clips = targetClips();
  let n = 0;
  beginTransaction();
  clips.forEach((c, i) => {
    if (i === 0) return;
    const prev = clips[i - 1];
    if (prev.trackId !== c.trackId || Math.abs(clipEnd(prev) - c.start) > 0.05) return;
    const type: TransitionType = i % 2 ? 'whipleft' : 'whipright';
    if (applyTransitionToClip(c.id, type)) n++;
  });
  endTransaction();
  setDirty(true);
  return n;
}

/** Look auf alle Ziel-Clips, optional Kino-Balken. */
export function applyLook(look: string, letterbox: number | null): number {
  const clips = targetClips();
  beginTransaction();
  for (const c of clips) useProject.getState().updateClip(c.id, { color: { ...c.color, look, lookStrength: 1 } });
  if (letterbox !== null) useProject.getState().updateSettings({ letterbox });
  endTransaction();
  setDirty(true);
  return clips.length;
}

/** Freigestelltes Auto als eigene Ebene nach vorne + Text dahinter. */
export function textBehindCar(text: string): boolean {
  const p = useProject.getState().project;
  const sel = useUi.getState().selection.map((id) => p.clips[id]).find((c) => c?.objects?.some((o) => o.masks?.length));
  const obj = sel?.objects?.find((o) => o.masks?.length);
  if (!sel || !obj) { useUi.getState().toast(t.carporn.needMask, 'error'); return false; }
  bringObjectToFront(sel.id, obj.id);
  beginTransaction();
  const track = useProject.getState().addVideoTrackAbove(sel.trackId, t.carporn.textTrack);
  const title = { ...defaultTitle(text), size: 18, font: 'impact', y: 45, animation: 'fade' as const };
  const tc = useProject.getState().addTitleClip(track, sel.start, title);
  if (tc) useProject.getState().updateClip(tc.id, { out: tc.in + clipDuration(sel) });
  endTransaction();
  setDirty(true);
  return true;
}

/** Fertiger Clip-Zusammenschnitt: Beat-Schnitt auf Höhepunkte (beste Stellen) + Rampen + Stöße + Look. */
export async function carReel(): Promise<void> {
  const p = useProject.getState().project;
  const sel = useUi.getState().selection.map((id) => p.clips[id]).filter(Boolean) as Clip[];
  const music = sel.find((c) => p.media[c.mediaId]?.type === 'audio') ?? Object.values(p.clips).find((c) => p.media[c.mediaId]?.type === 'audio');
  if (!music) { useUi.getState().toast(t.carporn.needMusic, 'error'); return; }
  if (!p.media[music.mediaId]?.beats) await detectBeats(music.mediaId);
  if (!useProject.getState().project.media[music.mediaId]?.beats?.beats.length) return;
  await autoCutToMusic(music.id, { ...DEFAULT_BEAT_CUT, mode: 'hits', best: true, accent: 'shake', accentOn: 'hits', strength: 1 });
  const n = applyLook('carshow', 2.39);
  useUi.getState().toast(fmt(t.carporn.reelDone, { n }), 'success');
}
