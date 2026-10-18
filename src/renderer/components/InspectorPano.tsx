import React from 'react';
import type { Clip, MediaItem, PanoMode } from '@shared/types';
import { clipDuration, formatTime } from '@shared/timeline';
import { defaultPano, defaultStitch, keyframeAt, panoViewAt, removeKeyframe, upsertKeyframe } from '@shared/pano';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, SelectField, Slider, Toggle } from './InspectorBits';
import { seekTo } from '../engine/instance';

/** 360°-Abschnitt: Ansicht, Keyframes, Stitching. */
export function InspectorPano({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement | null {
  const setPano = useProject((s) => s.setPano);
  const updateMediaStitch = useProject((s) => s.updateMediaStitch);
  const fps = useProject((s) => s.project.settings.fps);
  const is360Project = useProject((s) => !!s.project.settings.is360);
  const playhead = useUi((s) => s.playhead);
  const pano = clip.pano ?? defaultPano(is360Project ? 'equirect' : 'flat');
  const local = Math.max(0, Math.min(clipDuration(clip), playhead - clip.start));
  const view = panoViewAt(pano, local);
  const atKey = keyframeAt(pano, local);
  const editingT = atKey ? atKey.t : (pano.keyframes.length === 1 ? pano.keyframes[0].t : local);

  /** Ändert die Ausrichtung am aktuellen Keyframe (bzw. legt bei Kamerafahrten einen neuen an). */
  const patchView = (p: Partial<{ yaw: number; pitch: number; roll: number; fov: number }>) => {
    const base = atKey ?? (pano.keyframes.length === 1 ? pano.keyframes[0] : { t: local, ...view });
    setPano(clip.id, upsertKeyframe(pano, { ...base, ...p }));
  };

  const stitch = media.stitch ?? defaultStitch('equirect');
  const restitch = () => {
    const m = useProject.getState().project.media[media.id];
    if (m) void window.panocut.prepareMedia({ ...m, proxy: undefined, proxyReversed: undefined, proxyStabilized: undefined, status: 'processing' });
  };

  return (
    <>
      <Section title={t.pano.section} badge="360°" onReset={() => setPano(clip.id, defaultPano(pano.mode))}>
        <SelectField label={t.pano.mode} value={pano.mode} onChange={(v) => setPano(clip.id, { ...pano, mode: v as PanoMode, keyframes: pano.keyframes.map((k) => ({ ...k, fov: v === 'littleplanet' ? Math.max(k.fov, 200) : Math.min(k.fov, 150) })) })}
          options={[{ value: 'flat', label: t.pano.modeFlat }, { value: 'equirect', label: t.pano.modeEquirect }, { value: 'littleplanet', label: t.pano.modeLittle }]} />
        <Slider label={t.pano.yaw} value={view.yaw} min={-180} max={180} step={1} unit="°" onChange={(v) => patchView({ yaw: v })} />
        <Slider label={t.pano.pitch} value={view.pitch} min={-90} max={90} step={1} unit="°" onChange={(v) => patchView({ pitch: v })} />
        <Slider label={t.pano.roll} value={view.roll} min={-180} max={180} step={1} unit="°" onChange={(v) => patchView({ roll: v })} />
        {pano.mode !== 'equirect' && (
          <Slider label={t.pano.fov} value={view.fov} min={pano.mode === 'littleplanet' ? 120 : 30} max={pano.mode === 'littleplanet' ? 320 : 150} step={1} unit="°" onChange={(v) => patchView({ fov: v })} />
        )}
        <div className="hint">{t.pano.keyframeHint}</div>
        <div className="field-row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => setPano(clip.id, upsertKeyframe(pano, { t: local, ...view }))}>◆ {t.pano.addKeyframe}</button>
          {atKey && pano.keyframes.length > 1 && <button className="btn sm ghost" onClick={() => setPano(clip.id, removeKeyframe(pano, atKey.t))}>{t.pano.removeKeyframe}</button>}
        </div>
        {pano.keyframes.length > 1 && (
          <>
            <div className="hint">{fmt(t.pano.noKeyframeHere, { t: formatTime(editingT, fps) })}</div>
            <div className="keyframe-list">
              {pano.keyframes.map((k) => (
                <button key={k.t} className={`chip${atKey && Math.abs(atKey.t - k.t) < 1e-6 ? ' active' : ''}`} onClick={() => seekTo(clip.start + k.t)} title={`Blick ${Math.round(k.yaw)}° / ${Math.round(k.pitch)}°, Sichtfeld ${Math.round(k.fov)}°`}>
                  ◆ {formatTime(k.t, fps)}
                </button>
              ))}
            </div>
            <Toggle label={t.pano.smooth} checked={pano.smooth} onChange={(v) => setPano(clip.id, { ...pano, smooth: v })} />
          </>
        )}
      </Section>
      {media.stitch && media.stitch.mode !== 'equirect' && (
        <Section title={t.pano.stitch} defaultOpen={false}>
          <Slider label={t.pano.stitchFov} value={stitch.fov} min={170} max={220} step={0.5} unit="°" onChange={(v) => updateMediaStitch(media.id, { fov: v })} />
          <Slider label={t.pano.stitchYaw} value={stitch.yaw} min={-180} max={180} step={1} unit="°" onChange={(v) => updateMediaStitch(media.id, { yaw: v })} />
          <Slider label={t.pano.stitchPitch} value={stitch.pitch} min={-90} max={90} step={1} unit="°" onChange={(v) => updateMediaStitch(media.id, { pitch: v })} />
          <Slider label={t.pano.stitchRoll} value={stitch.roll} min={-180} max={180} step={1} unit="°" onChange={(v) => updateMediaStitch(media.id, { roll: v })} />
          <div className="field-row">
            <button className="btn sm primary" onClick={restitch}>{t.pano.restitch}</button>
            <button className="btn sm ghost" onClick={() => { beginTransaction(); updateMediaStitch(media.id, { fov: 195, yaw: 0, pitch: 0, roll: 0 }); endTransaction(); }}>{t.pano.reset}</button>
          </div>
          <div className="hint">{t.pano.restitchHint}</div>
        </Section>
      )}
    </>
  );
}
