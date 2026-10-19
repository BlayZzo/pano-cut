import React from 'react';
import type { Clip, FitMode, Transform } from '@shared/types';
import { clipDuration, defaultTransform, formatDuration, formatTime } from '@shared/timeline';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, Slider } from './InspectorBits';
import { InspectorPano } from './InspectorPano';
import { InspectorTitle } from './InspectorTitle';
import { InspectorStabilize, InspectorSubtitles, InspectorTransition } from './InspectorExtras';
import { InspectorChroma, InspectorObjects } from './InspectorAi';
import { DuckingFields, InspectorColor, InspectorFx, InspectorMotion, SaveEffectButton } from './InspectorLook';
import { InspectorLayer, InspectorVfx } from './InspectorLayer';
import { InspectorMusic } from './InspectorMusic';
import { SpeedRampFields } from './InspectorRamp';
import { InspectorDropIn } from './InspectorDropIn';

export function Inspector(): React.ReactElement {
  const selection = useUi((s) => s.selection);
  const clips = useProject((s) => s.project.clips);
  const selected = selection.map((id) => clips[id]).filter(Boolean) as Clip[];
  const media = useProject((s) => s.project.media);
  // Musik zusammen mit Video-Clips ausgewählt → Musik-Schnitt trotzdem anbieten
  const music = selected.length > 1 && media[selected[0].mediaId]?.type !== 'audio'
    ? selected.find((c) => media[c.mediaId]?.type === 'audio')
    : undefined;

  return (
    <aside className="panel">
      <div className="panel-header">{t.inspector.title}</div>
      <div className="panel-body">
        {selected.length === 0 ? (
          <div className="inspector-empty">
            <strong>{t.inspector.noSelection}</strong>
            {t.inspector.noSelectionHint}
          </div>
        ) : (
          <>
            {music && media[music.mediaId] && <InspectorMusic clip={music} media={media[music.mediaId]} />}
            <ClipInspector clip={selected[0]} ids={selected.map((c) => c.id)} count={selected.length} />
          </>
        )}
      </div>
    </aside>
  );
}

