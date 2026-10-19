import React, { useRef } from 'react';
import { getView, updateView } from '../store/ui';
import type { ViewSettings } from '@shared/types';
import { t } from '../i18n/de';

type Key = 'leftWidth' | 'rightWidth' | 'timelineHeight';

const LIMITS: Record<Key, { min: number; max: () => number; hide: number; reset: number }> = {
  leftWidth: { min: 180, max: () => Math.max(220, window.innerWidth * 0.45), hide: 110, reset: 300 },
  rightWidth: { min: 240, max: () => Math.max(260, window.innerWidth * 0.45), hide: 140, reset: 300 },
  timelineHeight: { min: 130, max: () => Math.max(160, window.innerHeight - 260), hide: -1, reset: 300 },
};

/**
 * Trennlinie zum Ziehen: ändert die Breite der Mediathek / des Inspektors bzw. die Höhe der Timeline.
 * Ganz zusammenschieben blendet die Seitenleiste aus, Doppelklick stellt die Standardgröße wieder her.
 */
export function Splitter({ which }: { which: Key }): React.ReactElement {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const vertical = which !== 'timelineHeight';
  const lim = LIMITS[which];

  const sizeFor = (clientX: number, clientY: number): number => {
    const s = start.current!;
    const d = vertical ? clientX - s.pos : clientY - s.pos;
    // links: nach rechts ziehen = breiter; rechts/Timeline: nach links/oben ziehen = größer
    let size = which === 'leftWidth' ? s.size + d : s.size - d;
    if (lim.hide > 0 && size < lim.hide) return 0;
    size = Math.max(lim.min, Math.min(lim.max(), size));
    return Math.round(size);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const view: ViewSettings = getView();
    start.current = { pos: vertical ? e.clientX : e.clientY, size: view[which] || (lim.hide > 0 ? lim.hide : lim.min) };
    if (view[which] === 0) start.current.size = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add(vertical ? 'resizing-x' : 'resizing-y');
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    updateView({ [which]: sizeFor(e.clientX, e.clientY) }, false);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    updateView({ [which]: sizeFor(e.clientX, e.clientY) });
    start.current = null;
    document.body.classList.remove('resizing-x', 'resizing-y');
  };

  return (
    <div
      className={`splitter ${vertical ? 'splitter-x' : 'splitter-y'}`}
      title={t.view.splitterHint}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => updateView({ [which]: lim.reset })}
    />
  );
}
