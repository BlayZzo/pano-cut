import React, { useState } from 'react';
import { beginTransaction, endTransaction } from '../store/project';
import { t } from '../i18n/de';
import { IconChevron } from './Icons';

export function Section({ title, children, defaultOpen = true, onReset, badge }: { title: string; children: React.ReactNode; defaultOpen?: boolean; onReset?: () => void; badge?: string }): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  // Aufklappen, wenn der Abschnitt nachträglich Inhalt bekommt (z. B. erstes erkanntes Objekt)
  const wasDefault = React.useRef(defaultOpen);
  React.useEffect(() => {
    if (defaultOpen && !wasDefault.current) setOpen(true);
    wasDefault.current = defaultOpen;
  }, [defaultOpen]);
  return (
    <div className="section">
      <div className="section-title" onClick={() => setOpen(!open)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconChevron open={open} /> {title}{badge && <span className="pill">{badge}</span>}</span>
        {onReset && open && <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); onReset(); }}>{t.inspector.reset}</button>}
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  display?: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}

export function Slider({ label, value, min, max, step, unit = '', display, onChange, disabled }: SliderProps): React.ReactElement {
  const shown = display ? display(value) : `${Number.isInteger(step) ? value : value.toFixed(2)}${unit}`;
  return (
    <div className="field">
      <label title={label}>{label}</label>
      <input
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onPointerDown={beginTransaction}
        onPointerUp={endTransaction}
        onKeyDown={beginTransaction}
        onKeyUp={endTransaction}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => onChange(min < 0 && max > 0 ? 0 : (min === 0 && max >= 1 && step < 1 ? 1 : min))}
      />
      <NumInput value={value} min={min} max={max} step={step} disabled={disabled} title={shown} onChange={onChange} />
    </div>
  );
}

/** Zahl eintippen (auch mit Komma, z. B. „1,5“); übernommen bei Enter oder beim Verlassen. Pfeiltasten = Schritt, ⇧ = ×10. */
export function NumInput({ value, min, max, step, onChange, disabled, title, className = 'num' }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; disabled?: boolean; title?: string; className?: string }): React.ReactElement {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const fmt = (v: number) => (Math.round(v * 10 ** digits) / 10 ** digits).toString().replace('.', ',');
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = (text: string) => {
    const v = parseFloat(text.replace(',', '.').replace(/[^0-9.+-]/g, ''));
    if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
    setDraft(null);
  };
  return (
    <input
      type="text" inputMode="decimal" className={className} disabled={disabled} title={title}
      value={draft ?? fmt(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          onChange(Math.min(max, Math.max(min, Math.round((value + d) / step) * step)));
          setDraft(null);
        }
      }}
    />
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): React.ReactElement {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function SelectField({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }): React.ReactElement {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ gridColumn: '2 / span 2' }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
