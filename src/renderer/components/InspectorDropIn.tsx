import React, { useState } from 'react';
import type { Clip } from '@shared/types';
import type { EntranceStyle } from '@shared/effects';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';
import { Section, SelectField, Toggle } from './InspectorBits';
import { dropObjectIn } from '../vfx/actions';

let last = { style: 'dropin' as EntranceStyle, strength: 1, dust: true, shake: true, sound: '' };

/** Freigestelltes Objekt mit Effekt ins Video fallen lassen. */
export function InspectorDropIn({ clip }: { clip: Clip }): React.ReactElement {
  const [o, setO] = useState(last);
  const [busy, setBusy] = useState<string | null>(null);
  const upd = (p: Partial<typeof o>) => { const n = { ...o, ...p }; last = n; setO(n); };
  const hasImpact = o.style === 'dropin' || o.style === 'slam';
  const apply = async () => {
    setBusy(t.dropIn.working);
    try {
      await dropObjectIn(clip.id, { ...o, dust: o.dust && hasImpact }, (pct) => setBusy(`${t.dropIn.working} ${pct} %`));
    } catch (e) {
      useUi.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title={t.dropIn.section} defaultOpen={false}>
      <SelectField label={t.dropIn.style} value={o.style} onChange={(v) => upd({ style: v as EntranceStyle })} options={[
        { value: 'dropin', label: t.dropIn.styleDrop },
        { value: 'slam', label: t.dropIn.styleSlam },
        { value: 'flyin-left', label: t.dropIn.styleLeft },
        { value: 'flyin-right', label: t.dropIn.styleRight },
        { value: 'rise', label: t.dropIn.styleRise },
      ]} />
      <div className="field">
        <label>{t.dropIn.strength}</label>
        <input type="range" min={0.3} max={2} step={0.05} value={o.strength} onChange={(e) => upd({ strength: parseFloat(e.target.value) })} />
        <span className="num-label">{Math.round(o.strength * 100)} %</span>
      </div>
      {hasImpact && <Toggle label={t.dropIn.dust} checked={o.dust} onChange={(v) => upd({ dust: v })} />}
      <Toggle label={t.dropIn.shake} checked={o.shake} onChange={(v) => upd({ shake: v })} />
      <SelectField label={t.dropIn.sound} value={o.sound} onChange={(v) => upd({ sound: v })} options={[
        { value: '', label: t.dropIn.soundNone },
        ...(hasImpact
          ? [{ value: 'boom', label: 'Boom (Bass-Einschlag)' }, { value: 'hit', label: 'Schlag' }, { value: 'crack', label: 'Knall' }, { value: 'metal', label: 'Metall-Klirren' }]
          : [{ value: 'whoosh', label: 'Whoosh' }, { value: 'passby', label: 'Vorbeifahrt (Auto)' }, { value: 'swoosh-deep', label: 'Tiefer Swoosh' }]),
      ]} />
      <button className="btn primary" style={{ width: '100%' }} disabled={!!busy} onClick={() => void apply()}>{busy ?? t.dropIn.apply}</button>
      <div className="hint">{t.dropIn.hint}</div>
    </Section>
  );
}
