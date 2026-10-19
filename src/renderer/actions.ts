// Zentrale Aktionen – von Menü, Tastenkürzeln und Buttons gemeinsam genutzt.
import type { Clip, MediaItem, Project, TransitionType, UserEffect } from '@shared/types';
import { clipDuration, clipEnd, clipsOnTrack, makeId, projectDuration } from '@shared/timeline';
import { autoEnhance, frameStats, type FrameStats } from '@shared/color';
import { EFFECT_BLOCKS, applyUserEffect, userEffectFromClip } from '@shared/effects';
import { TITLE_TEMPLATES, defaultTitle, defaultTransition } from '@shared/pano';
import { isDynamicTransition } from '@shared/transitions';
import { modelFormat } from '@shared/model3d';
import { beginTransaction, clearHistory, endTransaction, isDirty, redo, setDirty, undo, untracked, useProject } from './store/project';
import { useUi } from './store/ui';
import { engine, seekTo, stopPlayback } from './engine/instance';
import { fmt, t } from './i18n/de';

const api = () => window.panocut;

// ---------- Medien ----------

export async function importFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  // Blackmagic RAW braucht Blackmagics eigene Software – freundlich erklären statt nur „nicht unterstützt“
  if (paths.some((p) => /\.braw$/i.test(p))) {
    useUi.getState().toast(t.toast.braw, 'error');
    paths = paths.filter((p) => !/\.braw$/i.test(p));
    if (paths.length === 0) return;
  }
  // 3D-Modelle öffnen das 3D-Fenster (sie werden dort mit Licht und Schatten zu einer Ebene gerendert)
  const models = paths.filter((p) => modelFormat(p));
  if (models.length) {
    useUi.getState().setModelPanel({ file: models[0] });
    paths = paths.filter((p) => !modelFormat(p));
    if (paths.length === 0) return;
  }
  const items = await api().importMedia(paths);
  const skipped = paths.length - items.length;
  if (items.length) {
    untracked(() => useProject.getState().addMedia(items));
    setDirty(true);
    useUi.getState().toast(fmt(t.toast.imported, { n: items.length }), 'success');
    for (const item of items) {
      if (item.status !== 'error') void api().prepareMedia(item);
    }
  }
  if (skipped > 0) useUi.getState().toast(fmt(t.toast.unsupported, { n: skipped }), 'error');
}

export async function importDialog(): Promise<void> {
  const paths = await api().selectMediaFiles();
  await importFiles(paths);
}

export function ensureMediaPrepared(project: Project): void {
  for (const m of Object.values(project.media)) {
    if (m.status === 'processing' || m.status === 'analyzing') void api().prepareMedia(m);
  }
}

export function addMediaToTimeline(media: MediaItem, at?: number): void {
  const store = useProject.getState();
  const project = store.project;
  const kind = media.type === 'audio' ? 'audio' : 'video';
  const tracks = project.tracks.filter((tr) => tr.kind === kind && !tr.locked);
  // Unterste Videospur bzw. erste Audiospur bevorzugen
  const track = kind === 'video' ? tracks[tracks.length - 1] : tracks[0];
  if (!track) return;
  let start = at ?? useUi.getState().playhead;
  if (at === undefined) {
    // Ans Ende der Spur anhängen, wenn der Abspielkopf mitten in einem Clip steht
    const onTrack = clipsOnTrack(project, track.id);
    const last = onTrack[onTrack.length - 1];
    if (last && start < clipEnd(last)) start = clipEnd(last);
  }
  const clip = store.addClip(media.id, track.id, start);
  if (clip) useUi.getState().select([clip.id]);
}

/** Titel-Vorlage als neuen Clip auf die oberste freie Videospur legen. */
export function addTitleToTimeline(templateId: string, at?: number, trackId?: string): void {
  const store = useProject.getState();
  const project = store.project;
  const tpl = TITLE_TEMPLATES.find((x) => x.id === templateId) ?? TITLE_TEMPLATES[0];
  const videoTracks = project.tracks.filter((tr) => tr.kind === 'video' && !tr.locked);
  const track = trackId ? project.tracks.find((tr) => tr.id === trackId) : videoTracks[0];
  if (!track) return;
  const title = { ...defaultTitle(), ...tpl.style };
  const clip = store.addTitleClip(track.id, at ?? useUi.getState().playhead, title);
  if (clip) useUi.getState().select([clip.id]);
}

