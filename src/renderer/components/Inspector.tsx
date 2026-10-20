import React from 'react';
import type { Clip, FitMode, Transform } from '@shared/types';
import { clipDuration, defaultTransform, formatDuration, formatTime } from '@shared/timeline';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, Slider , NumInput } from './InspectorBits';
import { InspectorPano } from './InspectorPano';
import { InspectorStab } from './InspectorStab';
import { InspectorReframe } from './InspectorReframe';
import { InspectorTitle } from './InspectorTitle';
import { InspectorStabilize, InspectorSubtitles, InspectorTransition } from './InspectorExtras';
import { InspectorChroma, InspectorObjects } from './InspectorAi';
import { DuckingFields, InspectorColor, InspectorFx, InspectorLightFx, InspectorMotion, SaveEffectButton } from './InspectorLook';
import { InspectorClickCutout } from './InspectorCutout';
import { InspectorMaskDraw } from './InspectorMaskDraw';
import { InspectorLayer, InspectorVfx } from './InspectorLayer';
import { InspectorMusic } from './InspectorMusic';
import { SpeedRampFields } from './InspectorRamp';
import { InspectorDropIn } from './InspectorDropIn';
import { createMulticam, multicamCandidates } from '../multicamActions';

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
            {selected.length >= 2 && multicamCandidates(selection).length >= 2 && (
              <Section title={t.multicam.title} defaultOpen={new Set(selected.map((c) => c.trackId)).size > 1}>
                <button className="btn primary" style={{ width: '100%' }} onClick={() => void createMulticam(selection)}>{t.multicam.create}</button>
                <div className="hint">{t.multicam.createHint}</div>
              </Section>
            )}
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

  const inspectorTab = useUi((s) => s.inspectorTab);
  const setInspectorTab = useUi((s) => s.setInspectorTab);
  const patch = (p: Partial<Clip>) => updateClips(ids, p);
  const patchTransform = (p: Partial<Transform>) => patch({ transform: { ...clip.transform, ...p } });
  // Mit „Anziehen“: langsamer = länger – die folgenden Clips rücken mit, statt den Clip zu kürzen
  const setSpeed = (speed: number) => {
    if (!useUi.getState().magnet) { setClipSpeed(ids, speed); return; }
    const st = useProject.getState();
    beginTransaction();
    const moved: Clip[] = [];
    for (const id of ids) {
      const c = st.project.clips[id];
      if (!c) continue;
      const grow = (c.out - c.in) / Math.max(0.05, speed) - (c.out - c.in) / c.speed;
      if (grow > 0) for (const o of Object.values(st.project.clips)) if (o.trackId === c.trackId && o.id !== c.id && o.start >= c.start + 1e-6) moved.push({ ...o, start: o.start + grow });
    }
    if (moved.length) st.insertClips(moved);
    setClipSpeed(ids, speed);
    const tracks = ids.map((id) => useProject.getState().project.clips[id]?.trackId).filter(Boolean) as string[];
    useProject.getState().packTracks(tracks);
    endTransaction();
  };

  // Kategorien (Reiter), damit nicht alles untereinander steht
  type Cat = 'clip' | 'look' | 'motion' | 'audio' | 'text' | 'ai';
  const cats: Array<{ id: Cat; label: string; show: boolean }> = [
    { id: 'clip', label: t.inspector.catClip, show: true },
    { id: 'look', label: t.inspector.catLook, show: !isAudioOnly && !isTitle },
    { id: 'motion', label: t.inspector.catMotion, show: !isAudioOnly },
    { id: 'audio', label: t.inspector.catAudio, show: !isTitle && !isImage && (isAudioOnly || !!media?.info.hasAudio) },
    { id: 'text', label: t.inspector.catText, show: isTitle || (media?.type === 'video' && !!media.info.hasAudio) },
    { id: 'ai', label: t.inspector.catAi, show: !isTitle && !!media && media.type !== 'audio' && !media.vfx && !media.model3d },
  ];
  const visible = cats.filter((c) => c.show);
  const cat: Cat = visible.some((c) => c.id === inspectorTab) ? (inspectorTab as Cat) : visible[0].id;

  return (
    <>
      <div className="inspector-tabs">
        {visible.map((c) => <button key={c.id} className={`itab${cat === c.id ? ' active' : ''}`} onClick={() => setInspectorTab(c.id)}>{c.label}</button>)}
      </div>

      {cat === 'clip' && <>
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
      {!isTitle && media?.vfx && <InspectorVfx clip={clip} media={media} />}
      {!isTitle && media?.model3d && (
        <Section title={t.model3d.title} badge="3D">
          <button className="btn primary" style={{ width: '100%' }} onClick={() => useUi.getState().setModelPanel({ mediaId: media.id })}>{t.model3d.edit}</button>
        </Section>
      )}
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
      {!isTitle && !isAudioOnly && <InspectorTransition clip={clip} />}
      {!isTitle && !isAudioOnly && <InspectorLayer clip={clip} ids={ids} />}
      {!isTitle && media?.info.is360 && media.type === 'video' && <InspectorPano clip={clip} media={media} />}
      {!isTitle && media?.info.is360 && media.type === 'video' && <InspectorStab clip={clip} media={media} />}
      {!isAudioOnly && !isTitle && count === 1 && <SaveEffectButton clip={clip} />}
      </>}

      {cat === 'look' && <>
      <InspectorColor clip={clip} ids={ids} />
      <InspectorFx clip={clip} ids={ids} />
      <InspectorLightFx clip={clip} ids={ids} />
      {media && media.type !== 'audio' && !media.vfx && !media.model3d && <InspectorChroma clip={clip} />}
      {media?.type === 'video' && !media.vfx && !media.model3d && <InspectorStabilize clip={clip} media={media} />}
      </>}

      {cat === 'motion' && <>
      {!isTitle && media && (media.type === 'video' || media.type === 'image') && !media.info.is360 && !media.vfx && count === 1 && <InspectorReframe clip={clip} media={media} />}
      {!isImage && !isTitle && (
        <Section title={t.inspector.sectionSpeed} onReset={() => { beginTransaction(); setSpeed(1); patch({ reverse: false }); endTransaction(); }}>
          <div className="speed-presets">
            <button className={`chip${clip.speed === 0.25 ? ' active' : ''}`} onClick={() => setSpeed(0.25)}>¼×</button>
            <button className={`chip${clip.speed === 0.5 ? ' active' : ''}`} onClick={() => setSpeed(0.5)}>½× {t.inspector.slowmo}</button>
            <button className={`chip${clip.speed === 1 ? ' active' : ''}`} onClick={() => setSpeed(1)}>1× {t.inspector.normal}</button>
            <button className={`chip${clip.speed === 2 ? ' active' : ''}`} onClick={() => setSpeed(2)}>2×</button>
            <button className={`chip${clip.speed === 4 ? ' active' : ''}`} onClick={() => setSpeed(4)}>4× {t.inspector.timelapse}</button>
          </div>
          <div className="speed-field">
            <button className="btn sm" title="−1" onClick={() => setSpeed(Math.max(0.05, clip.speed >= 2 ? clip.speed - 1 : clip.speed / 2))}>−1</button>
            <button className="btn sm ghost" title="−0,1" onClick={() => setSpeed(Math.max(0.05, Math.round((clip.speed - 0.1) * 100) / 100))}>−,1</button>
            <NumInput className="speed-num" value={clip.speed} min={0.05} max={100} step={0.01} onChange={setSpeed} title={t.inspector.speedType} />
            <span className="speed-x">×</span>
            <button className="btn sm ghost" title="+0,1" onClick={() => setSpeed(Math.round((clip.speed + 0.1) * 100) / 100)}>+,1</button>
            <button className="btn sm" title="+1" onClick={() => setSpeed(clip.speed < 1 ? Math.min(1, clip.speed * 2) : Math.floor(clip.speed) + 1)}>+1</button>
          </div>
          <Slider label={t.inspector.speedFine} value={Math.log2(clip.speed)} min={-4} max={6.64} step={0.01} display={(v) => `${(2 ** v).toFixed(2)}×`} onChange={(v) => setSpeed(Math.round(2 ** v * 100) / 100)} />
          <div className="hint">{t.inspector.speedHint}</div>
          <label className="toggle">
            <input type="checkbox" checked={clip.reverse} onChange={(e) => patch({ reverse: e.target.checked })} />
            {t.inspector.reverse}
          </label>
          {clip.reverse && media?.type === 'video' && !media.proxyReversed && <div className="hint warn">{t.inspector.reversedProxyHint}</div>}
        </Section>
      )}
      {!isImage && !isTitle && count === 1 && media?.type === 'video' && !media.vfx && !clip.mc && (
        <Section title={t.ramp.section} defaultOpen>
          <SpeedRampFields clip={clip} />
        </Section>
      )}
      {!isAudioOnly && <InspectorMotion clip={clip} ids={ids} />}
      {!isTitle && count === 1 && media && !media.vfx && (media.hasAlpha || clip.cutout?.enabled) && <InspectorDropIn clip={clip} />}
      </>}

      {cat === 'audio' && <>
      {!clip.mc && media && (isAudioOnly || media.info.hasAudio) && !media.vfx && <InspectorMusic clip={clip} media={media} />}
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
      </>}

      {cat === 'text' && <>
      {isTitle && <InspectorTitle clip={clip} />}
      {!isTitle && media?.type === 'video' && media.info.hasAudio && <InspectorSubtitles clip={clip} media={media} />}
      </>}

      {cat === 'ai' && media && <>
      {count === 1 && (media.type === 'video' || media.type === 'image') && <InspectorMaskDraw clip={clip} media={media} />}
      {count === 1 && media.type === 'video' && <InspectorClickCutout clip={clip} media={media} />}
      <InspectorObjects clip={clip} media={media} />
      </>}
    </>
  );
}
