import React, { useEffect, useState } from 'react';
import type { Clip, MediaItem, SubtitleSegment, TransitionType, WhisperModel, WhisperProgress } from '@shared/types';
import { clipDuration, clipEnd, clipsOnTrack, formatTime, makeId, sourceTimeAt } from '@shared/timeline';
import { TRANSITIONS, defaultSubtitleStyle, defaultTransition } from '@shared/pano';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';
import { Section, SelectField, Slider, Toggle } from './InspectorBits';
import { TextStyleFields } from './InspectorTitle';
import { AttachFields } from './InspectorAi';
import { seekTo } from '../engine/instance';

// ---------- Übergang ----------

export function InspectorTransition({ clip }: { clip: Clip }): React.ReactElement | null {
  const setTransition = useProject((s) => s.setTransition);
  const project = useProject((s) => s.project);
  const prev = clipsOnTrack(project, clip.trackId).find((c) => c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < 1 / 30);
  const tr = clip.transition;
  if (!prev && !tr) return null;
  const maxDur = prev ? Math.max(0.2, Math.min(clipDuration(prev), clipDuration(clip), 5)) : 5;
  return (
    <Section title={t.transition.section} badge={tr ? TRANSITIONS.find((x) => x.type === tr.type)?.name : undefined}>
      {!prev && <div className="hint warn">{t.transition.needsNeighbor}</div>}
      <SelectField label={t.transition.type} value={tr?.type ?? ''} onChange={(v) => setTransition(clip.id, v ? { ...(tr ?? defaultTransition()), type: v as TransitionType } : undefined)}
        options={[{ value: '', label: t.transition.none }, ...TRANSITIONS.map((x) => ({ value: x.type, label: `${x.name} (${x.group})` }))]} />
      {tr && <Slider label={t.transition.duration} value={tr.duration} min={0.2} max={maxDur} step={0.1} unit=" s" onChange={(v) => setTransition(clip.id, { ...tr, duration: v })} />}
      <div className="hint">{t.transition.hint}</div>
    </Section>
  );
}

// ---------- Stabilisierung ----------

