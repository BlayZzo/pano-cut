import React, { useEffect, useRef } from 'react';

export type MenuEntry = { sep: true } | { sep?: false; label: string; onClick: () => void; danger?: boolean; disabled?: boolean };

export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); window.removeEventListener('blur', onClose); };
  }, [onClose]);

  // Im Fenster halten
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - entries.length * 32 - 16),
  };
  return (
    <div className="context-menu" style={style} ref={ref} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((e, i) => e.sep
        ? <div className="sep" key={i} />
        : <button key={i} className={e.danger ? 'danger' : ''} disabled={e.disabled} onClick={() => { onClose(); e.onClick(); }}>{e.label}</button>)}
    </div>
  );
}
