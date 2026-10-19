import React, { useEffect, useState } from 'react';
import type { Clip, MediaItem } from '@shared/types';
import { DEFAULT_BEAT_CUT, type BeatAccent, type BeatCutMode, type BeatCutOptions } from '@shared/beatcut';
import { beatsOnTimeline } from '@shared/beats';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, SelectField, Toggle } from './InspectorBits';
import { autoCutToMusic, changeBeatTempo, detectBeats } from '../musicActions';

let lastOptions: BeatCutOptions = { ...DEFAULT_BEAT_CUT };

/** Takt erkennen, Taktmarken, Auto-Schnitt auf die Musik. */
export function InspectorMusic({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const busy = useUi((s) => s.beatJobs.includes(media.id));
  const showBeats = useUi((s) => s.showBeats);
  const setShowBeats = useUi((s) => s.setShowBeats);
  const [opts, setOpts] = useState<BeatCutOptions>(lastOptions);
  const beats = media.beats;
  const isMusic = media.type === 'audio';

  // Takt wird nur auf Knopfdruck erkannt (keine Rechenarbeit im Hintergrund)

  const update = (p: Partial<BeatCutOptions>) => {
    const next = { ...opts, ...p };
    lastOptions = next;
    setOpts(next);
  };
  const inClip = beats ? beatsOnTimeline(beats, clip).length : 0;

  return (
    <Section title={t.music.section} defaultOpen={isMusic} badge={beats && beats.bpm ? `${Math.round(beats.bpm)} BPM` : undefined}>
      {!beats && (
        <button className="btn" disabled={busy || media.status !== 'ready'} onClick={() => void detectBeats(media.id)} style={{ width: '100%' }}>
          {busy ? t.music.detecting : t.music.detect}
        </button>
      )}
      {beats && (
        <>
          <div className="field-row music-tempo">
            <span className="music-bpm">{beats.beats.length ? fmt(t.music.bpm, { bpm: beats.bpm, n: inClip }) : t.music.noBeats}</span>
            <button className="btn sm" title={t.music.halfHint} disabled={beats.beats.length < 4} onClick={() => changeBeatTempo(media.id, 0.5)}>{t.music.half}</button>
            <button className="btn sm" title={t.music.doubleHint} disabled={beats.beats.length < 2} onClick={() => changeBeatTempo(media.id, 2)}>{t.music.double}</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => void detectBeats(media.id)}>{busy ? '…' : t.music.redetect}</button>
          </div>
          <Toggle label={t.music.show} checked={showBeats} onChange={setShowBeats} />
          <div className="music-auto">
            <div className="music-auto-title">{t.music.autoTitle}</div>
            <div className="hint">{t.music.autoHint}</div>
            <SelectField
              label={t.music.mode} value={opts.mode}
              options={[
                { value: 'beat', label: t.music.modeBeat },
                { value: 'beat2', label: t.music.modeBeat2 },
                { value: 'bar', label: t.music.modeBar },
                { value: 'energy', label: t.music.modeEnergy },
              ]}
              onChange={(v) => update({ mode: v as BeatCutMode })}
            />
            <SelectField
              label={t.music.accent} value={opts.accent}
              options={[
                { value: 'none', label: t.music.accentNone },
                { value: 'zoom', label: t.music.accentZoom },
                { value: 'shake', label: t.music.accentShake },
                { value: 'flash', label: t.music.accentFlash },
              ]}
              onChange={(v) => update({ accent: v as BeatAccent })}
            />
            {opts.accent !== 'none' && (
              <div className="field">
                <label>{t.music.strength}</label>
                <input type="range" min={0.2} max={2} step={0.1} value={opts.strength} onChange={(e) => update({ strength: parseFloat(e.target.value) })} />
                <span className="num-label">{Math.round(opts.strength * 100)} %</span>
              </div>
            )}
            <Toggle label={t.music.fill} checked={opts.fill} onChange={(v) => update({ fill: v })} />
            <button className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={beats.beats.length === 0} onClick={() => autoCutToMusic(clip.id, opts)}>
              {t.music.run}
            </button>
          </div>
        </>
      )}
    </Section>
  );
}
