// Zentrale Aktionen – von Menü, Tastenkürzeln und Buttons gemeinsam genutzt.
import type { Clip, MediaItem, Project, TransitionType, UserEffect } from '@shared/types';
import { clipDuration, clipEnd, clipsOnTrack, formatTime, makeId, projectDuration } from '@shared/timeline';
import { autoEnhance, frameStats, type FrameStats } from '@shared/color';
import { EFFECT_BLOCKS, applyUserEffect, userEffectFromClip } from '@shared/effects';
import { TITLE_TEMPLATES, defaultPano, defaultTitle, defaultTransition, panoViewAt, upsertKeyframe } from '@shared/pano';
import { reframeAt, upsertReframeKey } from '@shared/reframe';
import { isDynamicTransition } from '@shared/transitions';
import { modelFormat } from '@shared/model3d';
import { beginTransaction, clearHistory, endTransaction, isDirty, redo, setDirty, undo, untracked, useProject } from './store/project';
import { useUi } from './store/ui';
import { engine, seekTo, stopPlayback } from './engine/instance';
import { fmt, t } from './i18n/de';

const api = () => window.panocut;

// ---------- Medien ----------

export async function importFiles(pathsIn: string[]): Promise<void> {
  if (pathsIn.length === 0) return;
  // Ordner durch ihre Medien-Dateien ersetzen; schon importierte Dateien nicht doppelt anlegen
  let paths = await api().expandMediaPaths(pathsIn);
  const known = new Set(Object.values(useProject.getState().project.media).filter((m) => !m.isObject && !m.vfx).map((m) => m.path));
  const already = paths.filter((p) => known.has(p)).length;
  paths = paths.filter((p) => !known.has(p));
  if (already > 0) useUi.getState().toast(fmt(t.toast.alreadyImported, { n: already }), 'info');
  if (paths.length === 0) { if (!already) useUi.getState().toast(t.toast.folderEmpty, 'error'); return; }
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
  const ui0 = useUi.getState();
  ui0.setImporting(ui0.importing + paths.length, [...ui0.importingFiles, ...paths]);
  let items: MediaItem[] = [];
  try { items = await api().importMedia(paths); } finally { const u = useUi.getState(); u.setImporting(u.importing - paths.length, u.importingFiles.filter((f) => !paths.includes(f))); }
  const skipped = paths.length - items.length;
  if (items.length) {
    untracked(() => useProject.getState().addMedia(items));
    setDirty(true);
    const fast = items.filter((m) => m.companion).length;
    useUi.getState().toast(fmt(fast ? t.toast.importedCompanion : t.toast.imported, { n: items.length, k: fast }), 'success');
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

/** Ganzen Ordner importieren (mit Unterordnern, je nach Einstellung). */
export async function importFolderDialog(): Promise<void> {
  const dir = await api().selectFolder(t.library.importFolderTitle);
  if (dir) await importFiles([dir]);
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
  // Vorgaben aus der Projekt-Vorlage (Look, Bild-Effekte) auf neue Bild-/Video-Clips anwenden
  const d = project.defaults;
  if (clip && d && media.type !== 'audio' && (d.color || d.fx)) {
    untracked(() => useProject.getState().updateClip(clip.id, { color: { ...clip.color, ...(d.color ?? {}) }, fx: d.fx ? { ...(clip.fx ?? {}), ...d.fx } as Clip['fx'] : clip.fx }));
  }
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
  const p = useProject.getState();
  const tracks = ui.selection.map((id) => p.project.clips[id]?.trackId).filter(Boolean) as string[];
  if (ui.magnet) beginTransaction();
  p.removeClips(ui.selection);
  if (ui.magnet) { useProject.getState().packTracks(tracks); endTransaction(); }
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

// ---------- Sound-Effekte ----------

/** Freie Tonspur für [t, t+dur] finden – sonst eine neue Spur „Sounds“ anlegen. */
export function freeAudioTrack(t0: number, dur: number): string {
  const store = useProject.getState();
  const p = store.project;
  const free = p.tracks.filter((tr) => tr.kind === 'audio' && !tr.locked)
    .find((tr) => clipsOnTrack(p, tr.id).every((c) => clipEnd(c) <= t0 + 1e-3 || c.start >= t0 + dur - 1e-3));
  return free ? free.id : store.addAudioTrack(t.sfx.trackName);
}

/** Sound berechnen (falls nötig), in die Mediathek legen und am Abspielkopf (oder `at`) einfügen. */
export async function insertSfx(id: string, params: Partial<import('@shared/sfx').SfxParams>, at?: number): Promise<string | null> {
  const file = await api().renderSfx(id, params);
  let media = Object.values(useProject.getState().project.media).find((m) => m.path === file);
  if (!media) {
    const [item] = await api().importMedia([file]);
    if (!item) return null;
    untracked(() => useProject.getState().addMedia([item]));
    void api().prepareMedia(item);
    media = item;
  }
  const start = Math.max(0, at ?? useUi.getState().playhead);
  const trackId = freeAudioTrack(start, media.info.duration || 1);
  const clip = useProject.getState().addClip(media.id, trackId, start);
  return clip?.id ?? null;
}


/** 🎥 Kamerafahrt: aktuelle Blickrichtung (360°) bzw. aktuellen Ausschnitt am Abspielkopf markieren. */
export function markCameraHere(): void {
  const ui = useUi.getState();
  const st = useProject.getState();
  const clip = ui.selection.length === 1 ? st.project.clips[ui.selection[0]] : undefined;
  const media = clip ? st.project.media[clip.mediaId] : undefined;
  if (!clip || !media || (media.type !== 'video' && media.type !== 'image')) { ui.toast(t.moves.selectFirst, 'info'); return; }
  const local = Math.max(0, Math.min(clipDuration(clip), ui.playhead - clip.start));
  if (media.info.is360) {
    const pano = clip.pano ?? defaultPano(st.project.settings.is360 ? 'equirect' : 'flat');
    st.setPano(clip.id, upsertKeyframe(pano, { t: local, ...panoViewAt(pano, local) }));
  } else {
    const cur = clip.reframe ? reframeAt(clip.reframe, local) : { zoom: 1.3, x: 0.5, y: 0.5 };
    st.updateClip(clip.id, { reframe: upsertReframeKey(clip.reframe, { t: local, ...cur }) });
  }
  ui.toast(fmt(t.moves.marked, { t: formatTime(local, st.project.settings.fps) }), 'success');
}
