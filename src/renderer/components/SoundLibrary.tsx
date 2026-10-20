import React, { useRef, useState } from 'react';
import { DEFAULT_SFX_PARAMS, SFX, SFX_CATEGORIES, type SfxCategory, type SfxParams } from '@shared/sfx';
import { insertSfx } from '../actions';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';

let lastParams: SfxParams = { ...DEFAULT_SFX_PARAMS };
let lastCat: SfxCategory | 'all' = 'all';

/** Mediathek → „Sounds“: selbst erzeugte Sound-Effekte, nach Art sortiert. Vorhören und Einfügen nur per Knopf. */
export function SoundLibrary(): React.ReactElement {
  const [cat, setCatState] = useState<SfxCategory | 'all'>(lastCat);
  const [params, setParamsState] = useState<SfxParams>(lastParams);
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const toast = useUi((s) => s.toast);
  const setCat = (c: SfxCategory | 'all') => { lastCat = c; setCatState(c); };
  const setParams = (p: Partial<SfxParams>) => { lastParams = { ...params, ...p }; setParamsState(lastParams); };

  const preview = async (id: string) => {
    if (playing === id) { audio.current?.pause(); setPlaying(null); return; }
    try {
      setBusy(id);
      const file = await window.panocut.renderSfx(id, params);
      audio.current?.pause();
      const a = new Audio(window.panocut.toMediaUrl(file));
      a.onended = () => setPlaying(null);
      audio.current = a;
      await a.play();
      setPlaying(id);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  const insert = async (id: string, name: string) => {
    try {
      setBusy(id);
      const clip = await insertSfx(id, params);
      if (clip) toast(fmt(t.sfx.inserted, { name }), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };

  const list = SFX.filter((s) => cat === 'all' || s.category === cat);
  return (
    <div className="panel-body">
      <div className="hint" style={{ padding: '8px 10px 0' }}>{t.sfx.hint}</div>
      <div className="library-filters" style={{ flexWrap: 'wrap' }}>
        <button className={`chip${cat === 'all' ? ' active' : ''}`} onClick={() => setCat('all')}>{t.library.all}</button>
        {SFX_CATEGORIES.map((c) => <button key={c.id} className={`chip${cat === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}
      </div>
      <div style={{ padding: '0 8px 6px' }}>
        <button className={`btn sm ghost${showSettings ? ' active' : ''}`} onClick={() => setShowSettings(!showSettings)}>⚙ {t.sfx.settings}</button>
        {showSettings && (
          <div className="sfx-settings">
            <SfxSlider label={t.sfx.length} value={params.length} min={0.5} max={2} step={0.05} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => setParams({ length: v })} />
            <SfxSlider label={t.sfx.pitch} value={params.pitch} min={-12} max={12} step={1} display={(v) => `${v > 0 ? '+' : ''}${v}`} onChange={(v) => setParams({ pitch: v })} />
            <SfxSlider label={t.sfx.intensity} value={params.intensity} min={0.3} max={1.5} step={0.05} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => setParams({ intensity: v })} />
            <div className="field-row">
              <button className="btn sm" onClick={() => setParams({ seed: Math.floor(Math.random() * 1000) + 2 })}>🎲 {t.sfx.variant}</button>
              <button className="btn sm ghost" onClick={() => setParams({ ...DEFAULT_SFX_PARAMS })}>{t.sfx.reset}</button>
            </div>
          </div>
        )}
      </div>
      {SFX_CATEGORIES.filter((c) => cat === 'all' || c.id === cat).map((c) => (
        <div key={c.id} className="effect-group">
          <div className="effect-group-title">{c.name}</div>
          {list.filter((s) => s.category === c.id).map((s) => (
            <div key={s.id} className="sfx-row">
              <span className="effect-icon">{s.icon}</span>
              <span className="sfx-name">{s.name}<span className="hint"> · {(s.duration * params.length).toFixed(1).replace('.', ',')} s</span></span>
              <button className="btn sm icon ghost" title={t.sfx.preview} disabled={busy === s.id} onClick={() => void preview(s.id)}>{playing === s.id ? '■' : '▶'}</button>
              <button className="btn sm" title={t.sfx.insertHint} disabled={busy === s.id} onClick={() => void insert(s.id, s.name)}>{busy === s.id ? <span className="spinner" /> : '＋'} {t.sfx.insert}</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SfxSlider({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: (v: number) => string; onChange: (v: number) => void }): React.ReactElement {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="hint" style={{ textAlign: 'right' }}>{display(value)}</span>
    </div>
  );
}
