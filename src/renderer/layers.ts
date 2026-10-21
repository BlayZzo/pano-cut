// Ebenen: Reihenfolge vorne/hinten = Reihenfolge der Videospuren (oberste Spur = ganz vorne).
import type { Clip, Project } from '@shared/types';
import { clipEnd } from '@shared/timeline';
import { beginTransaction, endTransaction, setDirty, useProject } from './store/project';
import { useUi } from './store/ui';
import { t } from './i18n/de';

const overlapsClip = (a: Clip, b: Clip) => a.start < clipEnd(b) - 1e-6 && clipEnd(a) > b.start + 1e-6;

function trackFree(project: Project, trackId: string, clip: Clip): boolean {
  const tr = project.tracks.find((x) => x.id === trackId);
  if (!tr || tr.locked) return false;
  return !Object.values(project.clips).some((c) => c.trackId === trackId && c.id !== clip.id && overlapsClip(c, clip));
}

/** Clip eine Ebene nach vorne (−1) oder hinten (+1) – an dem Clip vorbei, der ihn gerade verdeckt bzw. den er verdeckt. */
export function moveLayer(clipId: string, dir: -1 | 1): void {
  const project = useProject.getState().project;
  const clip = project.clips[clipId];
  if (!clip) return;
  const vids = project.tracks.filter((x) => x.kind === 'video');
  const i = vids.findIndex((x) => x.id === clip.trackId);
  if (i < 0) return;
  // nächste Spur in dieser Richtung mit einem Clip, der sich zeitlich überschneidet
  let k = i + dir;
  while (k >= 0 && k < vids.length && !Object.values(project.clips).some((c) => c.trackId === vids[k].id && overlapsClip(c, clip))) k += dir;
  if (k < 0 || k >= vids.length) { useUi.getState().toast(dir < 0 ? t.layerPanel.alreadyFront : t.layerPanel.alreadyBack, 'info'); return; }
  beginTransaction();
  try {
    const beyond = k + dir;
    let target: string;
    if (beyond >= 0 && beyond < vids.length && trackFree(project, vids[beyond].id, clip)) target = vids[beyond].id;
    else if (dir < 0) target = useProject.getState().addVideoTrackAbove(vids[k].id);
    else target = useProject.getState().addVideoTrackBelow(vids[k].id);
    useProject.getState().updateClip(clip.id, { trackId: target });
  } finally { endTransaction(); }
  setDirty(true);
}

/** Alle sichtbaren Ebenen zur Zeit `time`, vorne zuerst. */
export function layersAt(project: Project, time: number): Clip[] {
  const order = new Map(project.tracks.map((x, i) => [x.id, i]));
  return Object.values(project.clips)
    .filter((c) => {
      const tr = project.tracks.find((x) => x.id === c.trackId);
      if (!tr || tr.kind !== 'video') return false;
      return time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;
    })
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
}
