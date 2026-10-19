import React, { useEffect, useRef } from 'react';
import type { MulticamGroup } from '@shared/types';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { engine } from '../engine/instance';
import { t } from '../i18n/de';
import { autoSwitch, currentAngle, dissolveMulticam, groupAt, resetCuts, setAudioAngle, switchToAngle } from '../multicamActions';

/** Leiste unter der Vorschau: alle Kameras einer Mehrkamera-Gruppe gleichzeitig, aktive Kamera hervorgehoben. */
export function MulticamStrip(): React.ReactElement | null {
  const open = useUi((s) => s.multicamPanel);
  const setOpen = useUi((s) => s.setMulticamPanel);
  const playhead = useUi((s) => s.playhead);
  const groups = useProject((s) => s.project.multicam);
  const group: MulticamGroup | null = (open && groups?.[open]) || groupAt(playhead);
  if (!open) return null;
  if (!group) {
    return (
      <div className="multicam-strip empty">
        <span className="hint">{t.multicam.noGroup}</span>
        <button className="btn sm ghost" onClick={() => setOpen(null)}>✕</button>
      </div>
    );
  }
  const active = currentAngle(group, playhead);
  return (
    <div className="multicam-strip">
      <div className="multicam-tiles">
        {group.angles.map((a, i) => (
          <AngleTile key={i} group={group} index={i} active={i === active} playhead={playhead} />
        ))}
      </div>
      <div className="multicam-side">
        <div className="multicam-title">{t.multicam.title}</div>
        <label className="multicam-audio">
          {t.multicam.audioFrom}
          <select value={group.audioAngle} onChange={(e) => setAudioAngle(group.id, Number(e.target.value))}>
            {group.angles.map((a, i) => <option key={i} value={i}>{a.name}</option>)}
          </select>
        </label>
        <button className="btn sm primary" title={t.multicam.autoHint} onClick={() => autoSwitch(group.id)}>{t.multicam.auto}</button>
        <div className="field-row">
          <button className="btn sm ghost" onClick={() => resetCuts(group.id)}>{t.multicam.reset}</button>
          <button className="btn sm ghost" title={t.multicam.dissolveHint} onClick={() => dissolveMulticam(group.id)}>{t.multicam.dissolve}</button>
          <button className="btn sm ghost" onClick={() => setOpen(null)}>✕</button>
        </div>
      </div>
    </div>
  );
}

function AngleTile({ group, index, active, playhead }: { group: MulticamGroup; index: number; active: boolean; playhead: number }): React.ReactElement {
  const media = useProject((s) => s.project.media[group.angles[index].mediaId]);
  const ref = useRef<HTMLVideoElement>(null);
  const angle = group.angles[index];
  const local = playhead - group.start - angle.shift;
  const dur = media?.info.duration ?? 0;
  const inside = local >= 0 && local <= dur;
  const src = media ? window.panocut.toMediaUrl(media.proxy ?? media.path) : '';
  // Kamerabild mit dem Abspielkopf mitlaufen lassen
  useEffect(() => {
    const v = ref.current;
    if (!v || !inside) { v?.pause(); return; }
    if (engine.isPlaying) {
      if (Math.abs(v.currentTime - local) > 0.3) v.currentTime = local;
      if (v.paused) void v.play().catch(() => undefined);
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - local) > 0.04) v.currentTime = local;
    }
  }, [local, inside]);
  const conf = group.confidence[index] ?? 1;
  return (
    <button className={`multicam-tile${active ? ' active' : ''}`} onClick={() => switchToAngle(index)} title={angle.name}>
      <video ref={ref} src={src} muted playsInline preload="auto" style={{ visibility: inside ? 'visible' : 'hidden' }} />
      {!inside && <span className="multicam-off">{t.multicam.offline}</span>}
      <span className="multicam-key">{index + 1}</span>
      <span className="multicam-name">{angle.name.replace(/^\d+:\s*/, '')}</span>
      {conf < 0.15 && index !== 0 && <span className="multicam-warn" title={t.multicam.unsure}>⚠</span>}
    </button>
  );
}
