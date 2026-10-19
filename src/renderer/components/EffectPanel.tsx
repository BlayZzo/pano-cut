// Effekt-Studio über der Vorschau: Effekt beschreiben → verstehen → simulieren → als Ebene einfügen.
import React, { useEffect, useMemo, useState } from 'react';
import type { VfxKind } from '@shared/types';
import { VFX_KINDS, defaultVfx, parseVfxPrompt } from '@shared/vfx';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';
import { generateEffects } from '../vfx/actions';
import { cancelVfx } from '../vfx/render';
import { IconClose } from './Icons';

const EXAMPLES = ['große Explosion mit viel Rauch', 'Lagerfeuer', 'Rauch steigt auf', 'leichter Schneefall von links', 'starker Regen', 'Gewitter', 'dichter Nebel', 'Funken', 'Sandsturm', 'Konfetti'];

export function EffectPanel(): React.ReactElement | null {
  const open = useUi((s) => s.vfxPanel);
  const setOpen = useUi((s) => s.setVfxPanel);
  const toast = useUi((s) => s.toast);
  const settings = useProject((s) => s.project.settings);
  const [prompt, setPrompt] = useState('');
  const [quick, setQuick] = useState<VfxKind | null>(null);
  const [matchScene, setMatchScene] = useState(true);
  const [light, setLight] = useState(true);
  const [shake, setShake] = useState(true);
  const [busy, setBusy] = useState<{ percent: number; message: string } | null>(null);
  const preset = useUi((s) => s.vfxPreset);
  useEffect(() => { if (open && preset) { setQuick(preset as VfxKind); setPrompt(''); } }, [open, preset]);

  const parsed = useMemo(() => {
    if (quick && !prompt.trim()) {
      const s = defaultVfx(quick, settings.width, settings.height, settings.fps, VFX_KINDS.find((k) => k.kind === quick)!.name);
      return { specs: [s], understood: [VFX_KINDS.find((k) => k.kind === quick)!.name] };
    }
    return parseVfxPrompt(prompt, settings.width, settings.height, settings.fps);
  }, [prompt, quick, settings.width, settings.height, settings.fps]);

  if (!open) return null;
  const hasExplosion = parsed.specs.some((s) => s.kind === 'explosion');
  const hasLight = parsed.specs.some((s) => VFX_KINDS.find((k) => k.kind === s.kind)?.light);

  const generate = async () => {
    if (parsed.specs.length === 0) return;
    setBusy({ percent: 0, message: t.vfx.generating });
    try {
      await generateEffects(parsed.specs, { matchScene, light, shake }, (percent, message) => setBusy({ percent, message }));
      toast(t.vfx.done, 'success');
      setPrompt('');
      setQuick(null);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== 'Abgebrochen') toast(msg, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ai-panel vfx-panel">
      <div className="ai-panel-header">
        <strong>✦ {t.vfx.title}</strong>
        <div className="spacer" />
        <button className="btn icon ghost sm" onClick={() => setOpen(false)} disabled={!!busy}><IconClose /></button>
      </div>
      {busy ? (
        <div>
          <div className="hint">{busy.message}</div>
          <div className="progress"><div style={{ width: `${busy.percent}%` }} /></div>
          <button className="btn sm" style={{ marginTop: 6 }} onClick={cancelVfx}>{t.vfx.cancel}</button>
        </div>
      ) : (
        <>
          <label className="hint" htmlFor="vfx-prompt">{t.vfx.describe}</label>
          <textarea id="vfx-prompt" className="vfx-prompt" rows={2} value={prompt} placeholder={t.vfx.placeholder} spellCheck={false}
            onChange={(e) => { setPrompt(e.target.value); setQuick(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void generate(); } }} />
          <div className="vfx-chips">
            {EXAMPLES.map((ex) => <button key={ex} className="chip" onClick={() => { setPrompt(ex); setQuick(null); }}>{ex}</button>)}
          </div>
          {(prompt.trim() || quick) && (
            parsed.specs.length > 0
              ? <div className="vfx-understood"><span className="hint">{t.vfx.understood}:</span> {parsed.understood.join(' · ')}</div>
              : <div className="hint warn">{t.vfx.notUnderstood}</div>
          )}
          <div className="hint">{t.vfx.quick}</div>
          <div className="vfx-kinds">
            {VFX_KINDS.map((k) => (
              <button key={k.kind} className={`vfx-kind${quick === k.kind && !prompt.trim() ? ' active' : ''}`} title={k.name} onClick={() => { setQuick(k.kind); setPrompt(''); }}>
                <span className="effect-icon">{k.icon}</span><span>{k.name}</span>
              </button>
            ))}
          </div>
          <label className="toggle"><input type="checkbox" checked={matchScene} onChange={(e) => setMatchScene(e.target.checked)} /> {t.vfx.matchScene}</label>
          {hasLight && <label className="toggle"><input type="checkbox" checked={light} onChange={(e) => setLight(e.target.checked)} /> {t.vfx.light}</label>}
          {hasExplosion && <label className="toggle"><input type="checkbox" checked={shake} onChange={(e) => setShake(e.target.checked)} /> {t.vfx.shake}</label>}
          <button className="btn primary" onClick={() => void generate()} disabled={parsed.specs.length === 0}>{t.vfx.generate}</button>
          <div className="hint">{t.vfx.hint}</div>
        </>
      )}
    </div>
  );
}
