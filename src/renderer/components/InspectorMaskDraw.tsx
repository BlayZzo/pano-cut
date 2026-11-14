// 🎭 Freistellen & Masken: EINE Liste aller Masken des Clips (selbst gezeichnet oder per KI erkannt) –
// Bearbeiten im Masken-Editor (MaskEditor.tsx), Freistellen an/aus, Kante, nach vorne, in die Mediathek.
import React, { useState } from 'react';
import type { Clip, MediaItem } from '@shared/types';
import { untracked, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Fold, Section, Slider, Toggle } from './InspectorBits';
import { bringObjectToFront } from '../vfx/actions';
import { InspectorClickCutout } from './InspectorCutout';

export function InspectorMasks({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const tracks = clip.objects ?? [];
  const cut = clip.cutout;
  const [busy, setBusy] = useState<string | null>(null);
  const open = (trackId?: string) => { useUi.getState().select([clip.id]); useUi.getState().setMaskEditor({ clipId: clip.id, trackId }); };
  const setCutout = useProject((s) => s.setCutout);
  const copyToLibrary = async (trackId: string) => {
    const tr = tracks.find((x) => x.id === trackId);
    if (!tr?.masks?.length) { useUi.getState().toast(t.ai.noMasks, 'error'); return; }
    setBusy(trackId);
    try {
      const project = useProject.getState().project;
      const item = await window.panocut.renderObject({ project, clipId: clip.id, trackId, name: `${tr.labelDe} (${media.name})` });
      untracked(() => useProject.getState().addMedia([item]));
      useUi.getState().toast(t.ai.copied, 'success');
      useUi.getState().setLibraryTab('objects');
    } catch (err) {
      useUi.getState().toast((err as Error).message, 'error');
    } finally { setBusy(null); }
  };
  const active = tracks.find((tr) => cut?.trackId === tr.id);

  return (
    <Section title={`🎭 ${t.mask.sectionAll}`} defaultOpen badge={tracks.length ? String(tracks.length) : undefined}>
      <button className="btn primary" style={{ width: '100%' }} onClick={() => open(undefined)}>✏️ {t.mask.drawNew}</button>
      <div className="hint">{t.maskEd.openHint}</div>
      {media.type === 'video' && <Fold title={`🖱 ${t.cutout.section}`}><InspectorClickCutout clip={clip} media={media} bare /></Fold>}
      {tracks.map((tr) => {
        const on = cut?.trackId === tr.id && cut.enabled;
        const range = tr.masks && tr.masks.length > 1 ? `${tr.masks[0].t.toFixed(1)}–${tr.masks[tr.masks.length - 1].t.toFixed(1)} s` : '';
        return (
          <div key={tr.id} className="music-auto">
            <div className="field-row">
              <span className="swatch" style={{ background: tr.color }} />
              <input type="text" value={tr.labelDe} onChange={(e) => useProject.getState().updateObjectTrack(clip.id, tr.id, { labelDe: e.target.value })} style={{ height: 26, flex: 1, minWidth: 0 }} />
              <span className="hint">{fmt(t.mask.info, { n: tr.masks?.length ?? 0, r: range })}</span>
            </div>
            <Toggle label={t.mask.enabled} checked={on} disabled={!tr.masks?.length}
              onChange={(v) => setCutout(clip.id, v ? { enabled: true, trackId: tr.id, feather: cut?.feather ?? 2, grow: cut?.grow ?? 0, invert: cut?.invert ?? false } : undefined)} />
            <div className="field-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => open(tr.id)}>✏️ {t.mask.edit}</button>
              <button className="btn sm" disabled={!tr.masks?.length || !!clip.link} onClick={() => bringObjectToFront(clip.id, tr.id)} title={t.layers.toFrontHint}>🧅 {t.mask.front}</button>
              <button className="btn sm" disabled={!tr.masks?.length || busy !== null} onClick={() => void copyToLibrary(tr.id)} title={t.ai.copyToLibrary}>{busy === tr.id ? <span className="spinner" /> : '📦'} {t.mask.toLibrary}</button>
              <button className="btn sm ghost danger" title={t.common.delete} onClick={() => { useProject.getState().removeObjectTrack(clip.id, tr.id); if (cut?.trackId === tr.id) setCutout(clip.id, undefined); }}>🗑</button>
            </div>
            {!tr.masks?.length && <div className="hint warn">{t.ai.noMasks}</div>}
          </div>
        );
      })}
      {active && cut && (
        <Fold title={t.mask.edgeTitle} defaultOpen>
          <Toggle label={`🔄 ${t.mask.invert}`} checked={cut.invert} onChange={(v) => setCutout(clip.id, { ...cut, invert: v })} />
          <Slider label={t.mask.feather} value={cut.feather} min={0} max={40} step={1} unit=" px" onChange={(v) => setCutout(clip.id, { ...cut, feather: v })} />
          <Slider label={t.maskEd.grow} value={cut.grow} min={-20} max={20} step={1} unit=" px" onChange={(v) => setCutout(clip.id, { ...cut, grow: v })} />
        </Fold>
      )}
    </Section>
  );
}
