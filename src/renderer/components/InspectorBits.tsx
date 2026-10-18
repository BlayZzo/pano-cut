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
      <input
        type="number" className="num" value={Number.isInteger(step) ? Math.round(value) : Math.round(value * 100) / 100} min={min} max={max} step={step} disabled={disabled}
        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v))); }}
        title={shown}
      />
    </div>
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