/** Übergang auf einen Clip anwenden (Übergang vom vorherigen Clip in diesen). */
export function applyTransitionToClip(clipId: string, type: TransitionType): boolean {
  const store = useProject.getState();
  const clip = store.project.clips[clipId];
  if (!clip) return false;
  const prev = clipsOnTrack(store.project, clip.trackId).find((c) => c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < 1 / 30);
  if (!prev) {
    useUi.getState().toast(t.transition.needsNeighbor, 'error');
    return false;
  }
  // Dynamische Übergänge bringen ihre eigene (kürzere) Dauer und Stärke mit
  const def = defaultTransition(type);
  const old = clip.transition;
  const sameKind = old && isDynamicTransition(old.type) === isDynamicTransition(type);
  store.setTransition(clipId, { ...def, duration: sameKind ? old!.duration : def.duration, intensity: old?.intensity ?? def.intensity });
  useUi.getState().select([clipId]);
  return true;
}

// ---------- Projekt ----------

export async function saveProject(saveAs = false): Promise<boolean> {
  const { project, path, setPath } = useProject.getState();
  const target = await api().saveProject(project, saveAs ? undefined : path ?? undefined);
  if (!target) return false;
  setPath(target);
  setDirty(false);
  useUi.getState().toast(t.toast.saved, 'success');
  return true;
}

export async function openProject(): Promise<void> {
  if (isDirty()) {
    const ok = await api().newProjectDialog();
    if (!ok) return;
  }
  const file = await api().openProject();
  if (file) applyLoadedProject(file.project, file.path);
}

export async function loadProjectPath(p: string): Promise<void> {
  if (isDirty()) {
    const ok = await api().newProjectDialog();
    if (!ok) return;
  }
  const file = await api().loadProject(p);
  if (file) applyLoadedProject(file.project, file.path);
  else useUi.getState().toast(t.toast.loadError, 'error');
}

export function applyLoadedProject(project: Project, path: string | null): void {
  stopPlayback();
  useProject.getState().setProject(project, path);
  clearHistory();
  setDirty(false);
  const ui = useUi.getState();
  ui.clearSelection();
  ui.setPlayhead(0);
  ui.setRange(null, null);
  seekTo(0);
  ensureMediaPrepared(project);
  void api().setSettings({ lastProject: path ?? undefined });
}

export async function newProjectFlow(): Promise<void> {
  if (isDirty()) {
    const ok = await api().newProjectDialog();
    if (!ok) return;
  }
  useUi.getState().openDialog('newProject');
}

export function createNewProject(name: string, width: number, height: number, fps: number, is360 = false): void {
  stopPlayback();
  useProject.getState().newProject(name, width, height, fps);
  if (is360) useProject.getState().updateSettings({ is360: true });
  clearHistory();
  setDirty(false);
  const ui = useUi.getState();
  ui.clearSelection();
  ui.setPlayhead(0);
  ui.setRange(null, null);
  seekTo(0);
}

// ---------- Bearbeiten ----------

export function doUndo(): void {
  stopPlayback();
  undo();
  useUi.getState().bumpHistory();
  pruneSelection();
}

export function doRedo(): void {
  stopPlayback();
  redo();
  useUi.getState().bumpHistory();
  pruneSelection();
}

function pruneSelection(): void {
  const clips = useProject.getState().project.clips;
  const ui = useUi.getState();
  const next = ui.selection.filter((id) => clips[id]);
  if (next.length !== ui.selection.length) ui.select(next);
}

export function splitAtPlayhead(): void {
  const ui = useUi.getState();
  const store = useProject.getState();
  const t0 = ui.playhead;
  const project = store.project;
  let targets = ui.selection.filter((id) => project.clips[id]);
  if (targets.length === 0) {
    targets = Object.values(project.clips)
      .filter((c) => {
        const track = project.tracks.find((tr) => tr.id === c.trackId);
        return !track?.locked && t0 > c.start && t0 < clipEnd(c);
      })
      .map((c) => c.id);
  }
  const created: string[] = [];
  for (const id of targets) {
    const r = store.splitClipAt(id, t0);
    if (r) created.push(r);
  }
  if (created.length) ui.select(created);
}

export function deleteSelection(): void {
  const ui = useUi.getState();
  if (ui.selection.length === 0) return;
  useProject.getState().removeClips(ui.selection);
  ui.clearSelection();
}

export function duplicateSelection(): void {
  const ui = useUi.getState();
  if (ui.selection.length === 0) return;
  const ids = useProject.getState().duplicateClips(ui.selection);
  if (ids.length) ui.select(ids);
}

export function selectAll(): void {
  useUi.getState().select(Object.keys(useProject.getState().project.clips));
}

export function stepFrames(n: number): void {
  stopPlayback();
  const fps = useProject.getState().project.settings.fps || 30;
  const dur = projectDuration(useProject.getState().project);
  const next = Math.min(dur, Math.max(0, useUi.getState().playhead + n / fps));
  seekTo(next);
}

export function goStart(): void { stopPlayback(); seekTo(0); }
export function goEnd(): void { stopPlayback(); seekTo(projectDuration(useProject.getState().project)); }

