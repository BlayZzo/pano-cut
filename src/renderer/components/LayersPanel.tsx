// Ebenen-Fenster: alles, was gerade im Bild ist (Videos, Bilder, Texte, freigestellte Objekte, Effekte),
// vorne → hinten. Reihenfolge ändern per Pfeil oder Ziehen; Objekt einer Maske als eigene Ebene nach vorne holen.
import React, { useState } from 'react';
import type { Clip, MediaItem } from '@shared/types';
import { useProject, setDirty } from '../store/project';
import { useUi, usePlayheadCoarse } from '../store/ui';
import { layersAt, moveLayer } from '../layers';
import { bringObjectToFront } from '../vfx/actions';
import { t } from '../i18n/de';
import { IconClose } from './Icons';

function layerIcon(c: Clip, m: MediaItem | undefined): string {
  if (c.kind === 'title') return '🔤';
  if (c.link) return '🔗';
  if (c.cutout?.enabled) return '✂️';
  if (m?.vfx) return '✨';
  if (m?.model3d) return '🧊';
  if (m?.type === 'image') return '🖼️';
  if (m?.info.is360) return '🌐';
  return '🎬';
}

export function LayersPanel(): React.ReactElement | null {
  const open = useUi((s) => s.layersPanel);
  const setOpen = useUi((s) => s.setLayersPanel);
  const playhead = usePlayheadCoarse(0.1);
  const project = useProject((s) => s.project);
  const selection = useUi((s) => s.selection);
  const [dragId, setDragId] = useState<string | null>(null);
  if (!open) return null;
  const layers = layersAt(project, playhead);
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    // so lange verschieben, bis die gezogene Ebene an der Stelle des Ziels liegt
    for (let n = 0; n < 12; n++) {
      const p = useProject.getState().project;
      const cur = layersAt(p, playhead);
      const a = cur.findIndex((c) => c.id === dragId), b = cur.findIndex((c) => c.id === targetId);
      if (a < 0 || b < 0 || a === b) break;
      moveLayer(dragId, a > b ? -1 : 1);
      const after = layersAt(useProject.getState().project, playhead).findIndex((c) => c.id === dragId);
      if (after === a) break;
    }
    setDragId(null);
  };
  return (
    <div className="ai-panel layers-panel">
      <div className="ai-panel-header">
        <strong>🧅 {t.layerPanel.title}</strong>
        <div className="spacer" />
        <button className="btn icon ghost sm" onClick={() => setOpen(false)}><IconClose /></button>
      </div>
      <div className="hint">{t.layerPanel.hint}</div>
      {layers.length === 0 && <div className="hint">{t.layerPanel.empty}</div>}
      <div className="layer-list">
        {layers.map((c, i) => {
          const m = project.media[c.mediaId];
          const tr = project.tracks.find((x) => x.id === c.trackId);
          const objs = (c.objects ?? []).filter((o) => o.masks?.length);
          return (
            <div key={c.id} className={`layer-row${selection.includes(c.id) ? ' selected' : ''}${dragId === c.id ? ' dragging' : ''}${tr?.hidden ? ' hidden' : ''}`}
              draggable onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); dropOn(c.id); }} onDragEnd={() => setDragId(null)}
              onClick={() => useUi.getState().select([c.id])}>
              <span className="layer-pos">{i === 0 ? t.layerPanel.front : i === layers.length - 1 ? t.layerPanel.back : i + 1}</span>
              <span className="layer-icon">{layerIcon(c, m)}</span>
              <span className="layer-name" title={c.name}>{c.kind === 'title' ? (c.title?.text || c.name) : c.name}</span>
              <button className="btn icon ghost sm" title={t.layers.trackUp} disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveLayer(c.id, -1); }}>▲</button>
              <button className="btn icon ghost sm" title={t.layers.trackDown} disabled={i === layers.length - 1} onClick={(e) => { e.stopPropagation(); moveLayer(c.id, 1); }}>▼</button>
              <button className="btn icon ghost sm" title={t.layerPanel.toggleTrack} onClick={(e) => { e.stopPropagation(); if (tr) { useProject.getState().updateTrack(tr.id, { hidden: !tr.hidden }); setDirty(true); } }}>{tr?.hidden ? '🙈' : '👁'}</button>
              {objs.length > 0 && !c.link && (
                <div className="layer-objs">
                  {objs.map((o) => (
                    <button key={o.id} className="btn sm" title={t.layers.toFrontHint} onClick={(e) => { e.stopPropagation(); bringObjectToFront(c.id, o.id); }}>✂️ {o.labelDe} {t.layerPanel.objFront}</button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
