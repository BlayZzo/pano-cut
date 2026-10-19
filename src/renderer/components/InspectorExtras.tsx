import React, { useEffect, useState } from 'react';
import type { Clip, MediaItem, SubtitleSegment, TransitionType, WhisperModel, WhisperProgress } from '@shared/types';
import { clipDuration, clipEnd, clipsOnTrack, formatTime, makeId, sourceTimeAt } from '@shared/timeline';
import { TRANSITIONS, defaultSubtitleStyle, defaultTransition } from '@shared/pano';
import { isDynamicTransition } from '@shared/transitions';
import { DEFAULT_TRANSLATION_COLOR, SUBTITLE_PRESETS } from '@shared/subtitles';
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
      <SelectField label={t.transition.type} value={tr?.type ?? ''} onChange={(v) => {
        if (!v) { setTransition(clip.id, undefined); return; }
        const def = defaultTransition(v as TransitionType);
        // Beim Wechsel zwischen normalen und dynamischen Übergängen die passende Standard-Dauer nehmen
        const keepDur = tr && isDynamicTransition(tr.type) === isDynamicTransition(def.type);
        setTransition(clip.id, { ...def, duration: keepDur ? tr!.duration : def.duration, intensity: tr?.intensity ?? def.intensity });
      }}
        options={[{ value: '', label: t.transition.none }, ...TRANSITIONS.map((x) => ({ value: x.type, label: `${x.name} (${x.group})` }))]} />
      {tr && <Slider label={t.transition.duration} value={tr.duration} min={0.2} max={maxDur} step={0.1} unit=" s" onChange={(v) => setTransition(clip.id, { ...tr, duration: v })} />}
      {tr && isDynamicTransition(tr.type) && (
        <Slider label={t.transition.intensity} value={tr.intensity ?? 1} min={0.1} max={2} step={0.05} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => setTransition(clip.id, { ...tr, intensity: v })} />
      )}
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

type ShowMode = 'original' | 'both' | 'translation';
let lastSubSettings: { spoken: 'de' | 'en' | 'auto'; show: ShowMode; preset: string; model: WhisperModel } = { spoken: 'de', show: 'both', preset: 'social', model: 'base' };

