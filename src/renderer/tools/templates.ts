// Projekt-Vorlagen: Format, Look, Untertitel-Stil, Export-Vorlage und optional ein Intro speichern und wiederverwenden.
import type { Clip, MediaItem, ProjectDefaults, ProjectTemplate, Track } from '@shared/types';
import { clipEnd, createProject, makeId } from '@shared/timeline';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { applyLoadedProject } from '../actions';
import { SUBTITLE_PRESETS } from '@shared/subtitles';

export interface SaveTemplateOptions {
  name: string;
  look: boolean;          // Farbe + Bild-Effekte des ausgewählten Clips
  subtitles: boolean;     // Untertitel-Stil des ausgewählten Clips
  intro: boolean;         // alle Clips bis zum Abspielkopf
  exportPreset?: string;
}

export async function saveTemplate(o: SaveTemplateOptions): Promise<ProjectTemplate> {
  const p = useProject.getState().project;
  const ui = useUi.getState();
  const sel = ui.selection.map((id) => p.clips[id]).find((c) => c && c.kind !== 'title');
  const defaults: ProjectDefaults = { ...(p.defaults ?? {}) };
  if (o.look && sel) { defaults.color = { ...sel.color, exposureCurve: undefined }; defaults.fx = sel.fx ? { ...sel.fx } : undefined; }
  if (o.subtitles && sel?.subtitles) {
    defaults.subtitleSpoken = sel.subtitles.spoken ?? 'auto';
    defaults.subtitleShow = sel.subtitles.showTranslation ? (sel.subtitles.translationOnly ? 'translation' : 'both') : 'original';
    const style = sel.subtitles.style;
    const match = SUBTITLE_PRESETS.find((x) => x.style.size === style.size && x.style.y === style.y);
    if (match) defaults.subtitlePreset = match.id;
  }
  if (o.exportPreset) defaults.exportPreset = o.exportPreset;
  const tpl: ProjectTemplate = { id: makeId('tpl'), name: o.name.trim() || 'Vorlage', createdAt: Date.now(), settings: { ...p.settings }, defaults };
  if (o.intro && ui.playhead > 0.1) {
    const end = ui.playhead;
    const clips = Object.values(p.clips).filter((c) => c.start < end - 1e-3).map((c) => (clipEnd(c) > end ? { ...c, out: c.in + (end - c.start) * c.speed } : c));
    const media: MediaItem[] = [...new Set(clips.map((c) => c.mediaId))].map((id) => p.media[id]).filter(Boolean).map((m) => ({ ...m, prep: undefined }));
    const tracks: Track[] = p.tracks.filter((tr) => clips.some((c) => c.trackId === tr.id));
    tpl.intro = { clips, media, tracks, duration: end };
  }
  const templates = [...(ui.settings.templates ?? []), tpl];
  const next = await window.panocut.setSettings({ templates });
  ui.setSettings(next);
  return tpl;
}

export async function deleteTemplate(id: string): Promise<void> {
  const ui = useUi.getState();
  const next = await window.panocut.setSettings({ templates: (ui.settings.templates ?? []).filter((x) => x.id !== id) });
  ui.setSettings(next);
}

/** Neues Projekt aus einer Vorlage (Intro-Clips liegen am Anfang). */
export function projectFromTemplate(tpl: ProjectTemplate, name: string): void {
  const p = createProject(name || tpl.name, tpl.settings.width, tpl.settings.height, tpl.settings.fps);
  p.settings = { ...p.settings, ...tpl.settings };
  p.defaults = { ...tpl.defaults };
  if (tpl.intro) {
    // Intro-Spuren den Spuren des neuen Projekts zuordnen (gleiche Art, gleiche Reihenfolge)
    const map = new Map<string, string>();
    for (const kind of ['video', 'audio'] as const) {
      const src = tpl.intro.tracks.filter((t) => t.kind === kind);
      const dst = p.tracks.filter((t) => t.kind === kind);
      src.forEach((t, i) => {
        let target = dst[i];
        if (!target) { target = { ...t, id: makeId('track') }; p.tracks = kind === 'video' ? [target, ...p.tracks] : [...p.tracks, target]; }
        map.set(t.id, target.id);
      });
    }
    for (const m of tpl.intro.media) p.media[m.id] = { ...m, status: m.status === 'ready' ? 'ready' : 'processing' };
    for (const c of tpl.intro.clips) {
      const id = makeId('clip');
      p.clips[id] = { ...c, id, trackId: map.get(c.trackId) ?? c.trackId, link: undefined } as Clip;
    }
  }
  applyLoadedProject(p, null);
}
