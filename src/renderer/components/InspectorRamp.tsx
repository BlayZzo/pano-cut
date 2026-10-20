import React, { useState } from 'react';
import type { Clip } from '@shared/types';
import { SPEED_RAMPS, speedRampPieces, type SpeedRamp } from '@shared/cameraMoves';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi, usePlayheadCoarse } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { SelectField, Toggle } from './InspectorBits';
import { clipDuration } from '@shared/timeline';
import { NEUTRAL_FX } from '@shared/effects';
import { insertSfx } from '../actions';

let last: { ramp: SpeedRamp; strength: number; atPlayhead: boolean; sound: string; blur: boolean } = { ramp: 'passby', strength: 1, atPlayhead: true, sound: '', blur: false };

/** Tempo-Rampe: Clip in Stücke mit wechselndem Tempo teilen (Länge bleibt gleich). */
export function SpeedRampFields({ clip }: { clip: Clip }): React.ReactElement {
  const [o, setO] = useState(last);
  const upd = (p: Partial<typeof o>) => { const n = { ...o, ...p }; last = n; setO(n); };
  const playhead = usePlayheadCoarse(0.25);
  const D = clipDuration(clip);
  const inside = playhead > clip.start + 0.05 && playhead < clip.start + D - 0.05;
  const center = o.atPlayhead && inside ? (playhead - clip.start) / D : 0.5;
  const apply = async () => {
    let pieces = speedRampPieces(clip, o.ramp, o.strength, o.ramp === 'passby' ? 24 : 16, center);
    // Schnelle Stücke bekommen Bewegungsunschärfe (je schneller, desto mehr)
    if (o.blur) pieces = pieces.map((p) => (p.speed > 1.3 ? { ...p, fx: { ...NEUTRAL_FX, ...(p.fx ?? {}), motionBlur: Math.min(1, (p.speed - 1) * 0.35) } } : p));
    const store = useProject.getState();
    beginTransaction();
    try {
      store.removeClips([clip.id]);
      useProject.getState().insertClips(pieces);
      useUi.getState().select(pieces.map((p) => p.id));
    } finally {
      endTransaction();
    }
    if (o.sound) {
      // Sound so legen, dass seine Mitte auf dem Zeitlupen-Moment liegt
      const moment = clip.start + center * D;
      const half = o.sound === 'passby' ? 1.5 : o.sound === 'whoosh-long' ? 0.85 : 0.5;
      await insertSfx(o.sound, {}, Math.max(0, moment - half)).catch(() => null);
    }
    useUi.getState().toast(fmt(t.inspector.rampDone, { n: pieces.length }), 'success');
  };
  return (
    <div className="music-auto">
      <SelectField label={t.inspector.ramp} value={o.ramp} onChange={(v) => upd({ ramp: v as SpeedRamp })} options={SPEED_RAMPS.map((r) => ({ value: r.id, label: r.name }))} />
      <div className="field">
        <label>{t.inspector.rampStrength}</label>
        <input type="range" min={0.2} max={2} step={0.05} value={o.strength} onChange={(e) => upd({ strength: parseFloat(e.target.value) })} />
        <span className="num-label">{Math.round(o.strength * 100)} %</span>
      </div>
      <Toggle label={t.ramp.atPlayhead} checked={o.atPlayhead} onChange={(v) => upd({ atPlayhead: v })} />
      {o.atPlayhead && !inside && <div className="hint">{t.ramp.playheadOutside}</div>}
      <Toggle label={t.ramp.blur} checked={o.blur} onChange={(v) => upd({ blur: v })} />
      <SelectField label={t.ramp.sound} value={o.sound} onChange={(v) => upd({ sound: v })} options={[
        { value: '', label: t.dropIn.soundNone }, { value: 'whoosh', label: 'Whoosh' }, { value: 'whoosh-long', label: 'Whoosh lang' }, { value: 'passby', label: 'Vorbeifahrt (Auto)' }, { value: 'swoosh-deep', label: 'Tiefer Swoosh' },
      ]} />
      <button className="btn primary" style={{ width: '100%' }} onClick={() => void apply()}>{t.inspector.rampApply}</button>
      <div className="hint">{t.inspector.rampHint}</div>
    </div>
  );
}