export function InspectorSubtitles({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const setSubtitles = useProject((s) => s.setSubtitles);
  const setAttach = useProject((s) => s.setAttach);
  const setSubtitleOptions = useProject((s) => s.setSubtitleOptions);
  const fps = useProject((s) => s.project.settings.fps);
  const toast = useUi((s) => s.toast);
  const [status, setStatus] = useState<{ available: boolean; models: Record<WhisperModel, boolean> } | null>(null);
  const [opts, setOpts] = useState(lastSubSettings);
  const [progress, setProgress] = useState<WhisperProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);
  const subs = clip.subtitles;
  const upd = (p: Partial<typeof opts>) => { const n = { ...opts, ...p }; lastSubSettings = n; setOpts(n); };
  const preset = SUBTITLE_PRESETS.find((x) => x.id === opts.preset) ?? SUBTITLE_PRESETS[0];

  useEffect(() => {
    void window.panocut.whisperStatus().then(setStatus);
    return window.panocut.onWhisperProgress((p) => setProgress(p));
  }, []);

  const other = (l: 'de' | 'en'): 'de' | 'en' => (l === 'de' ? 'en' : 'de');

  /** Übersetzung (Deutsch ↔ Englisch) für alle Zeilen. */
  const translateSegments = async (segments: SubtitleSegment[], spoken: 'de' | 'en'): Promise<SubtitleSegment[]> => {
    setProgress({ phase: 'translate', percent: 0, message: t.subtitles.translating });
    const texts = await window.panocut.translateLocal(segments.map((x) => x.text), spoken, other(spoken));
    return segments.map((x, i) => ({ ...x, translation: texts[i] || x.translation }));
  };

  const generate = async () => {
    setBusy(true);
    setProgress({ phase: 'extract', percent: 0, message: t.subtitles.working });
    try {
      const srcA = sourceTimeAt(clip, clip.start);
      const srcB = sourceTimeAt(clip, clipEnd(clip));
      const start = Math.min(srcA, srcB);
      const duration = Math.abs(srcB - srcA);
      const res = await window.panocut.transcribe({ mediaPath: media.path, start, duration, language: opts.spoken, model: opts.model, maxChars: preset.maxChars });
      // Quellzeit → Clip-Zeit (Tempo berücksichtigen; Rückwärts-Clips spiegeln)
      const map = (a: number, b: number) => clip.reverse
        ? { start: Math.max(0, (duration - b) / clip.speed), end: Math.min(clipDuration(clip), (duration - a) / clip.speed) }
        : { start: Math.max(0, a / clip.speed), end: Math.min(clipDuration(clip), b / clip.speed) };
      let mapped: SubtitleSegment[] = res.segments.map((s) => {
        const r = map(s.start, s.end);
        const words = s.words?.map((w) => ({ ...w, ...map(w.start, w.end) }));
        return { ...s, ...r, words: clip.reverse ? undefined : words };
      }).filter((s) => s.end > s.start);
      const lang = res.language === 'de' || res.language === 'en' ? res.language : null;
      if (opts.show !== 'original' && lang && mapped.length) mapped = await translateSegments(mapped, lang);
      else if (opts.show !== 'original' && !lang) toast(t.subtitles.otherLanguage, 'info');
      setSubtitles(clip.id, mapped, { ...(subs?.style ?? defaultSubtitleStyle()), ...preset.style }, true);
      setSubtitleOptions(clip.id, {
        spoken: lang ?? undefined, showTranslation: opts.show !== 'original' && !!lang, translationOnly: opts.show === 'translation' && !!lang,
        highlight: preset.highlight || undefined, chunk: preset.chunk, uppercase: preset.uppercase,
      });
      toast(`${mapped.length} ${t.subtitles.done}`, 'success');
      void window.panocut.whisperStatus().then(setStatus);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const retranslate = async () => {
    if (!subs?.segments.length) return;
    const spoken = subs.spoken ?? (opts.spoken === 'auto' ? 'de' : opts.spoken);
    setBusy(true);
    try {
      setSubtitles(clip.id, await translateSegments(subs.segments, spoken));
      setSubtitleOptions(clip.id, { spoken, showTranslation: true });
      toast(t.subtitles.translated, 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const applyPreset = (id: string) => {
    upd({ preset: id });
    const p = SUBTITLE_PRESETS.find((x) => x.id === id);
    if (!p || !subs) return;
    beginTransaction();
    setSubtitles(clip.id, subs.segments, { ...subs.style, ...p.style });
    setSubtitleOptions(clip.id, { highlight: p.highlight || undefined, chunk: p.chunk, uppercase: p.uppercase });
    endTransaction();
  };

  const updateSeg = (id: string, p: Partial<SubtitleSegment>) => {
    if (!subs) return;
    setSubtitles(clip.id, subs.segments.map((s) => (s.id === id ? { ...s, ...p } : s)));
  };
  const showMode: ShowMode = !subs?.showTranslation ? 'original' : subs.translationOnly ? 'translation' : 'both';

  return (
    <Section title={t.subtitles.section} defaultOpen={!!subs} badge={subs ? `${subs.segments.length}` : undefined}>
      {status && !status.available && <div className="hint warn">{t.subtitles.unavailable}</div>}
      {!busy ? (
        <>
          <SelectField label={t.subtitles.spoken} value={opts.spoken} onChange={(v) => upd({ spoken: v as typeof opts.spoken })}
            options={[{ value: 'de', label: t.subtitles.spokenDe }, { value: 'en', label: t.subtitles.spokenEn }, { value: 'auto', label: t.subtitles.spokenAuto }]} />
          <SelectField label={t.subtitles.show2} value={opts.show} onChange={(v) => upd({ show: v as ShowMode })}
            options={[{ value: 'both', label: t.subtitles.showBoth }, { value: 'original', label: t.subtitles.showOriginal }, { value: 'translation', label: t.subtitles.showTranslationOnly }]} />
          <SelectField label={t.subtitles.look} value={opts.preset} onChange={applyPreset} options={SUBTITLE_PRESETS.map((p) => ({ value: p.id, label: p.name }))} />
          <SelectField label={t.subtitles.accuracy} value={opts.model} onChange={(v) => upd({ model: v as WhisperModel })}
            options={[{ value: 'base', label: `${t.subtitles.fast}${status?.models.base ? ' ✓' : ''}` }, { value: 'small', label: `${t.subtitles.exact}${status?.models.small ? ' ✓' : ''}` }]} />
          <button className="btn primary" onClick={() => void generate()} disabled={!status?.available || !media.info.hasAudio}>
            ✦ {subs ? t.subtitles.regenerate : t.subtitles.generate}
          </button>
          <div className="hint">{t.subtitles.socialHint} {opts.show !== 'original' ? t.subtitles.translateHint : ''}</div>
        </>
      ) : (
        <div>
          <div style={{ marginBottom: 6 }}>{progress?.message ?? t.subtitles.working}</div>
          <div className="progress"><div style={{ width: `${progress?.percent ?? 0}%` }} /></div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => void window.panocut.cancelTranscribe()}>{t.subtitles.cancel}</button>
        </div>
      )}
      {subs && (
        <>
          <Toggle label={t.subtitles.show} checked={subs.enabled} onChange={(v) => setSubtitles(clip.id, subs.segments, undefined, v)} />
          <SelectField label={t.subtitles.show2} value={showMode} onChange={(v) => setSubtitleOptions(clip.id, { showTranslation: v !== 'original', translationOnly: v === 'translation' })}
            options={[{ value: 'both', label: t.subtitles.showBoth }, { value: 'original', label: t.subtitles.showOriginal }, { value: 'translation', label: t.subtitles.showTranslationOnly }]} />
          <div className="panel-header" style={{ padding: '6px 0 2px', border: 'none' }}>{t.subtitles.segments}</div>
          <div className="subtitle-list">
            {subs.segments.map((s) => (
              <div key={s.id} className="subtitle-row">
                <button className="btn sm ghost" title={formatTime(s.start, fps)} onClick={() => seekTo(clip.start + s.start)}>{formatTime(s.start, fps, false)}</button>
                <input type="text" value={s.text} onChange={(e) => updateSeg(s.id, { text: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} spellCheck={false} />
                <input type="number" className="num" value={Math.round(s.start * 100) / 100} step={0.1} min={0} onChange={(e) => updateSeg(s.id, { start: Math.max(0, Number(e.target.value)), words: undefined })} title="Start (s)" />
                <input type="number" className="num" value={Math.round(s.end * 100) / 100} step={0.1} min={0} onChange={(e) => updateSeg(s.id, { end: Math.max(0, Number(e.target.value)), words: undefined })} title="Ende (s)" />
                <button className="btn sm ghost" onClick={() => setSubtitles(clip.id, subs.segments.filter((x) => x.id !== s.id))} title={t.common.delete}>×</button>
                {subs.showTranslation && (
                  <input type="text" className="subtitle-translation" placeholder={t.subtitles.translationPlaceholder} value={s.translation ?? ''} onChange={(e) => updateSeg(s.id, { translation: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} spellCheck={false} />
                )}
              </div>
            ))}
            {subs.segments.length === 0 && <div className="hint">{t.subtitles.empty}</div>}
          </div>
          <div className="field-row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => {
              const last = subs.segments[subs.segments.length - 1];
              const start = last ? last.end : 0;
              setSubtitles(clip.id, [...subs.segments, { id: makeId('sub'), start, end: Math.min(clipDuration(clip), start + 2), text: 'Text' }]);
            }}>{t.subtitles.add}</button>
            {subs.showTranslation && <button className="btn sm" title={t.subtitles.retranslateHint} disabled={busy} onClick={() => void retranslate()}>{t.subtitles.retranslate}</button>}
            <button className="btn sm danger" onClick={() => setSubtitles(clip.id, null)}>{t.subtitles.delete}</button>
          </div>
          <Toggle label={t.subtitles.highlight} checked={!!subs.highlight} onChange={(v) => setSubtitleOptions(clip.id, { highlight: v ? '#ffd400' : undefined })} />
          {subs.highlight && (
            <div className="field">
              <label>{t.subtitles.highlightColor}</label>
              <input type="color" value={subs.highlight} onChange={(e) => setSubtitleOptions(clip.id, { highlight: e.target.value })} style={{ gridColumn: '2 / span 2' }} />
            </div>
          )}
          <SelectField label={t.subtitles.chunk} value={String(subs.chunk ?? 0)} onChange={(v) => setSubtitleOptions(clip.id, { chunk: Number(v) })}
            options={[{ value: '0', label: t.subtitles.chunkAll }, { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }]} />
          <Toggle label={t.subtitles.uppercase} checked={!!subs.uppercase} onChange={(v) => setSubtitleOptions(clip.id, { uppercase: v })} />
          {subs.showTranslation && !subs.translationOnly && (
            <div className="field">
              <label>{t.subtitles.translationColor}</label>
              <input type="color" value={subs.translationColor ?? DEFAULT_TRANSLATION_COLOR} onChange={(e) => setSubtitleOptions(clip.id, { translationColor: e.target.value })} style={{ gridColumn: '2 / span 2' }} />
            </div>
          )}
          <button className="btn sm ghost" onClick={() => setCustom(!custom)}>{custom ? '▾' : '▸'} {t.subtitles.customize}</button>
          {custom && <TextStyleFields style={subs.style} onChange={(p) => setSubtitles(clip.id, subs.segments, p)} withAnimation={false} />}
          <AttachFields clip={clip} attach={subs.attach} onChange={(a) => setAttach(clip.id, a, 'subtitles')} />
        </>
      )}
    </Section>
  );
}
