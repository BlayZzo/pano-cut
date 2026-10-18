import React from 'react';
import type { Clip, TitleAnimation, TitleStyle } from '@shared/types';
import { FONTS, TITLE_TEMPLATES, defaultTitle } from '@shared/pano';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { t } from '../i18n/de';
import { Section, SelectField, Slider, Toggle } from './InspectorBits';

/** Gemeinsame Stil-Felder für Titel und Untertitel. */
export function TextStyleFields({ style, onChange, withAnimation }: { style: Omit<TitleStyle, 'text'>; onChange: (p: Partial<Omit<TitleStyle, 'text'>>) => void; withAnimation: boolean }): React.ReactElement {
  return (
    <>
      <SelectField label={t.title.font} value={style.font} onChange={(v) => onChange({ font: v })} options={FONTS.map((f) => ({ value: f.key, label: f.name }))} />
      <Slider label={t.title.size} value={style.size} min={2} max={30} step={0.5} unit=" %" onChange={(v) => onChange({ size: v })} />
      <div className="field">
        <label>{t.title.color}</label>
        <input type="color" value={style.color} onChange={(e) => onChange({ color: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} />
        <Toggle label={t.title.bold} checked={style.bold} onChange={(v) => onChange({ bold: v })} />
      </div>
      <SelectField label={t.title.align} value={style.align} onChange={(v) => onChange({ align: v as TitleStyle['align'] })}
        options={[{ value: 'left', label: t.title.alignLeft }, { value: 'center', label: t.title.alignCenter }, { value: 'right', label: t.title.alignRight }]} />
      <Slider label={t.title.x} value={style.x} min={0} max={100} step={0.5} unit=" %" onChange={(v) => onChange({ x: v })} />
      <Slider label={t.title.y} value={style.y} min={0} max={100} step={0.5} unit=" %" onChange={(v) => onChange({ y: v })} />
      <div className="field">
        <label>{t.title.background}</label>
        <div className="field-row">
          <input type="checkbox" checked={!!style.background} onChange={(e) => onChange({ background: e.target.checked ? '#000000' : '' })} />
          <input type="color" value={style.background || '#000000'} disabled={!style.background} onChange={(e) => onChange({ background: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} />
        </div>
      </div>
      {style.background && <Slider label={t.title.backgroundOpacity} value={style.backgroundOpacity} min={0} max={1} step={0.05} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => onChange({ backgroundOpacity: v })} />}
      <div className="field-row">
        <Toggle label={t.title.shadow} checked={style.shadow} onChange={(v) => onChange({ shadow: v })} />
        <Toggle label={t.title.outline} checked={style.outline} onChange={(v) => onChange({ outline: v })} />
      </div>
      {withAnimation && (
        <SelectField label={t.title.animation} value={style.animation} onChange={(v) => onChange({ animation: v as TitleAnimation })}
          options={[{ value: 'none', label: t.title.animNone }, { value: 'fade', label: t.title.animFade }, { value: 'slideup', label: t.title.animSlide }, { value: 'typewriter', label: t.title.animTypewriter }]} />
      )}
    </>
  );
}

export function InspectorTitle({ clip }: { clip: Clip }): React.ReactElement {
  const updateClip = useProject((s) => s.updateClip);
  const title = clip.title ?? defaultTitle();
  const patch = (p: Partial<TitleStyle>) => updateClip(clip.id, { title: { ...title, ...p }, ...(p.text !== undefined ? { name: p.text.split('\n')[0] || 'Titel' } : {}) });
  return (
    <Section title={t.title.section} onReset={() => updateClip(clip.id, { title: { ...defaultTitle(title.text) } })}>
      <div className="field-full">
        <label>{t.title.text}</label>
        <textarea value={title.text} rows={3} onChange={(e) => patch({ text: e.target.value })} onFocus={beginTransaction} onBlur={endTransaction} spellCheck={false} style={{ height: 'auto', resize: 'vertical' }} />
      </div>
      <div className="field">
        <label>{t.title.template}</label>
        <select value="" onChange={(e) => { const tpl = TITLE_TEMPLATES.find((x) => x.id === e.target.value); if (tpl) patch({ ...tpl.style, text: title.text }); }} style={{ gridColumn: '2 / span 2' }}>
          <option value="">…</option>
          {TITLE_TEMPLATES.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
        </select>
      </div>
      <TextStyleFields style={title} onChange={(p) => patch(p)} withAnimation />
    </Section>
  );
}
