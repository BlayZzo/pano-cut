import React, { useEffect, useState } from 'react';
import type { Clip, MediaItem } from '@shared/types';
import { DEFAULT_STAB } from '@shared/stabilize';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, SelectField, Slider, Toggle } from './InspectorBits';

/** 360°: Stabilisierung mit den Bewegungsdaten der Kamera (wie FlowState) + unsichtbarer Selfie-Stick. */
export function InspectorStab({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const updateClip = useProject((s) => s.updateClip);
  const updateMedia = useProject((s) => s.updateMedia);
  const [busy, setBusy] = useState<number | null>(null);
  const stab = clip.stab360 ?? { ...DEFAULT_STAB, mode: 'off' as const };
  const nadir = clip.nadir ?? { enabled: false, size: 22, feather: 6 };

  useEffect(() => window.panocut.onImuProgress((p) => { if (p.id === media.id) setBusy(p.percent); }), [media.id]);

  const measure = async () => {
    setBusy(0);
    try {
      const m = useProject.getState().project.media[media.id];
      if (!m) return;
      const r = await window.panocut.imuBuild(m);
      const cur = useProject.getState().project.media[media.id];
      if (cur) updateMedia({ ...cur, imu: { file: r.file, rate: r.rate, start: r.start, score: r.score, model: r.model } });
      if (!clip.stab360 || clip.stab360.mode === 'off') updateClip(clip.id, { stab360: { ...DEFAULT_STAB } });
      useUi.getState().toast(fmt(t.stab.done, { q: quality(r.score) }), 'success');
    } catch (e) {
      useUi.getState().toast(`${t.stab.failed}: ${(e as Error).message}`, 'error');
    } finally { setBusy(null); }
  };
  const setStab = (p: Partial<typeof stab>) => updateClip(clip.id, { stab360: { ...stab, ...p } });
  const setNadir = (p: Partial<typeof nadir>) => updateClip(clip.id, { nadir: { ...nadir, ...p } });

  return (
    <>
      <Section title={t.stab.section} badge={media.imu ? '✓' : undefined} defaultOpen={!!clip.stab360 && clip.stab360.mode !== 'off'}>
        {!media.imu ? (
          <>
            <div className="hint">{t.stab.needData}</div>
            <button className="btn sm primary" disabled={busy !== null} onClick={() => void measure()}>
              {busy !== null ? fmt(t.stab.measuring, { p: Math.round(busy) }) : t.stab.measure}
            </button>
          </>
        ) : (
          <>
            <SelectField label={t.stab.mode} value={stab.mode} options={[
              { value: 'off', label: t.stab.modeOff },
              { value: 'follow', label: t.stab.modeFollow },
              { value: 'lock', label: t.stab.modeLock },
            ]} onChange={(v) => setStab({ mode: v as typeof stab.mode })} />
            {stab.mode === 'follow' && (
              <Slider label={t.stab.smooth} value={stab.smooth} min={0.2} max={4} step={0.1} unit=" s" onChange={(v) => setStab({ smooth: v })} />
            )}
            {stab.mode !== 'off' && <Toggle label={t.stab.horizon} checked={stab.horizon} onChange={(v) => setStab({ horizon: v })} />}
            <div className="hint">{fmt(t.stab.info, { model: media.imu.model, q: quality(media.imu.score) })}</div>
            <button className="btn sm ghost" disabled={busy !== null} onClick={() => void measure()}>
              {busy !== null ? fmt(t.stab.measuring, { p: Math.round(busy) }) : t.stab.remeasure}
            </button>
          </>
        )}
      </Section>
      <Section title={t.stab.nadirSection} defaultOpen={nadir.enabled}>
        <Toggle label={t.stab.nadirOn} checked={nadir.enabled} onChange={(v) => setNadir({ enabled: v })} />
        {nadir.enabled && (
          <>
            <Slider label={t.stab.nadirSize} value={nadir.size} min={5} max={45} step={1} unit="°" onChange={(v) => setNadir({ size: v })} />
            <Slider label={t.stab.nadirFeather} value={nadir.feather} min={0} max={20} step={1} unit="°" onChange={(v) => setNadir({ feather: v })} />
          </>
        )}
        <div className="hint">{t.stab.nadirHint}</div>
      </Section>
    </>
  );
}

function quality(score: number): string {
  return score >= 0.6 ? t.stab.qGood : score >= 0.35 ? t.stab.qOk : t.stab.qWeak;
}