function ClipInspector({ clip, ids, count }: { clip: Clip; ids: string[]; count: number }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const updateClip = useProject((s) => s.updateClip);
  const setClipSpeed = useProject((s) => s.setSpeed);
  const media = useProject((s) => s.project.media[clip.mediaId]);
  const fps = useProject((s) => s.project.settings.fps);
  const isTitle = clip.kind === 'title';
  const isAudioOnly = media?.type === 'audio';
  const isImage = media?.type === 'image';

  const patch = (p: Partial<Clip>) => updateClips(ids, p);
  const patchTransform = (p: Partial<Transform>) => patch({ transform: { ...clip.transform, ...p } });
  const setSpeed = (speed: number) => setClipSpeed(ids, speed);

  return (
    <>
      <Section title={count > 1 ? fmt(t.inspector.multi, { n: count }) : t.inspector.sectionClip}>
        <div className="field-full">
          <label>{t.inspector.name}</label>
          <input type="text" value={clip.name} onChange={(e) => updateClip(clip.id, { name: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} spellCheck={false} />
        </div>
        <dl className="kv">
          <dt>{t.inspector.duration}</dt><dd>{formatTime(clipDuration(clip), fps)} ({formatDuration(clipDuration(clip))})</dd>
          {!isTitle && <><dt>{t.inspector.source}</dt><dd title={media?.path}>{media?.name ?? '–'}</dd></>}
          {media?.info.width ? <><dt>Größe</dt><dd>{media.info.width}×{media.info.height}{media.info.fps ? ` · ${Math.round(media.info.fps * 100) / 100} fps` : ''}{media.info.is360 ? ' · 360°' : ''}</dd></> : null}
        </dl>
      </Section>

      {isTitle && <InspectorTitle clip={clip} />}
      {!isTitle && media && (isAudioOnly || media.info.hasAudio) && !media.vfx && <InspectorMusic clip={clip} media={media} />}
      {!isTitle && media?.vfx && <InspectorVfx clip={clip} media={media} />}
      {!isTitle && !isAudioOnly && <InspectorLayer clip={clip} ids={ids} />}
      {!isTitle && count === 1 && media && !media.vfx && (media.hasAlpha || clip.cutout?.enabled) && <InspectorDropIn clip={clip} />}
      {!isTitle && media?.info.is360 && media.type === 'video' && <InspectorPano clip={clip} media={media} />}
      {!isTitle && !isAudioOnly && <InspectorTransition clip={clip} />}

      {!isImage && !isTitle && (
        <Section title={t.inspector.sectionSpeed} onReset={() => { beginTransaction(); setSpeed(1); patch({ reverse: false }); endTransaction(); }}>
          <div className="speed-presets">
            <button className={`chip${clip.speed === 0.25 ? ' active' : ''}`} onClick={() => setSpeed(0.25)}>¼×</button>
            <button className={`chip${clip.speed === 0.5 ? ' active' : ''}`} onClick={() => setSpeed(0.5)}>½× {t.inspector.slowmo}</button>
            <button className={`chip${clip.speed === 1 ? ' active' : ''}`} onClick={() => setSpeed(1)}>1× {t.inspector.normal}</button>
            <button className={`chip${clip.speed === 2 ? ' active' : ''}`} onClick={() => setSpeed(2)}>2×</button>
            <button className={`chip${clip.speed === 4 ? ' active' : ''}`} onClick={() => setSpeed(4)}>4× {t.inspector.timelapse}</button>
          </div>
          <Slider label={t.inspector.speed} value={clip.speed} min={0.1} max={16} step={0.05} unit="×" onChange={setSpeed} />
          <div className="hint">{t.inspector.speedHint}</div>
          <label className="toggle">
            <input type="checkbox" checked={clip.reverse} onChange={(e) => patch({ reverse: e.target.checked })} />
            {t.inspector.reverse}
          </label>
          {clip.reverse && media?.type === 'video' && !media.proxyReversed && <div className="hint warn">{t.inspector.reversedProxyHint}</div>}
          {count === 1 && media?.type === 'video' && !media.vfx && <SpeedRampFields clip={clip} />}
        </Section>
      )}

      {!isImage && !isTitle && media?.info.hasAudio && (
        <Section title={t.inspector.sectionAudio} onReset={() => patch({ volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ducking: undefined })}>
          <Slider label={t.inspector.volume} value={clip.volume} min={0} max={2} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patch({ volume: v })} />
          <label className="toggle">
            <input type="checkbox" checked={clip.muted} onChange={(e) => patch({ muted: e.target.checked })} />
            {t.inspector.mute}
          </label>
          <Slider label={t.inspector.fadeIn} value={clip.fadeIn} min={0} max={10} step={0.1} unit=" s" onChange={(v) => patch({ fadeIn: v })} />
          <Slider label={t.inspector.fadeOut} value={clip.fadeOut} min={0} max={10} step={0.1} unit=" s" onChange={(v) => patch({ fadeOut: v })} />
          <DuckingFields clip={clip} ids={ids} />
        </Section>
      )}

      {!isTitle && media && media.type !== 'audio' && !media.vfx && <InspectorObjects clip={clip} media={media} />}
      {!isTitle && media && media.type !== 'audio' && !media.vfx && <InspectorChroma clip={clip} />}
      {!isTitle && media?.type === 'video' && !media.vfx && <InspectorStabilize clip={clip} media={media} />}
      {!isTitle && media?.type === 'video' && media.info.hasAudio && <InspectorSubtitles clip={clip} media={media} />}

      {!isAudioOnly && !isTitle && (
        <Section title={t.inspector.sectionTransform} onReset={() => patch({ transform: defaultTransform(), opacity: 1, fit: 'contain' })}>
          <div className="field">
            <label>{t.inspector.fit}</label>
            <select value={clip.fit} onChange={(e) => patch({ fit: e.target.value as FitMode })} style={{ gridColumn: '2 / span 2' }}>
              <option value="contain">{t.inspector.fitContain}</option>
              <option value="cover">{t.inspector.fitCover}</option>
              <option value="stretch">{t.inspector.fitStretch}</option>
            </select>
          </div>
          <Slider label={t.inspector.scale} value={clip.transform.scale} min={0.1} max={4} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patchTransform({ scale: v })} />
          <Slider label={t.inspector.posX} value={clip.transform.x} min={-100} max={100} step={0.5} unit=" %" onChange={(v) => patchTransform({ x: v })} />
          <Slider label={t.inspector.posY} value={clip.transform.y} min={-100} max={100} step={0.5} unit=" %" onChange={(v) => patchTransform({ y: v })} />
          <Slider label={t.inspector.rotation} value={clip.transform.rotation} min={-180} max={180} step={1} unit="°" onChange={(v) => patchTransform({ rotation: v })} />
          <Slider label={t.inspector.opacity} value={clip.opacity} min={0} max={1} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patch({ opacity: v })} />
        </Section>
      )}

      {isTitle && (
        <Section title={t.inspector.sectionTransform} defaultOpen={false} onReset={() => patch({ opacity: 1 })}>
          <Slider label={t.inspector.opacity} value={clip.opacity} min={0} max={1} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patch({ opacity: v })} />
        </Section>
      )}

      {!isAudioOnly && !isTitle && <InspectorColor clip={clip} ids={ids} />}
      {!isAudioOnly && !isTitle && <InspectorFx clip={clip} ids={ids} />}
      {!isAudioOnly && !isTitle && <InspectorMotion clip={clip} ids={ids} />}
      {!isAudioOnly && !isTitle && count === 1 && <SaveEffectButton clip={clip} />}
    </>
  );
}
