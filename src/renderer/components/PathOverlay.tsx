// Bewegungspfad in der Vorschau: Start-, Zwischen- und Endpunkte setzen und verschieben (Clip-Animation x/y).
// Klick ins Bild = Punkt zur aktuellen Zeit, Punkt ziehen = verschieben, Doppelklick auf Punkt = löschen.
import React from 'react';
import type { Clip, Motion, MotionKeyframe } from '@shared/types';
import { motionAt } from '@shared/effects';
import { clipDuration } from '@shared/timeline';
import { beginTransaction, endTransaction, setDirty, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { seekTo } from '../engine/instance';
import { t } from '../i18n/de';

export function emptyMotion(): Motion {
  return { preset: 'custom', intensity: 1, smooth: true, curve: true, keyframes: [] };
}

/** Punkt zur Clip-Zeit `local` setzen/ersetzen (Größe/Drehung/Deckkraft bleiben wie an dieser Stelle). */
export function upsertPathPoint(m: Motion, local: number, x: number, y: number, fps: number): Motion {
  const cur = motionAt(m, local);
  const tol = 0.5 / Math.max(1, fps);
  const keys = m.keyframes.filter((k) => Math.abs(k.t - local) > tol);
  const k: MotionKeyframe = { t: Math.round(local * 1000) / 1000, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, scale: cur.scale, rotation: cur.rotation, opacity: cur.opacity };
  return { ...m, preset: 'custom', keyframes: [...keys, k].sort((a, b) => a.t - b.t) };
}

export function PathOverlay({ clip, canvas }: { clip: Clip; canvas: HTMLCanvasElement }): React.ReactElement | null {
  const playhead = useUi((s) => s.playhead);
  const fps = useProject((s) => s.project.settings.fps);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return null;
  const m = clip.motion ?? emptyMotion();
  const tr = clip.transform;
  const dur = clipDuration(clip);
  const local = Math.max(0, Math.min(dur, playhead - clip.start));
  const toPx = (x: number, y: number) => ({ px: W / 2 + ((tr.x + x) / 100) * W, py: H / 2 + ((tr.y + y) / 100) * H });
  const fromPx = (px: number, py: number) => ({ x: ((px - W / 2) / W) * 100 - tr.x, y: ((py - H / 2) / H) * 100 - tr.y });
  const keys = m.keyframes;
  // Pfad abtasten (zeigt auch die Kurve)
  const pts: string[] = [];
  if (keys.length > 1) {
    const a = keys[0].t, b = keys[keys.length - 1].t;
    for (let i = 0; i <= 80; i++) { const s = motionAt({ ...m, osc: undefined }, a + ((b - a) * i) / 80); const p = toPx(s.x, s.y); pts.push(`${p.px.toFixed(1)},${p.py.toFixed(1)}`); }
  }
  const now = motionAt({ ...m, osc: undefined }, local);
  const nowP = toPx(now.x, now.y);
  const tol = 0.5 / Math.max(1, fps);
  const write = (next: Motion) => useProject.getState().updateClip(clip.id, { motion: next });

  const rel = (e: { clientX: number; clientY: number }, el: Element) => {
    const r = el.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const onBackground = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const svg = e.currentTarget;
    const p = fromPx(rel(e, svg).px, rel(e, svg).py);
    beginTransaction();
    write(upsertPathPoint(clip.motion ?? emptyMotion(), local, p.x, p.y, fps));
    svg.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const q = fromPx(rel(ev, svg).px, rel(ev, svg).py);
      const cur = useProject.getState().project.clips[clip.id];
      if (cur) write(upsertPathPoint(cur.motion ?? emptyMotion(), local, q.x, q.y, fps));
    };
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); endTransaction(); setDirty(true); };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
  };
  const onPoint = (e: React.PointerEvent<SVGCircleElement>, idx: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const svg = (e.currentTarget as SVGCircleElement).ownerSVGElement!;
    const kt = keys[idx].t;
    let moved = false;
    beginTransaction();
    svg.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      moved = true;
      const q = fromPx(rel(ev, svg).px, rel(ev, svg).py);
      const cur = useProject.getState().project.clips[clip.id]?.motion;
      if (!cur) return;
      write({ ...cur, keyframes: cur.keyframes.map((k) => (Math.abs(k.t - kt) < 1e-6 ? { ...k, x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 } : k)) });
    };
    const up = () => {
      svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up);
      endTransaction();
      if (moved) setDirty(true);
      else { const tt = clip.start + kt; useUi.getState().setPlayhead(tt); seekTo(tt); }
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
  };
  const remove = (idx: number) => {
    write({ ...m, keyframes: keys.filter((_, i) => i !== idx) });
    setDirty(true);
  };

  return (
    <svg className="path-overlay" style={{ left: canvas.offsetLeft, top: canvas.offsetTop, width: W, height: H }} onPointerDown={onBackground}>
      {pts.length > 1 && <polyline points={pts.join(' ')} className="path-line" />}
      {keys.map((k, i) => {
        const p = toPx(k.x, k.y);
        const active = Math.abs(k.t - local) < tol;
        const label = i === 0 ? t.path.start : i === keys.length - 1 ? t.path.end : String(i);
        return (
          <g key={`${k.t}`}>
            <circle cx={p.px} cy={p.py} r={active ? 9 : 7} className={`path-point${active ? ' active' : ''}${i === 0 ? ' first' : i === keys.length - 1 ? ' last' : ''}`}
              onPointerDown={(e) => onPoint(e, i)} onDoubleClick={(e) => { e.stopPropagation(); remove(i); }}>
              <title>{`${label} · ${k.t.toFixed(2)} s – ${t.path.pointHint}`}</title>
            </circle>
            <text x={p.px + 11} y={p.py - 9} className="path-label">{label}</text>
          </g>
        );
      })}
      <circle cx={nowP.px} cy={nowP.py} r={4} className="path-now" />
    </svg>
  );
}
