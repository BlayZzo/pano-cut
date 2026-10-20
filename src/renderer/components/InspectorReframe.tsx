// 🎥 Kamerafahrt für normale Videos und Bilder: Ausschnitt markieren (Zoom + Lage), an anderer Stelle wieder markieren –
// dazwischen fährt die Kamera weich. Gerechnet wird aus dem vollen Quellbild (shared/reframe.ts), daher ohne Qualitätsverlust,
// solange die Quelle höher aufgelöst ist als das Projekt.
import React from 'react';
import type { Clip, MediaItem, MoveEase, ReframeKeyframe } from '@shared/types';
import { clipDuration, formatTime } from '@shared/timeline';
import { REFRAME_PRESETS, REFRAME_ZOOM_MAX, reframeAt, upsertReframeKey } from '@shared/reframe';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { usePlayheadCoarse } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, SelectField, Slider } from './InspectorBits';
import { seekTo } from '../engine/instance';

export const EASE_OPTIONS = (): Array<{ value: MoveEase; label: string }> => [
  { value: 'smooth', label: t.moves.easeSmooth },
  { value: 'linear', label: t.moves.easeLinear },
  { value: 'in', label: t.moves.easeIn },
  { value: 'out', label: t.moves.easeOut },
];

export function InspectorReframe({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const updateClip = useProject((s) => s.updateClip);
  const project = useProject((s) => s.project.settings);
  const fps = project.fps;
  const playhead = usePlayheadCoarse(0.1);
  const dur = clipDuration(clip);
  const local = Math.max(0, Math.min(dur, playhead - clip.start));
  const rf = clip.reframe;
  const cur = rf ? reframeAt(rf, local) : { zoom: 1, x: 0.5, y: 0.5 };
  const atKey = rf?.keyframes.find((k) => Math.abs(k.t - local) < 0.5 / fps);
  const set = (next: Clip['reframe']) => updateClip(clip.id, { reframe: next });

  // Regler ändern die Markierung am Abspielkopf (bzw. die einzige Markierung); sonst entsteht eine neue
  const patch = (p: Partial<ReframeKeyframe>) => {
    const base = atKey ?? (rf && rf.keyframes.length === 1 ? rf.keyframes[0] : { t: local, ...cur });
    set(upsertReframeKey(rf ?? { keyframes: [], ease: 'smooth' }, { ...base, ...p }));
  };
  const mark = () => set(upsertReframeKey(rf, { t: local, ...cur }));
  const remove = () => {
    if (!rf || !atKey) return;
    const keys = rf.keyframes.filter((k) => k !== atKey);
    set(keys.length ? { ...rf, keyframes: keys } : undefined);
  };
  const scale = Math.min(media.info.width / Math.max(1, project.width), media.info.height / Math.max(1, project.height));
  const sharpUntil = Math.max(1, scale);

  return (
    <Section title={`🎥 ${t.moves.title}`} defaultOpen={!!rf} onReset={() => set(undefined)}>
      <div className="hint">{t.moves.hint}</div>
      <div className="preset-grid">
        {REFRAME_PRESETS.map((p) => (
          <button key={p.id} className="btn sm ghost preset-btn" onClick={() => { beginTransaction(); set({ ease: rf?.ease ?? 'smooth', keyframes: p.make(dur) }); endTransaction(); }}>
            <span className="emo">{p.icon}</span>{p.name}
          </button>
        ))}
      </div>
      <Slider label={`🔍 ${t.moves.zoom}`} value={cur.zoom} min={1} max={REFRAME_ZOOM_MAX} step={0.01} unit="×" onChange={(v) => patch({ zoom: v })} />
      <Slider label={`↔️ ${t.moves.x}`} value={cur.x * 100} min={0} max={100} step={1} unit=" %" onChange={(v) => patch({ x: v / 100 })} />
      <Slider label={`↕️ ${t.moves.y}`} value={cur.y * 100} min={0} max={100} step={1} unit=" %" onChange={(v) => patch({ y: v / 100 })} />
      {cur.zoom > sharpUntil + 0.05 && <div className="hint warn">{fmt(t.moves.softWarn, { z: sharpUntil.toFixed(1).replace('.', ',') })}</div>}
      <div className="field-row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm primary" onClick={mark}>◆ {t.moves.mark}</button>
        {atKey && <button className="btn sm ghost" onClick={remove}>{t.moves.unmark}</button>}
      </div>
      {rf && rf.keyframes.length > 0 && (
        <>
          <div className="keyframe-list">
            {rf.keyframes.map((k) => (
              <button key={k.t} className={`chip${atKey === k ? ' active' : ''}`} onClick={() => seekTo(clip.start + k.t)} title={`${k.zoom.toFixed(2)}× · ${Math.round(k.x * 100)} % / ${Math.round(k.y * 100)} %`}>
                ◆ {formatTime(k.t, fps)}
              </button>
            ))}
          </div>
          <SelectField label={t.moves.ease} value={rf.ease} options={EASE_OPTIONS()} onChange={(v) => set({ ...rf, ease: v as MoveEase })} />
        </>
      )}
    </Section>
  );
}
