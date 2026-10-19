import React, { useState } from 'react';
import type { Attachment, Clip, MediaItem } from '@shared/types';
import { clipEnd } from '@shared/timeline';
import { untracked, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';
import { Section, SelectField, Slider, Toggle } from './InspectorBits';
import { bringObjectToFront } from '../vfx/actions';

/** Verfolgte Objekte, Freistellen, Kopieren in die Objekt-Mediathek. */
export function InspectorObjects({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement | null {
  const setCutout = useProject((s) => s.setCutout);
  const removeObjectTrack = useProject((s) => s.removeObjectTrack);
  const updateObjectTrack = useProject((s) => s.updateObjectTrack);
  const addMedia = useProject((s) => s.addMedia);
  const toast = useUi((s) => s.toast);
  const setAiPanel = useUi((s) => s.setAiPanel);
  const setLibraryTab = useUi((s) => s.setLibraryTab);
  const maskBrush = useUi((s) => s.maskBrush);
  const setMaskBrush = useUi((s) => s.setMaskBrush);
  const [busy, setBusy] = useState(false);
  const objects = clip.objects ?? [];
  const cut = clip.cutout;

  const copyToLibrary = async (trackId: string) => {
    const tr = objects.find((x) => x.id === trackId);
    if (!tr?.masks?.length) { toast(t.ai.noMasks, 'error'); return; }
    setBusy(true);
    try {
      const project = useProject.getState().project;
      const item = await window.panocut.renderObject({ project, clipId: clip.id, trackId, name: `${tr.labelDe} (${media.name})` });
      untracked(() => addMedia([item]));
      toast(t.ai.copied, 'success');
      setLibraryTab('objects');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t.ai.sectionObjects} defaultOpen={objects.length > 0} badge={objects.length ? String(objects.length) : undefined}>
      {objects.length === 0 && <div className="hint">{t.ai.selectClip} <button className="btn sm" onClick={() => setAiPanel(true)}>✦ {t.ai.title}</button></div>}
      {objects.map((tr) => (
        <div key={tr.id} className="result-box" style={{ gap: 6 }}>
          <div className="ai-row">
            <span className="swatch" style={{ background: tr.color }} />
            <input type="text" value={tr.labelDe} onChange={(e) => updateObjectTrack(clip.id, tr.id, { labelDe: e.target.value })} style={{ height: 26, flex: 1 }} />
            <button className="btn sm ghost" title={t.ai.removeTrack} onClick={() => removeObjectTrack(clip.id, tr.id)}>×</button>
          </div>
          <div className="hint">{tr.boxes.length} Positionen · {tr.masks?.length ?? 0} Masken</div>
          <Toggle label={t.ai.cutoutEnable} checked={!!cut?.enabled && cut.trackId === tr.id} disabled={!tr.masks?.length}
            onChange={(v) => setCutout(clip.id, v ? { enabled: true, trackId: tr.id, feather: cut?.feather ?? 2, grow: cut?.grow ?? 0, invert: cut?.invert ?? false } : undefined)} />
          {!tr.masks?.length && <div className="hint warn">{t.ai.noMasks}</div>}
          <button className="btn sm" onClick={() => void copyToLibrary(tr.id)} disabled={busy || !tr.masks?.length}>{busy ? <span className="spinner" /> : null} {t.ai.copyToLibrary}</button>
          {!clip.link && (
            <>
              <button className="btn sm" onClick={() => bringObjectToFront(clip.id, tr.id)} disabled={!tr.masks?.length} title={t.layers.toFrontHint}>⬆ {t.layers.toFront}</button>
              <div className="hint">{t.layers.toFrontHint}</div>
            </>
          )}
          <button className={`btn sm${maskBrush?.trackId === tr.id ? ' active' : ''}`} disabled={!tr.masks?.length}
            onClick={() => setMaskBrush(maskBrush?.trackId === tr.id ? null : { clipId: clip.id, trackId: tr.id, size: 4, all: true })}>🖌 {t.layers.brush}</button>
          {maskBrush?.trackId === tr.id && (
            <>
              <Slider label={t.layers.brushSize} value={maskBrush.size} min={0.5} max={30} step={0.5} unit=" %" onChange={(v) => setMaskBrush({ ...maskBrush, size: v })} />
              <SelectField label={t.layers.brushScope} value={maskBrush.all ? 'all' : 'here'} onChange={(v) => setMaskBrush({ ...maskBrush, all: v === 'all' })}
                options={[{ value: 'all', label: t.layers.brushAll }, { value: 'here', label: t.layers.brushHere }]} />
              <div className="hint">{t.layers.brushOn}</div>
            </>
          )}
        </div>
      ))}
      {cut?.enabled && (
        <>
          <Toggle label={t.ai.cutoutInvert} checked={cut.invert} onChange={(v) => setCutout(clip.id, { ...cut, invert: v })} />
          <Slider label={t.ai.feather} value={cut.feather} min={0} max={40} step={1} unit=" px" onChange={(v) => setCutout(clip.id, { ...cut, feather: v })} />
          <Slider label={t.ai.grow} value={cut.grow} min={-10} max={10} step={1} unit=" px" onChange={(v) => setCutout(clip.id, { ...cut, grow: v })} />
        </>
      )}
    </Section>
  );
}

export function InspectorChroma({ clip }: { clip: Clip }): React.ReactElement {
  const setChroma = useProject((s) => s.setChroma);
  const setPickColor = useUi((s) => s.setPickColor);
  const pickColor = useUi((s) => s.pickColor);
  const ch = clip.chroma ?? { enabled: false, color: '#00ff00', similarity: 0.3, blend: 0.1, despill: true };
  return (
    <Section title={t.ai.chroma} defaultOpen={ch.enabled} badge={ch.enabled ? 'an' : undefined}>
      <Toggle label={t.ai.chromaEnable} checked={ch.enabled} onChange={(v) => setChroma(clip.id, { ...ch, enabled: v })} />
      {ch.enabled && (
        <>
          <div className="field">
            <label>{t.ai.chromaColor}</label>
            <div className="field-row">
              <input type="color" value={ch.color} onChange={(e) => setChroma(clip.id, { ...ch, color: e.target.value })} />
              <button className={`btn sm${pickColor ? ' active' : ''}`} onClick={() => setPickColor(!pickColor)}>{t.ai.pick}</button>
            </div>
          </div>
          <Slider label={t.ai.similarity} value={ch.similarity} min={0.01} max={1} step={0.01} onChange={(v) => setChroma(clip.id, { ...ch, similarity: v })} />
          <Slider label={t.ai.blend} value={ch.blend} min={0} max={1} step={0.01} onChange={(v) => setChroma(clip.id, { ...ch, blend: v })} />
          <Toggle label={t.ai.despill} checked={ch.despill} onChange={(v) => setChroma(clip.id, { ...ch, despill: v })} />
        </>
      )}
    </Section>
  );
}

/** Auswahl „An Objekt heften“ für Titel und Untertitel. */
export function AttachFields({ clip, attach, onChange }: { clip: Clip; attach: Attachment | undefined; onChange: (a: Attachment | undefined) => void }): React.ReactElement | null {
  const project = useProject((s) => s.project);
  // Objekte aller Clips, die sich zeitlich mit diesem Clip überschneiden
  const options: Array<{ value: string; label: string }> = [{ value: '', label: t.ai.attachNone }];
  for (const c of Object.values(project.clips)) {
    if (!c.objects?.length) continue;
    if (clipEnd(c) <= clip.start || c.start >= clipEnd(clip)) continue;
    for (const tr of c.objects) options.push({ value: `${c.id}|${tr.id}`, label: `${tr.labelDe} (${c.name})` });
  }
  if (options.length === 1 && !attach) return null;
  const value = attach ? `${attach.clipId}|${attach.trackId}` : '';
  return (
    <>
      <SelectField label={t.ai.attach} value={value} options={options} onChange={(v) => {
        if (!v) { onChange(undefined); return; }
        const [clipId, trackId] = v.split('|');
        onChange({ clipId, trackId, anchor: attach?.anchor ?? 'above', dx: attach?.dx ?? 0, dy: attach?.dy ?? 0 });
      }} />
      {attach && (
        <>
          <SelectField label={t.ai.anchor} value={attach.anchor} onChange={(v) => onChange({ ...attach, anchor: v as Attachment['anchor'] })}
            options={[{ value: 'above', label: t.ai.anchorAbove }, { value: 'center', label: t.ai.anchorCenter }, { value: 'below', label: t.ai.anchorBelow }]} />
          <Slider label="Versatz X" value={attach.dx} min={-50} max={50} step={0.5} unit=" %" onChange={(v) => onChange({ ...attach, dx: v })} />
          <Slider label="Versatz Y" value={attach.dy} min={-50} max={50} step={0.5} unit=" %" onChange={(v) => onChange({ ...attach, dy: v })} />
        </>
      )}
    </>
  );
}
