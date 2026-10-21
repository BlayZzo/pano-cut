// Lichter markieren und über den Clip verfolgen (für Leuchtspuren nur an diesen Lichtern).
import type { Clip, LightTrack } from '@shared/types';
import { trackLights } from '@shared/lights';
import { clipDuration, makeId, sourceTimeAt } from '@shared/timeline';
import { NEUTRAL_FX } from '@shared/effects';
import { beginTransaction, endTransaction, setDirty, useProject } from './store/project';
import { useUi } from './store/ui';
import { engine } from './engine/instance';
import { fmt, t } from './i18n/de';

const RATE = 10;          // Verfolgen mit 10 Bildern pro Sekunde
const MAX_FRAMES = 900;   // höchstens 90 s am Stück

// Bilder eines Clips merken (mehrere Lichter nacheinander markieren, ohne neu zu laden)
let cache: { key: string; frames: Array<{ t: number; img: ImageData }> } | null = null;

async function clipFrames(clip: Clip, onProgress: (p: number) => void): Promise<Array<{ t: number; img: ImageData }>> {
  const media = useProject.getState().project.media[clip.mediaId];
  if (!media) return [];
  const dur = clipDuration(clip);
  const key = `${clip.id}|${clip.in}|${clip.out}|${clip.speed}|${media.proxy ?? media.path}`;
  if (cache?.key === key) return cache.frames;
  const n = Math.min(MAX_FRAMES, Math.max(2, Math.ceil(dur * RATE)));
  const frames: Array<{ t: number; img: ImageData }> = [];
  for (let k = 0; k < n; k++) {
    const local = Math.min(dur, (k / (n - 1)) * dur);
    const img = await engine.grabFrame(clip, media, local, 480);
    if (img) frames.push({ t: sourceTimeAt(clip, clip.start + local), img });
    if (k % 5 === 0) onProgress(Math.round((100 * k) / n));
  }
  frames.sort((a, b) => a.t - b.t);
  cache = { key, frames };
  return frames;
}

/** Licht an Quellposition (u, v) zur aktuellen Zeit markieren, verfolgen und speichern. */
export async function addTrackedLight(clipId: string, u: number, v: number, r: number): Promise<void> {
  const clip = useProject.getState().project.clips[clipId];
  if (!clip) return;
  const ui = useUi.getState();
  const local = Math.max(0, Math.min(clipDuration(clip), ui.playhead - clip.start));
  const srcT = sourceTimeAt(clip, clip.start + local);
  ui.toast(t.lights.tracking, 'info');
  let lastToast = 0;
  const frames = await clipFrames(clip, (p) => { if (p - lastToast >= 25) { lastToast = p; useUi.getState().toast(fmt(t.lights.trackingPct, { p }), 'info'); } });
  if (!frames.length) { useUi.getState().toast(t.lights.failed, 'error'); return; }
  // nächstes gemessenes Bild zur aktuellen Zeit
  let start = 0;
  for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i].t - srcT) < Math.abs(frames[start].t - srcT)) start = i;
  const [track] = trackLights([{ id: makeId('light'), x: u, y: v, r }], frames, start);
  const cur = useProject.getState().project.clips[clipId];
  if (!cur) return;
  const fx = { ...NEUTRAL_FX, ...(cur.fx ?? {}) };
  beginTransaction();
  useProject.getState().updateClip(clipId, { fx: { ...fx, lights: [...(fx.lights ?? []), track], trailsMode: 'marked', trails: Math.max(fx.trails ?? 0, 0.7) } });
  endTransaction();
  setDirty(true);
  const covered = track.keys.length > 1 ? track.keys[track.keys.length - 1].t - track.keys[0].t : 0;
  useUi.getState().toast(fmt(t.lights.added, { s: covered.toFixed(1) }), 'success');
}

export function removeLight(clipId: string, id: string): void {
  const cur = useProject.getState().project.clips[clipId];
  if (!cur?.fx) return;
  const lights: LightTrack[] = (cur.fx.lights ?? []).filter((l) => l.id !== id);
  useProject.getState().updateClip(clipId, { fx: { ...cur.fx, lights } });
  setDirty(true);
}
