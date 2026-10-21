// ✏️ Masken: Übersicht der gezeichneten/verfolgten Masken eines Clips – Bearbeiten im Masken-Editor (MaskEditor.tsx).
import React from 'react';
import type { Clip, MediaItem } from '@shared/types';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, Slider, Toggle } from './InspectorBits';
import { bringObjectToFront } from '../vfx/actions';

export function InspectorMaskDraw({ clip }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const tracks = (clip.objects ?? []).filter((o) => o.label === 'manual');
  const cut = clip.cutout;
  const open = (trackId?: string) => { useUi.getState().select([clip.id]); useUi.getState().setMaskEditor({ clipId: clip.id, trackId }); };
  return (
    <Section title={`✏️ ${t.mask.title}`} defaultOpen={tracks.length > 0}>
      <div className="hint">{t.maskEd.openHint}</div>
      <button className="btn primary" style={{ width: '100%' }} onClick={() => open(undefined)}>{t.maskEd.open}</button>
      {tracks.map((tr) => {
        const active = cut?.trackId === tr.id ? cut : undefined;
        const range = tr.masks && tr.masks.length > 1 ? `${tr.masks[0].t.toFixed(1)}–${tr.masks[tr.masks.length - 1].t.toFixed(1)} s` : '';
        return (
          <div key={tr.id} className="music-auto">
            <div className="field-row">
              <strong>🎭 {tr.labelDe}</strong>
              <span className="hint">{fmt(t.mask.info, { n: tr.masks?.length ?? 0, r: range })}</span>
            </div>
            <div className="field-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => open(tr.id)}>✏️ {t.mask.edit}</button>
              <button className="btn sm" onClick={() => bringObjectToFront(clip.id, tr.id)} title={t.layers.toFrontHint}>🧅 {t.mask.front}</button>
              <button className="btn sm ghost danger" onClick={() => { useProject.getState().removeObjectTrack(clip.id, tr.id); if (cut?.trackId === tr.id) useProject.getState().setCutout(clip.id, undefined); }}>🗑</button>
            </div>
            {active ? (
              <>
                <Toggle label={t.mask.enabled} checked={active.enabled} onChange={(v) => useProject.getState().setCutout(clip.id, { ...active, enabled: v })} />
                <Toggle label={`🔄 ${t.mask.invert}`} checked={active.invert} onChange={(v) => useProject.getState().setCutout(clip.id, { ...active, invert: v })} />
                <Slider label={t.mask.feather} value={active.feather} min={0} max={40} step={1} unit=" px" onChange={(v) => useProject.getState().setCutout(clip.id, { ...active, feather: v })} />
                <Slider label={t.maskEd.grow} value={active.grow} min={-20} max={20} step={1} unit=" px" onChange={(v) => useProject.getState().setCutout(clip.id, { ...active, grow: v })} />
              </>
            ) : (
              <button className="btn sm" onClick={() => useProject.getState().setCutout(clip.id, { enabled: true, trackId: tr.id, feather: 2, grow: 0, invert: false })}>{t.mask.use}</button>
            )}
          </div>
        );
      })}
    </Section>
  );
}
