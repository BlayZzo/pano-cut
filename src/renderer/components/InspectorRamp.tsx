import React, { useState } from 'react';
import type { Clip } from '@shared/types';
import { SPEED_RAMPS, speedRampPieces, type SpeedRamp } from '@shared/cameraMoves';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { SelectField } from './InspectorBits';

let last: { ramp: SpeedRamp; strength: number } = { ramp: 'slowMid', strength: 1 };

/** Tempo-Rampe: Clip in Stücke mit wechselndem Tempo teilen (Länge bleibt gleich). */
export function SpeedRampFields({ clip }: { clip: Clip }): React.ReactElement {
  const [ramp, setRamp] = useState<SpeedRamp>(last.ramp);
  const [strength, setStrength] = useState(last.strength);
  const apply = () => {
    last = { ramp, strength };
    const pieces = speedRampPieces(clip, ramp, strength);
    const store = useProject.getState();
    beginTransaction();
    try {
      store.removeClips([clip.id]);
      useProject.getState().insertClips(pieces);
      useUi.getState().select(pieces.map((p) => p.id));
    } finally {
      endTransaction();
    }
    useUi.getState().toast(fmt(t.inspector.rampDone, { n: pieces.length }), 'success');
  };
  return (
    <div className="music-auto">
      <div className="music-auto-title">{t.inspector.ramp}</div>
      <SelectField label={t.inspector.ramp} value={ramp} onChange={(v) => setRamp(v as SpeedRamp)} options={SPEED_RAMPS.map((r) => ({ value: r.id, label: r.name }))} />
      <div className="field">
        <label>{t.inspector.rampStrength}</label>
        <input type="range" min={0.2} max={2} step={0.05} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} />
        <span className="num-label">{Math.round(strength * 100)} %</span>
      </div>
      <button className="btn" style={{ width: '100%' }} onClick={apply}>{t.inspector.rampApply}</button>
      <div className="hint">{t.inspector.rampHint}</div>
    </div>
  );
}
