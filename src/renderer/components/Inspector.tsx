import React from 'react';
import type { Clip, FitMode, Transform } from '@shared/types';
import { clipDuration, defaultTransform, formatTime, speedLimits } from '@shared/timeline';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Fold, NumInput, Section, Slider, Toggle } from './InspectorBits';
import { InspectorPano, InspectorStitch } from './InspectorPano';
import { InspectorStab } from './InspectorStab';
import { InspectorReframe } from './InspectorReframe';
import { InspectorTitle } from './InspectorTitle';
import { InspectorStabilize, InspectorSubtitles, InspectorTransition } from './InspectorExtras';
import { InspectorChroma } from './InspectorAi';
import { DuckingFields, InspectorColor, InspectorCrop, InspectorFx, InspectorLightFx, InspectorMotion, SaveEffectButton } from './InspectorLook';
import { InspectorMasks } from './InspectorMaskDraw';
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
  // Flüssiger Bereich (aus den fps der Videos): langsamer/schneller geht nicht, sonst ruckelt es
  const allMedia = useProject((s) => s.project.media);
  const allClips = useProject((s) => s.project.clips);
  const lim = ids.reduce((acc, id) => {
    const c = allClips[id];
    const l = speedLimits(c ? allMedia[c.mediaId] : undefined, fps);
    return { min: Math.max(acc.min, l.min), max: Math.min(acc.max, l.max), fps: l.fps || acc.fps };
  }, { min: 0.05, max: 100, fps: 0 });
  const setSpeed = (raw: number) => {
    const speed = Math.round(Math.min(lim.max, Math.max(lim.min, raw)) * 100) / 100;
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

  // Reiter wie in DaVinci Resolve: immer dieselbe Reihenfolge, 360°-Technik in einem eigenen Reiter
  type Cat = 'video' | 'color' | 'audio' | 'text' | 'cutout' | 'anim' | 'pano';
  const is360 = !isTitle && !!media?.info.is360 && media.type === 'video';
  const visualMedia = !!media && (media.type === 'video' || media.type === 'image') && !media.vfx && !media.model3d;
  const cats: Array<{ id: Cat; label: string; show: boolean }> = [
    { id: 'video', label: t.inspector.catVideo, show: !isAudioOnly },
    { id: 'color', label: t.inspector.catColor, show: !isAudioOnly && !isTitle },
    { id: 'audio', label: t.inspector.catAudio, show: !isTitle && !isImage && (isAudioOnly || !!media?.info.hasAudio) },
    { id: 'text', label: t.inspector.catText, show: isTitle || (media?.type === 'video' && !!media.info.hasAudio) },
    { id: 'cutout', label: t.inspector.catCutout, show: !isTitle && visualMedia },
    { id: 'anim', label: t.inspector.catAnim, show: !isAudioOnly },
    { id: 'pano', label: '360°', show: is360 },
  ];
  const visible = cats.filter((c) => c.show);
  const legacy: Record<string, Cat> = { clip: 'video', look: 'color', motion: 'video', ai: 'cutout' };
  const wanted = (legacy[inspectorTab] ?? inspectorTab) as Cat;
  const cat: Cat = visible.some((c) => c.id === wanted) ? wanted : visible[0].id;

  const speedSection = !isImage && !isTitle && (
    <Section title={t.inspector.sectionSpeed} defaultOpen={clip.speed !== 1 || clip.reverse} badge={clip.speed !== 1 ? `${Math.round(clip.speed * 100) / 100}×` : undefined}
      onReset={() => { beginTransaction(); setSpeed(1); patch({ reverse: false }); endTransaction(); }}>
      <div className="speed-presets">
        {[0.25, 0.5, 1, 2, 4].map((v) => (
          <button key={v} className={`chip${clip.speed === v ? ' active' : ''}`} disabled={v < lim.min - 1e-6 || v > lim.max + 1e-6} title={v < lim.min - 1e-6 || v > lim.max + 1e-6 ? t.inspector.speedNotSmooth : undefined} onClick={() => setSpeed(v)}>
            {v === 0.25 ? '¼×' : v === 0.5 ? `½× ${t.inspector.slowmo}` : v === 1 ? `1× ${t.inspector.normal}` : v === 4 ? `4× ${t.inspector.timelapse}` : `${v}×`}
          </button>
        ))}
      </div>
      <div className="speed-field">
        <button className="btn sm" title="−" onClick={() => setSpeed(Math.max(0.05, clip.speed > 2 ? clip.speed - 1 : Math.round((clip.speed - 0.1) * 100) / 100))}>−</button>
        <NumInput className="speed-num" value={clip.speed} min={lim.min} max={lim.max} step={0.01} onChange={setSpeed} title={t.inspector.speedType} />
        <span className="speed-x">×</span>
        <button className="btn sm" title="+" onClick={() => setSpeed(clip.speed >= 2 ? Math.floor(clip.speed) + 1 : Math.round((clip.speed + 0.1) * 100) / 100)}>+</button>
      </div>
      {lim.fps > 0 && (
        <div className="hint">{fmt(t.inspector.speedRange, { fps: String(Math.round(lim.fps * 100) / 100).replace('.', ','), min: String(lim.min).replace('.', ','), max: String(lim.max).replace('.', ',') })}</div>
      )}
      {(clip.speed < lim.min - 1e-6 || clip.speed > lim.max + 1e-6) && (
        <div className="hint warn">{t.inspector.speedOutside} <button className="btn sm" onClick={() => setSpeed(clip.speed)}>{t.inspector.speedFix}</button></div>
      )}
      <div className="hint">{t.inspector.speedKeysHint}</div>
      <Toggle label={t.inspector.reverse} checked={clip.reverse} onChange={(v) => patch({ reverse: v })} />
      {clip.reverse && media?.type === 'video' && !media.proxyReversed && <div className="hint warn">{t.inspector.reversedProxyHint}</div>}
      {count === 1 && media?.type === 'video' && !media.vfx && !clip.mc && <Fold title={t.ramp.section} defaultOpen={false}><SpeedRampFields clip={clip} /></Fold>}
    </Section>
  );

  return (
    <>
      <div className="clip-head">
        {count > 1
          ? <strong>{fmt(t.inspector.multi, { n: count })}</strong>
          : <input type="text" value={clip.name} onChange={(e) => updateClip(clip.id, { name: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} spellCheck={false} title={t.inspector.name} />}
        <div className="meta" title={media?.path}>
          {formatTime(clipDuration(clip), fps)}
          {!isTitle && media ? ` · ${media.name}` : ''}
          {media?.info.width ? ` · ${media.info.width}×${media.info.height}` : ''}
          {media?.info.fps ? ` · ${Math.round(media.info.fps * 100) / 100} fps` : ''}
        </div>
      </div>
      <div className="inspector-tabs">
        {visible.map((c) => <button key={c.id} className={`itab${cat === c.id ? ' active' : ''}`} onClick={() => setInspectorTab(c.id)}>{c.label}</button>)}
      </div>

      {cat === 'video' && <>
      {!isTitle && media?.vfx && <InspectorVfx clip={clip} media={media} />}
      {!isTitle && media?.model3d && (
        <Section title={t.model3d.title} badge="3D">
          <button className="btn primary" style={{ width: '100%' }} onClick={() => useUi.getState().setModelPanel({ mediaId: media.id })}>{t.model3d.edit}</button>
        </Section>
      )}
      {is360 && <InspectorPano clip={clip} media={media} />}
      {!is360 && visualMedia && count === 1 && media && <InspectorReframe clip={clip} media={media} />}
      {!isTitle && (
        <Section title={t.inspector.sectionTransform} defaultOpen={isTransformed(clip)} badge={isTransformed(clip) ? '•' : undefined} onReset={() => patch({ transform: defaultTransform(), opacity: 1, fit: 'contain' })}>
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
      {!isTitle && visualMedia && <InspectorCrop clip={clip} ids={ids} />}
      {speedSection}
      {is360 && media && <InspectorStab clip={clip} media={media} part="stab" />}
      {!is360 && media?.type === 'video' && !media.vfx && !media.model3d && <InspectorStabilize clip={clip} media={media} />}
      {!isTitle && <InspectorTransition clip={clip} />}
      {!isTitle && <InspectorLayer clip={clip} ids={ids} />}
      </>}

      {cat === 'color' && <>
      <InspectorColor clip={clip} ids={ids} />
      <InspectorFx clip={clip} ids={ids} />
      <InspectorLightFx clip={clip} ids={ids} />
      </>}

      {cat === 'audio' && <>
      {isAudioOnly && speedSection}
      {!clip.mc && media && (isAudioOnly || media.info.hasAudio) && !media.vfx && <InspectorMusic clip={clip} media={media} />}
      {!isImage && !isTitle && media?.info.hasAudio && (
        <Section title={t.inspector.sectionAudio} onReset={() => patch({ volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ducking: undefined })}>
          <Slider label={t.inspector.volume} value={clip.volume} min={0} max={2} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patch({ volume: v })} />
          <Toggle label={t.inspector.mute} checked={clip.muted} onChange={(v) => patch({ muted: v })} />
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

      {cat === 'cutout' && media && <>
      {count === 1 && <InspectorMasks clip={clip} media={media} />}
      <InspectorChroma clip={clip} />
      </>}

      {cat === 'anim' && <>
      <InspectorMotion clip={clip} ids={ids} />
      {!isTitle && count === 1 && media && !media.vfx && (media.hasAlpha || clip.cutout?.enabled) && <InspectorDropIn clip={clip} />}
      {!isAudioOnly && !isTitle && count === 1 && (
        <Section title={t.effects.ownSection} defaultOpen={false}>
          <div className="hint">{t.effects.ownHint}</div>
          <SaveEffectButton clip={clip} />
        </Section>
      )}
      </>}

      {cat === 'pano' && media && <>
      <InspectorStitch media={media} />
      <InspectorStab clip={clip} media={media} part="nadir" />
      </>}
    </>
  );
}

function isTransformed(c: Clip): boolean {
  const tr = c.transform;
  return tr.scale !== 1 || tr.x !== 0 || tr.y !== 0 || tr.rotation !== 0 || c.opacity !== 1 || c.fit !== 'contain';
}
