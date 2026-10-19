import React, { useEffect, useRef, useState } from 'react';

/** Kleiner Knopf mit aufklappendem Einstellungs-Fenster (schließt bei Klick daneben oder Esc). */
export function Popover({ label, title, children, align = 'left', up = false }: { label: React.ReactNode; title?: string; children: React.ReactNode; align?: 'left' | 'right'; up?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref}>
      <button className={`btn sm ghost${open ? ' active' : ''}`} onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <div className={`popover ${align}${up ? ' up' : ''}`}>
          {title && <div className="popover-title">{title}</div>}
          {children}
        </div>
      )}
    </div>
  );
}