export function InspectorStabilize({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const setStabilize = useProject((s) => s.setStabilize);
  const st = clip.stabilize ?? { enabled: false, strength: 5, zoom: 0 };
  return (
    <Section title={t.stabilize.section} defaultOpen={st.enabled} badge={st.enabled ? 'an' : undefined}>
      <Toggle label={t.stabilize.enable} checked={st.enabled} onChange={(v) => setStabilize(clip.id, { ...st, enabled: v })} />
      {st.enabled && (
        <>
          <Slider label={t.stabilize.strength} value={st.strength} min={1} max={10} step={1} onChange={(v) => setStabilize(clip.id, { ...st, strength: v })} />
          <Slider label={t.stabilize.zoom} value={st.zoom} min={0} max={30} step={1} unit=" %" onChange={(v) => setStabilize(clip.id, { ...st, zoom: v })} />
          <div className="hint">{t.stabilize.hint}</div>
          {!media.proxyStabilized && <div className="hint warn">{t.stabilize.preparing}</div>}
        </>
      )}
    </Section>
  );
}

// ---------- Untertitel ----------

export function InspectorSubtitles({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const setSubtitles = useProject((s) => s.setSubtitles);
  const setAttach = useProject((s) => s.setAttach);
  const fps = useProject((s) => s.project.settings.fps);
  const toast = useUi((s) => s.toast);
  const [status, setStatus] = useState<{ available: boolean; models: Record<WhisperModel, boolean> } | null>(null);
  const [model, setModel] = useState<WhisperModel>('base');
  const [language, setLanguage] = useState('de');
  const [maxChars, setMaxChars] = useState(38);
  const [progress, setProgress] = useState<WhisperProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const subs = clip.subtitles;

  useEffect(() => {
    void window.panocut.whisperStatus().then(setStatus);
    return window.panocut.onWhisperProgress((p) => setProgress(p));
  }, []);

  const generate = async () => {
    setBusy(true);
    setProgress({ phase: 'extract', percent: 0, message: t.subtitles.working });
    try {
      const srcA = sourceTimeAt(clip, clip.start);
      const srcB = sourceTimeAt(clip, clipEnd(clip));
      const start = Math.min(srcA, srcB);
      const duration = Math.abs(srcB - srcA);
      const segs = await window.panocut.transcribe({ mediaPath: media.path, start, duration, language, model, maxChars });
      // Quellzeit → Clip-Zeit (Tempo berücksichtigen; Rückwärts-Clips spiegeln)
      const mapped: SubtitleSegment[] = segs.map((s) => {
        const a = clip.reverse ? (duration - s.end) / clip.speed : s.start / clip.speed;
        const b = clip.reverse ? (duration - s.start) / clip.speed : s.end / clip.speed;
        return { ...s, start: Math.max(0, a), end: Math.min(clipDuration(clip), b) };
      }).filter((s) => s.end > s.start);
      setSubtitles(clip.id, mapped, subs?.style ?? defaultSubtitleStyle(), true);
      toast(`${mapped.length} ${t.subtitles.done}`, 'success');
      void window.panocut.whisperStatus().then(setStatus);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const updateSeg = (id: string, p: Partial<SubtitleSegment>) => {
    if (!subs) return;
    setSubtitles(clip.id, subs.segments.map((s) => (s.id === id ? { ...s, ...p } : s)));
  };

  return (
    <Section title={t.subtitles.section} defaultOpen={!!subs} badge={subs ? `${subs.segments.length}` : undefined}>
      {status && !status.available && <div className="hint warn">{t.subtitles.unavailable}</div>}
      {!busy ? (
        <>
          <SelectField label={t.subtitles.model} value={model} onChange={(v) => setModel(v as WhisperModel)}
            options={[{ value: 'base', label: `Schnell (base, 142 MB)${status?.models.base ? ' ✓' : ''}` }, { value: 'small', label: `Genauer (small, 466 MB)${status?.models.small ? ' ✓' : ''}` }]} />
          <SelectField label={t.subtitles.language} value={language} onChange={setLanguage}
            options={[{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'Englisch' }, { value: 'auto', label: t.subtitles.auto }, { value: 'fr', label: 'Französisch' }, { value: 'es', label: 'Spanisch' }, { value: 'it', label: 'Italienisch' }, { value: 'tr', label: 'Türkisch' }]} />
          <Slider label={t.subtitles.maxChars} value={maxChars} min={15} max={80} step={1} onChange={setMaxChars} />
          <div className="hint">{t.subtitles.modelHint}</div>
          <button className="btn primary" onClick={() => void generate()} disabled={!status?.available || !media.info.hasAudio}>
            {subs ? t.subtitles.regenerate : t.subtitles.generate}
          </button>
        </>
      ) : (
        <div>
          <div style={{ marginBottom: 6 }}>{progress?.message ?? t.subtitles.working}</div>
          <div className="progress"><div style={{ width: `${progress?.percent ?? 0}%` }} /></div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => void window.panocut.cancelTranscribe()}>{t.subtitles.cancel}</button>
        </div>
      )}
      <div className="hint">{t.subtitles.hint}</div>
      {subs && (
        <>
          <Toggle label={t.subtitles.show} checked={subs.enabled} onChange={(v) => setSubtitles(clip.id, subs.segments, undefined, v)} />
          <div className="panel-header" style={{ padding: '6px 0 2px', border: 'none' }}>{t.subtitles.segments}</div>
          <div className="subtitle-list">
            {subs.segments.map((s) => (
              <div key={s.id} className="subtitle-row">
                <button className="btn sm ghost" title={formatTime(s.start, fps)} onClick={() => seekTo(clip.start + s.start)}>{formatTime(s.start, fps, false)}</button>
                <input type="text" value={s.text} onChange={(e) => updateSeg(s.id, { text: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} spellCheck={false} />
                <input type="number" className="num" value={Math.round(s.start * 100) / 100} step={0.1} min={0} onChange={(e) => updateSeg(s.id, { start: Math.max(0, Number(e.target.value)) })} title="Start (s)" />
                <input type="number" className="num" value={Math.round(s.end * 100) / 100} step={0.1} min={0} onChange={(e) => updateSeg(s.id, { end: Math.max(0, Number(e.target.value)) })} title="Ende (s)" />
                <button className="btn sm ghost" onClick={() => setSubtitles(clip.id, subs.segments.filter((x) => x.id !== s.id))} title={t.common.delete}>×</button>
              </div>
            ))}
            {subs.segments.length === 0 && <div className="hint">{t.subtitles.empty}</div>}
          </div>
          <div className="field-row">
            <button className="btn sm" onClick={() => {
              const last = subs.segments[subs.segments.length - 1];
              const start = last ? last.end : 0;
              setSubtitles(clip.id, [...subs.segments, { id: makeId('sub'), start, end: Math.min(clipDuration(clip), start + 2), text: 'Text' }]);
            }}>{t.subtitles.add}</button>
            <button className="btn sm danger" onClick={() => setSubtitles(clip.id, null)}>{t.subtitles.delete}</button>
          </div>
          <div className="panel-header" style={{ padding: '6px 0 2px', border: 'none' }}>{t.subtitles.style}</div>
          <TextStyleFields style={subs.style} onChange={(p) => setSubtitles(clip.id, subs.segments, p)} withAnimation={false} />
          <AttachFields clip={clip} attach={subs.attach} onChange={(a) => setAttach(clip.id, a, 'subtitles')} />
        </>
      )}
    </Section>
  );
}
