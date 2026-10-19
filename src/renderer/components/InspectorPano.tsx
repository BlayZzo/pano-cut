import React, { useState } from 'react';
import type { Clip, MediaItem, PanoMode, PanoSettings } from '@shared/types';
import { applyCameraMove, CAMERA_MOVES, type CameraMove } from '@shared/cameraMoves';
import { clipDuration, formatTime } from '@shared/timeline';
import { defaultPano, defaultStitch, keyframeAt, panoViewAt, removeKeyframe, upsertKeyframe } from '@shared/pano';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi, usePlayheadCoarse } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, SelectField, Slider, Toggle } from './InspectorBits';
import { seekTo } from '../engine/instance';

let lastMove: { move: CameraMove; strength: number } = { move: 'orbit', strength: 1 };

/** Fertige Kamerafahrten (Rundum-Schwenk, Planet, Peitsche …) ab dem Abspielkopf einsetzen. */
function CameraMoveFields({ clip, pano, local }: { clip: Clip; pano: PanoSettings; local: number }): React.ReactElement {
  const setPano = useProject((s) => s.setPano);
  const [move, setMove] = useState<CameraMove>(lastMove.move);
  const def = CAMERA_MOVES.find((m) => m.id === move)!;
  const dur = clipDuration(clip);
  const [duration, setDuration] = useState(def.duration);
  const [strength, setStrength] = useState(lastMove.strength);
  const maxDur = Math.max(0.3, Math.min(20, dur - Math.min(local, dur - 0.3)));
  const apply = () => {
    lastMove = { move, strength };
    setPano(clip.id, applyCameraMove(pano, move, local, Math.min(duration, maxDur), strength, dur));
    useUi.getState().toast(fmt(t.pano.moveDone, { name: def.name }), 'success');
  };
  return (
    <div className="music-auto">
      <div className="music-auto-title">{t.pano.moveTitle}</div>
      <SelectField label={t.pano.move} value={move} onChange={(v) => { const m = v as CameraMove; setMove(m); setDuration(CAMERA_MOVES.find((x) => x.id === m)!.duration); }}
        options={CAMERA_MOVES.map((m) => ({ value: m.id, label: m.name }))} />
      <div className="hint">{def.hint}</div>
      <div className="field">
        <label>{t.pano.moveDuration}</label>
        <input type="range" min={0.3} max={maxDur} step={0.1} value={Math.min(duration, maxDur)} onChange={(e) => setDuration(parseFloat(e.target.value))} />
        <span className="num-label">{Math.min(duration, maxDur).toFixed(1)} s</span>
      </div>
      <div className="field">
        <label>{t.pano.moveStrength}</label>
        <input type="range" min={0.3} max={2} step={0.05} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} />
        <span className="num-label">{Math.round(strength * 100)} %</span>
      </div>
      <button className="btn primary" style={{ width: '100%' }} onClick={apply}>{t.pano.moveApply}</button>
      <div className="hint">{t.pano.moveHint}</div>
    </div>
  );
}

/** 360°-Abschnitt: Ansicht, Keyframes, Stitching. */
export function InspectorPano({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement | null {
  const setPano = useProject((s) => s.setPano);
  const updateMediaStitch = useProject((s) => s.updateMediaStitch);
  const fps = useProject((s) => s.project.settings.fps);
  const is360Project = useProject((s) => !!s.project.settings.is360);
  const playhead = usePlayheadCoarse(0.25);
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
        <CameraMoveFields clip={clip} pano={pano} local={local} />
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
