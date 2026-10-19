import React, { useEffect, useRef, useState } from 'react';

/** Kleiner Knopf mit aufklappendem Einstellungs-Fenster (schließt bei Klick daneben oder Esc). */
export function Popover({ label, title, children, align = 'left', up = false }: { label: React.ReactNode; title?: string; children: React.ReactNode; align?: 'left' | 'right'; up?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const toggle = () => {
    if (!open && ref.current) {
      // Fest am Fenster ausrichten, damit nichts abgeschnitten wird
      const r = ref.current.getBoundingClientRect();
      const p: React.CSSProperties = {};
      if (align === 'right') p.right = Math.max(8, window.innerWidth - r.right); else p.left = Math.max(8, Math.min(r.left, window.innerWidth - 330));
      if (up || r.bottom > window.innerHeight * 0.55) p.bottom = window.innerHeight - r.top + 6; else p.top = r.bottom + 6;
      p.maxHeight = (p.top !== undefined ? window.innerHeight - (p.top as number) : r.top) - 16;
      setPos(p);
    }
    setOpen(!open);
  };
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
      <button className={`btn sm ghost${open ? ' active' : ''}`} onClick={toggle}>{label}</button>
      {open && (
        <div className="popover" style={pos}>
          {title && <div className="popover-title">{title}</div>}
          {children}
        </div>
      )}
    </div>
  );
}
