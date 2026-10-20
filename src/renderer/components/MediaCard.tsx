import React, { useRef, useState } from 'react';
import type { MediaItem } from '@shared/types';
import { formatDuration } from '@shared/timeline';
import { cssUrl, mediaUrl } from '../utils/dom';
import { DRAG_MIME, setDraggingMedia } from '../utils/dnd';
import { t } from '../i18n/de';
import { prepLabel } from '../utils/prep';
import { IconFilm, IconImage, IconMusic } from './Icons';

interface Props {
  item: MediaItem;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}

/** Eine Kachel in der Mediathek. Beim Überfahren mit der Maus wird der Clip grob durchgespult (Hover-Vorschau). */
export function MediaCard({ item, selected, onSelect, onOpen, onContextMenu }: Props): React.ReactElement {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const onMove = (e: React.MouseEvent) => {
    const el = thumbRef.current;
    if (!el || !item.sprite) return;
    const r = el.getBoundingClientRect();
    setHoverX(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, item.id);
    e.dataTransfer.effectAllowed = 'copy';
    setDraggingMedia(item.id);
  };

  const prep = prepLabel(item);
  const frames = item.sprite?.frames ?? 1;
  const frameIndex = hoverX === null ? -1 : Math.min(frames - 1, Math.floor(hoverX * frames));
  const spriteStyle: React.CSSProperties | undefined = item.sprite && frameIndex >= 0
    ? { backgroundImage: cssUrl(item.sprite.path), backgroundPosition: `${(frameIndex / Math.max(1, frames - 1)) * 100}% 0` }
    : undefined;
  // Hintergrundgröße: der Streifen ist frames × frameWidth breit → bei "auto 100%" passt die Höhe, die Breite skaliert mit
  const badge = item.vfx ? 'FX' : item.info.is360 ? t.library.is360 : item.type === 'audio' ? 'AUDIO' : item.type === 'image' ? 'BILD' : (item.info.height >= 2160 ? '4K' : item.info.height >= 1080 ? 'HD' : '');

  return (
    <div
      className={`media-card${selected ? ' selected' : ''}`}
      draggable={item.status === 'ready' || item.status === 'processing'}
      onDragStart={onDragStart}
      onDragEnd={() => setDraggingMedia(null)}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onDoubleClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.clientX, e.clientY); }}
      title={`${item.name}\n${item.info.width ? `${item.info.width}×${item.info.height}` : ''} ${item.info.duration ? formatDuration(item.info.duration) : ''}`}
    >
      <div
        className="media-thumb"
        ref={thumbRef}
        style={{ backgroundImage: item.thumb ? cssUrl(item.thumb) : undefined }}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverX(null)}
      >
        {item.type === 'audio' && item.waveform && <img className="media-wave" src={mediaUrl(item.waveform)} alt="" draggable={false} />}
        {!item.thumb && item.type === 'video' && <IconFilm />}
        {!item.thumb && item.type === 'image' && <IconImage />}
        {item.type === 'audio' && !item.waveform && <IconMusic />}
        {spriteStyle && (
          <div className="sprite" style={{ ...spriteStyle, backgroundSize: `${frames * 100}% 100%` }} />
        )}
        {hoverX !== null && item.sprite && <div className="scrub-line" style={{ left: `${hoverX * 100}%` }} />}
        {badge && <div className="media-badge">{badge}</div>}
        {item.info.duration > 0 && !prep && <div className="media-dur">{formatDuration(item.info.duration)}</div>}
        {item.status === 'analyzing' && <div className="media-status"><span className="spinner" />&nbsp;{t.library.analyzing}</div>}
        {item.status === 'processing' && !item.thumb && <div className="media-status"><span className="spinner" />&nbsp;{t.library.processing}</div>}
        {prep && item.thumb && (
          <div className="media-prep" title={t.library.workingHint}>
            <div className="media-prep-text"><span>{prep.text}</span>{prep.etaShort && <span>~{prep.etaShort}</span>}</div>
            <div className="progress"><div style={{ width: `${prep.percent}%` }} /></div>
          </div>
        )}
        {item.status === 'error' && <div className="media-status error">{t.library.error}: {item.error}</div>}
      </div>
      <div className="media-name">{item.name}</div>
    </div>
  );
}