export function setRangeIn(): void {
  const ui = useUi.getState();
  const inT = ui.playhead;
  const outT = ui.rangeOut !== null && ui.rangeOut > inT ? ui.rangeOut : null;
  ui.setRange(inT, outT);
}
export function setRangeOut(): void {
  const ui = useUi.getState();
  const outT = ui.playhead;
  const inT = ui.rangeIn !== null && ui.rangeIn < outT ? ui.rangeIn : 0;
  ui.setRange(inT, outT);
}
export function clearRange(): void { useUi.getState().setRange(null, null); }

// ---------- Zoom ----------

export function zoomBy(factor: number): void {
  const ui = useUi.getState();
  ui.setZoom(ui.zoom * factor);
}

export function zoomToFit(availableWidth: number): void {
  const dur = projectDuration(useProject.getState().project);
  if (dur <= 0 || availableWidth <= 0) return;
  useUi.getState().setZoom((availableWidth - 40) / dur);
  useUi.getState().setScrollX(0);
}

// ---------- Effekte & Bildverbesserung ----------

function selectedMediaClips(ids?: string[]): Clip[] {
  const { project } = useProject.getState();
  return (ids ?? useUi.getState().selection).map((id) => project.clips[id]).filter((c): c is Clip => !!c && c.kind !== 'title' && project.media[c.mediaId]?.type !== 'audio');
}

let enhancing = false;
/** „Natürlich schön“: analysiert ein paar Bilder des Clips und stellt Belichtung, Weißabgleich, Kontrast und Dynamik ein. */
export async function autoEnhanceClips(ids?: string[]): Promise<void> {
  const clips = selectedMediaClips(ids);
  const ui = useUi.getState();
  if (clips.length === 0) { ui.toast(t.look.autoNoClip, 'error'); return; }
  if (enhancing) return;
  enhancing = true;
  ui.toast(t.look.autoWorking, 'info');
  beginTransaction();
  try {
    for (const clip of clips) {
      const media = useProject.getState().project.media[clip.mediaId];
      if (!media) continue;
      const dur = clipDuration(clip);
      const times = media.type === 'image' ? [0] : [0.12, 0.5, 0.88].map((f) => f * dur);
      const stats: FrameStats[] = [];
      for (const lt of times) {
        const img = await engine.grabFrame(clip, media, lt, 320);
        if (img) stats.push(frameStats(img.data));
      }
      if (stats.length === 0) continue;
      const current = useProject.getState().project.clips[clip.id];
      if (current) useProject.getState().updateClip(clip.id, { color: { ...current.color, ...autoEnhance(stats) } });
    }
    useUi.getState().toast(t.look.autoDone, 'success');
  } catch (err) {
    useUi.getState().toast((err as Error).message, 'error');
  } finally {
    endTransaction();
    enhancing = false;
  }
}

/** Effekt-Baustein (oder eigenen Effekt) auf Clips anwenden. */
export function applyEffectToClips(effectId: string, ids?: string[]): boolean {
  const clips = selectedMediaClips(ids);
  if (clips.length === 0) { useUi.getState().toast(t.effects.needClip, 'error'); return false; }
  const block = EFFECT_BLOCKS.find((b) => b.id === effectId);
  const user = useUi.getState().settings.userEffects?.find((u) => u.id === effectId);
  if (!block && !user) return false;
  beginTransaction();
  for (const c of clips) {
    const patch = block ? block.apply(c, clipDuration(c)) : applyUserEffect(c, user as UserEffect, clipDuration(c));
    useProject.getState().updateClip(c.id, patch);
  }
  endTransaction();
  useUi.getState().toast(`${block?.name ?? user?.name}: ${t.effects.applied}`, 'success');
  return true;
}

/** Aktuelle Einstellungen eines Clips als eigenen Effekt speichern. */
export async function saveClipAsEffect(clip: Clip, name: string): Promise<void> {
  const ue = userEffectFromClip(clip, name.trim() || t.effects.ownDefaultName, clipDuration(clip), makeId('fx'));
  const current = useUi.getState().settings.userEffects ?? [];
  const next = await api().setSettings({ userEffects: [...current, ue] });
  useUi.getState().setSettings(next);
  useUi.getState().toast(t.effects.saved, 'success');
}

export async function deleteUserEffect(id: string): Promise<void> {
  const current = useUi.getState().settings.userEffects ?? [];
  const next = await api().setSettings({ userEffects: current.filter((u) => u.id !== id) });
  useUi.getState().setSettings(next);
}

export function toggleLoop(): void {
  const ui = useUi.getState();
  ui.setLoop(!ui.loop);
}

export function toggleAiPanel(): void {
  const ui = useUi.getState();
  ui.setAiPanel(!ui.aiPanel);
}

export { engine };
