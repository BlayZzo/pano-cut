// Inspektor: Bewegungspfad (Start-/Zwischen-/Endpunkte) – Bearbeitung in der Vorschau (PathOverlay.tsx).
import React from 'react';
import type { Clip, Motion } from '@shared/types';
import { setDirty, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, Slider, Toggle } from './InspectorBits';
import { emptyMotion } from './PathOverlay';

/** Zeiten so verteilen, dass die Strecke überall gleich schnell abgefahren wird (gleiche Anfangs-/Endzeit). */
export function evenPathTiming(m: Motion): Motion {
  const k = m.keyframes;
  if (k.length < 3) return m;
  const d = [0];
  for (let i = 1; i < k.length; i++) d.push(d[i - 1] + Math.hypot(k[i].x - k[i - 1].x, k[i].y - k[i - 1].y));
  const total = d[d.length - 1];
  if (total < 1e-6) return m;
  const a = k[0].t, b = k[k.length - 1].t;
  return { ...m, keyframes: k.map((key, i) => ({ ...key, t: Math.round((a + ((b - a) * d[i]) / total) * 1000) / 1000 })) };
}

export function InspectorPath({ clip }: { clip: Clip }): React.ReactElement {
  const pathEdit = useUi((s) => s.pathEdit);
  const setPathEdit = useUi((s) => s.setPathEdit);
  const m = clip.motion ?? emptyMotion();
  const n = m.keyframes.length;
  const write = (next: Motion) => { useProject.getState().updateClip(clip.id, { motion: next }); setDirty(true); };
  const editing = pathEdit === clip.id;
  return (
    <Section title={t.path.section} defaultOpen={editing || (n > 1 && m.preset === 'custom')} badge={n ? fmt(t.path.points, { n }) : undefined}>
      <div className="hint">{t.path.hint}</div>
      <button className={`btn${editing ? ' active' : ' primary'}`} style={{ width: '100%' }} onClick={() => {
        if (editing) { setPathEdit(null); return; }
        useUi.getState().select([clip.id]);
        setPathEdit(clip.id);
      }}>{editing ? t.path.done : t.path.edit}</button>
      <Toggle label={t.path.curve} checked={m.curve !== false} onChange={(v) => write({ ...m, curve: v })} />
      <Toggle label={t.path.smooth} checked={m.smooth} onChange={(v) => write({ ...m, smooth: v })} />
      <Slider label={t.path.blur} value={m.blur ?? 0} min={0} max={1} step={0.05} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => write({ ...m, blur: v })} />
      <div className="field-row" style={{ flexWrap: 'wrap', gap: 4 }}>
        <button className="btn sm" title={t.path.evenHint} disabled={n < 3} onClick={() => write(evenPathTiming(m))}>{t.path.even}</button>
        <button className="btn sm" disabled={n < 2} onClick={() => {
          const k = m.keyframes, a = k[0].t, b = k[k.length - 1].t;
          write({ ...m, keyframes: k.map((key) => ({ ...key, t: Math.round((a + b - key.t) * 1000) / 1000 })).sort((p, q) => p.t - q.t) });
        }}>{t.path.reverse}</button>
        <button className="btn sm ghost" disabled={n === 0} onClick={() => write({ ...m, keyframes: [] })}>{t.path.clear}</button>
      </div>
      {n === 0 && <div className="hint">{t.path.none}</div>}
    </Section>
  );
}
