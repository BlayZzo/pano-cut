import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, MediaItem, Project, Track } from '@shared/types';
import { clipDuration, clipEnd, DEFAULT_IMAGE_DURATION, DEFAULT_TITLE_DURATION, formatTime, MIN_CLIP_DURATION, overlaps, projectDuration, sourceLimit } from '@shared/timeline';
import { useProject } from '../store/project';
import { useUi, type DragState } from '../store/ui';
import { engine, stopPlayback } from '../engine/instance';
import { addTitleToTimeline, applyTransitionToClip, deleteSelection, duplicateSelection, splitAtPlayhead, zoomBy, zoomToFit } from '../actions';
import type { TransitionType } from '@shared/types';
import { TITLE_TEMPLATES } from '@shared/pano';
import { t } from '../i18n/de';
import { cssUrl } from '../utils/dom';
import { DRAG_MIME, DRAG_TITLE, DRAG_TRANSITION, getDragging, getDraggingMedia } from '../utils/dnd';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { IconEye, IconEyeOff, IconFit, IconLock, IconMagnet, IconMute, IconPlus, IconScissors, IconTrash, IconUnlock, IconVolume, IconZoomIn, IconZoomOut } from './Icons';

const RULER_H = 24;
const VIDEO_H = 64;
const AUDIO_H = 48;
const SNAP_PX = 8;
const DIVIDER_H = 6;

function trackHeight(tr: Track): number {
  return tr.kind === 'video' ? VIDEO_H : AUDIO_H;
}

/** Y-Offset jeder Spur innerhalb des Inhalts (nach dem Lineal). */
function trackOffsets(tracks: Track[]): { top: number; height: number; track: Track }[] {
  let y = RULER_H;
  const out: { top: number; height: number; track: Track }[] = [];
  let lastKind: Track['kind'] | null = null;
  for (const tr of tracks) {
    if (lastKind && lastKind !== tr.kind) y += DIVIDER_H;
    const h = trackHeight(tr);
    out.push({ top: y, height: h, track: tr });
    y += h;
    lastKind = tr.kind;
  }
  return out;
}

function snapTargets(project: Project, exclude: Set<string>, playhead: number): number[] {
  const pts = [0, playhead];
  for (const c of Object.values(project.clips)) {
    if (exclude.has(c.id)) continue;
    pts.push(c.start, clipEnd(c));
  }
  return pts;
}

function snapValue(value: number, targets: number[], threshold: number): { value: number; snapped: number | null } {
  let best: number | null = null;
  let bestD = threshold;
  for (const tg of targets) {
    const d = Math.abs(tg - value);
    if (d < bestD) { bestD = d; best = tg; }
  }
  return best === null ? { value, snapped: null } : { value: best, snapped: best };
}

export function Timeline({ zoomFitRef }: { zoomFitRef: React.MutableRefObject<() => void> }): React.ReactElement {
  const project = useProject((s) => s.project);
  const addTrack = useProject((s) => s.addTrack);
  const addClip = useProject((s) => s.addClip);
  const moveClips = useProject((s) => s.moveClips);
  const trimClip = useProject((s) => s.trimClip);
  const removeTrack = useProject((s) => s.removeTrack);
  const updateTrack = useProject((s) => s.updateTrack);

  const zoom = useUi((s) => s.zoom);
  const setZoom = useUi((s) => s.setZoom);
  const snapping = useUi((s) => s.snapping);
  const setSnapping = useUi((s) => s.setSnapping);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const toggleSelect = useUi((s) => s.toggleSelect);
  const drag = useUi((s) => s.drag);
  const setDrag = useUi((s) => s.setDrag);
  const rangeIn = useUi((s) => s.rangeIn);
  const rangeOut = useUi((s) => s.rangeOut);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropPreview, setDropPreview] = useState<{ trackId: string; time: number; media: MediaItem | null; title?: string; transitionClip?: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);

  const offsets = useMemo(() => trackOffsets(project.tracks), [project.tracks]);
  const contentHeight = (offsets[offsets.length - 1]?.top ?? RULER_H) + (offsets[offsets.length - 1]?.height ?? 0) + 40;
  const duration = projectDuration(project);
  const [viewWidth, setViewWidth] = useState(800);
  const contentWidth = Math.max(viewWidth, duration * zoom + 400);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    setViewWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  zoomFitRef.current = () => zoomToFit(viewWidth);

  // Zeit an einer Bildschirm-X-Position
  const timeAtClientX = useCallback((clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + el.scrollLeft) / zoom);
  }, [zoom]);

  const trackAtClientY = useCallback((clientY: number): Track | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const y = clientY - r.top + el.scrollTop;
    for (const o of offsets) if (y >= o.top && y < o.top + o.height) return o.track;
    return null;
  }, [offsets]);

  // Zoom mit Cmd/Strg + Mausrad um die Mausposition; Shift + Rad = horizontal
  const onWheel = (e: React.WheelEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const tAtMouse = (mouseX + el.scrollLeft) / zoom;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.min(2000, Math.max(4, zoom * factor));
      setZoom(newZoom);
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, tAtMouse * newZoom - mouseX); });
    } else if (e.shiftKey && Math.abs(e.deltaX) < 1) {
      el.scrollLeft += e.deltaY;
    }
  };

  const onScroll = () => {
    if (headersRef.current && scrollRef.current) headersRef.current.scrollTop = scrollRef.current.scrollTop;
  };

  // ---------- Lineal: klicken/ziehen = spulen ----------
  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    stopPlayback();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    engine.seek(timeAtClientX(e.clientX));
    const move = (ev: PointerEvent) => engine.seek(timeAtClientX(ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------- Clips verschieben / trimmen ----------
  const startClipDrag = (e: React.PointerEvent, clip: Clip, kind: DragState['kind']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const track = project.tracks.find((tr) => tr.id === clip.trackId);
    if (track?.locked) return;
    stopPlayback();
    const ui = useUi.getState();
    let ids: string[];
    if (kind === 'move') {
      if (e.shiftKey) { toggleSelect(clip.id); ids = useUi.getState().selection; }
      else if (ui.selection.includes(clip.id)) ids = ui.selection;
      else { select([clip.id]); ids = [clip.id]; }
    } else {
      select([clip.id]);
      ids = [clip.id];
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const moving = ids.map((id) => project.clips[id]).filter(Boolean) as Clip[];
    const minStart = Math.min(...moving.map((c) => c.start));
    const exclude = new Set(ids);
    const targets = snapTargets(project, exclude, ui.playhead);
    const threshold = SNAP_PX / zoom;
    let moved = false;
    let last: DragState | null = null;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3 && Math.abs(ev.clientY - startY) < 3) return;
      moved = true;
      let dt = dx / zoom;
      let snapped: number | null = null;
      if (kind === 'move') {
        dt = Math.max(dt, -minStart);
        if (useUi.getState().snapping) {
          // Anfang und Ende des angeklickten Clips einrasten
          const s1 = snapValue(clip.start + dt, targets, threshold);
          const s2 = snapValue(clipEnd(clip) + dt, targets, threshold);
          if (s1.snapped !== null) { dt = s1.value - clip.start; snapped = s1.snapped; }
          else if (s2.snapped !== null) { dt = s2.value - clipEnd(clip); snapped = s2.snapped; }
        }
        const target = trackAtClientY(ev.clientY);
        const copy = ev.altKey;
        const trackId = target?.id;
        // Gültigkeit prüfen
        const sameTrack = moving.every((c) => c.trackId === moving[0].trackId);
        let valid = true;
        for (const c of moving) {
          let tid = c.trackId;
          if (target && sameTrack && !target.locked) {
            const media = project.media[c.mediaId];
            const src = project.tracks.find((tr) => tr.id === c.trackId);
            const kindOk = target.kind === src?.kind || (target.kind === 'audio' && media?.type !== 'image') || (target.kind === 'video' && media?.type !== 'audio');
            if (kindOk) tid = target.id;
          }
          if (overlaps(project, c, c.start + dt, tid, copy ? new Set() : exclude)) { valid = false; break; }
        }
        last = { kind, clipIds: ids, dt, trackId, copy, valid };
      } else {
        const side = kind === 'trimStart' ? 'start' : 'end';
        let time = (side === 'start' ? clip.start : clipEnd(clip)) + dt;
        if (useUi.getState().snapping) {
          const s = snapValue(time, targets, threshold);
          if (s.snapped !== null) { time = s.value; snapped = s.snapped; }
        }
        // Grenzen: Mindestlänge und Quelllänge
        const media = project.media[clip.mediaId];
        const srcMax = sourceLimit(clip, media);
        if (side === 'start') {
          const maxStart = clipEnd(clip) - MIN_CLIP_DURATION;
          const minStartSrc = clip.reverse ? clip.start - ((srcMax - clip.out) / clip.speed) : clip.start - clip.in / clip.speed;
          time = Math.max(0, Math.max(minStartSrc, Math.min(maxStart, time)));
        } else {
          const minEnd = clip.start + MIN_CLIP_DURATION;
          const maxEndSrc = clip.reverse ? clip.start + clip.out / clip.speed : clip.start + (srcMax - clip.in) / clip.speed;
          time = Math.min(maxEndSrc, Math.max(minEnd, time));
        }
        dt = time - (side === 'start' ? clip.start : clipEnd(clip));
        const probe: Clip = side === 'start'
          ? { ...clip, start: time, out: clip.out, in: clip.in + (time - clip.start) * clip.speed }
          : { ...clip, out: clip.in + (time - clip.start) * clip.speed };
        const valid = !overlaps(project, probe, probe.start, probe.trackId);
        last = { kind, clipIds: [clip.id], dt, valid };
      }
      setDrag(last);
      setSnapLine(snapped);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSnapLine(null);
      setDrag(null);
      if (!moved || !last || !last.valid) return;
      if (last.kind === 'move') {
        const result = moveClips(last.clipIds, last.dt, last.trackId, last.copy);
        if (last.copy && result.length) select(result);
      } else {
        const side = last.kind === 'trimStart' ? 'start' : 'end';
        trimClip(clip.id, side, (side === 'start' ? clip.start : clipEnd(clip)) + last.dt);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------- Drop aus der Mediathek ----------
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(DRAG_MIME) && !types.includes(DRAG_TITLE) && !types.includes(DRAG_TRANSITION)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const track = trackAtClientY(e.clientY);
    if (!track || track.locked) { setDropPreview(null); return; }
    // getData ist in dragover in Chromium leer – die Daten kommen aus dem Drag-Hilfsmodul
    const payload = getDragging();
    if (!payload) return;
    let time = timeAtClientX(e.clientX);
    if (payload.kind === 'transition') {
      const target = Object.values(project.clips).find((c) => c.trackId === track.id && time >= c.start && time < clipEnd(c) && c.kind !== 'title');
      setDropPreview(target ? { trackId: track.id, time, media: null, transitionClip: target.id } : null);
      return;
    }
    if (useUi.getState().snapping) time = snapValue(time, snapTargets(project, new Set(), useUi.getState().playhead), SNAP_PX / zoom).value;
    if (payload.kind === 'title') {
      if (track.kind !== 'video') { setDropPreview(null); return; }
      setDropPreview({ trackId: track.id, time, media: null, title: payload.templateId });
      return;
    }
    const m = project.media[payload.id];
    if (!m) return;
    if ((track.kind === 'audio' && m.type === 'image') || (track.kind === 'video' && m.type === 'audio')) { setDropPreview(null); return; }
    setDropPreview({ trackId: track.id, time, media: m });
  };
  const onDrop = (e: React.DragEvent) => {
    const payload = getDragging();
    const mediaId = e.dataTransfer.getData(DRAG_MIME) || getDraggingMedia();
    const titleId = e.dataTransfer.getData(DRAG_TITLE) || (payload?.kind === 'title' ? payload.templateId : '');
    const trType = e.dataTransfer.getData(DRAG_TRANSITION) || (payload?.kind === 'transition' ? payload.type : '');
    if (!mediaId && !titleId && !trType) return;
    e.preventDefault();
    const preview = dropPreview;
    setDropPreview(null);
    const track = trackAtClientY(e.clientY);
    if (!track) return;
    const time = preview?.time ?? timeAtClientX(e.clientX);
    if (trType) {
      const target = preview?.transitionClip ?? Object.values(project.clips).find((c) => c.trackId === track.id && time >= c.start && time < clipEnd(c))?.id;
      if (target) applyTransitionToClip(target, trType as TransitionType);
      return;
    }
    if (titleId) {
      addTitleToTimeline(titleId, time, track.id);
      return;
    }
    if (!mediaId) return;
    const clip = addClip(mediaId, track.id, time);
    if (clip) select([clip.id]);
  };

  // ---------- Kontextmenüs ----------
  const clipMenu = (clip: Clip, x: number, y: number) => {
    if (!selection.includes(clip.id)) select([clip.id]);
    setMenu({ x, y, entries: [
      { label: t.timeline.split, onClick: splitAtPlayhead },
      { label: t.timeline.duplicate, onClick: duplicateSelection },
      { sep: true },
      { label: t.timeline.delete, danger: true, onClick: deleteSelection },
    ] });
  };
  const trackMenu = (track: Track, x: number, y: number) => {
    setMenu({ x, y, entries: [
      { label: track.muted ? t.timeline.mute + ' aus' : t.timeline.mute, onClick: () => updateTrack(track.id, { muted: !track.muted }) },
      { label: track.locked ? t.timeline.lock + ' aus' : t.timeline.lock, onClick: () => updateTrack(track.id, { locked: !track.locked }) },
      { sep: true },
      { label: t.timeline.removeTrack, danger: true, disabled: project.tracks.filter((tr) => tr.kind === track.kind).length <= 1, onClick: () => removeTrack(track.id) },
    ] });
  };

  const fps = project.settings.fps;

  return (
    <section className="timeline" onContextMenu={(e) => e.preventDefault()}>
      <div className="timeline-toolbar">
        <button className="btn sm" title={t.timeline.split} onClick={splitAtPlayhead}><IconScissors />{t.timeline.split.replace(' (S)', '')}</button>
        <button className="btn sm" title={t.timeline.delete} onClick={deleteSelection} disabled={selection.length === 0}><IconTrash /></button>
        <div className="sep" />
        <button className={`btn sm icon${snapping ? ' active' : ''}`} title={t.timeline.snap} onClick={() => setSnapping(!snapping)}><IconMagnet /></button>
        <div className="sep" />
        <button className="btn sm icon ghost" title={t.timeline.zoomOut} onClick={() => zoomBy(1 / 1.3)}><IconZoomOut /></button>
        <input type="range" min={0} max={100} value={zoomToSlider(zoom)} onChange={(e) => setZoom(sliderToZoom(Number(e.target.value)))} style={{ width: 110, accentColor: 'var(--accent)' }} title="Zoom" />
        <button className="btn sm icon ghost" title={t.timeline.zoomIn} onClick={() => zoomBy(1.3)}><IconZoomIn /></button>
        <button className="btn sm icon ghost" title={t.timeline.zoomFit} onClick={() => zoomToFit(viewWidth)}><IconFit /></button>
        <div className="sep" />
        <button className="btn sm ghost" title={t.timeline.addVideoTrack} onClick={() => addTrack('video')}><IconPlus />{t.timeline.trackVideo}</button>
        <button className="btn sm ghost" title={t.timeline.addAudioTrack} onClick={() => addTrack('audio')}><IconPlus />{t.timeline.trackAudio}</button>
        <div className="spacer" />
        {rangeIn !== null && rangeOut !== null && <span className="pill">Bereich {formatTime(rangeIn, fps, false)} – {formatTime(rangeOut, fps, false)}</span>}
        <span className="pill">{Object.keys(project.clips).length} Clips · {formatTime(duration, fps, false)}</span>
      </div>
      <div className="timeline-body">
        <div className="track-headers" ref={headersRef}>
          <div className="track-headers-inner">
            {offsets.map(({ track, height }, i) => (
              <React.Fragment key={track.id}>
                {i > 0 && offsets[i - 1].track.kind !== track.kind && <div className="track-divider" />}
                <div className={`track-header ${track.kind}`} style={{ '--track-h': `${height}px` } as React.CSSProperties} onContextMenu={(e) => { e.preventDefault(); trackMenu(track, e.clientX, e.clientY); }}>
                  <span className="name" title={track.name}>{track.name}</span>
                  {track.kind === 'video' && (
                    <button className={`tbtn${track.hidden ? ' on' : ''}`} title={t.timeline.hide} onClick={() => updateTrack(track.id, { hidden: !track.hidden })}>{track.hidden ? <IconEyeOff /> : <IconEye />}</button>
                  )}
                  <button className={`tbtn${track.muted ? ' on' : ''}`} title={t.timeline.mute} onClick={() => updateTrack(track.id, { muted: !track.muted })}>{track.muted ? <IconMute /> : <IconVolume />}</button>
                  <button className={`tbtn${track.locked ? ' on' : ''}`} title={t.timeline.lock} onClick={() => updateTrack(track.id, { locked: !track.locked })}>{track.locked ? <IconLock /> : <IconUnlock />}</button>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="lanes-scroll" ref={scrollRef} onWheel={onWheel} onScroll={onScroll} onDragOver={onDragOver} onDragLeave={() => setDropPreview(null)} onDrop={onDrop}
          onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('lane')) { select([]); } }}>
          <div className="lanes-content" style={{ width: contentWidth, height: contentHeight }}>
            <Ruler zoom={zoom} width={contentWidth} fps={fps} onPointerDown={onRulerPointerDown} rangeIn={rangeIn} rangeOut={rangeOut} />
            {offsets.map(({ track, height, top }, i) => (
              <React.Fragment key={track.id}>
                {i > 0 && offsets[i - 1].track.kind !== track.kind && <div className="track-divider" style={{ position: 'absolute', top: top - DIVIDER_H, left: 0, right: 0 }} />}
                <Lane
                  track={track}
                  top={top}
                  height={height}
                  project={project}
                  zoom={zoom}
                  selection={selection}
                  drag={drag}
                  dropPreview={dropPreview?.trackId === track.id ? dropPreview : null}
                  onClipPointerDown={startClipDrag}
                  onClipContextMenu={clipMenu}
                />
              </React.Fragment>
            ))}
            {Object.keys(project.clips).length === 0 && !dropPreview && <div className="lanes-empty">{t.timeline.empty}</div>}
            {snapLine !== null && <div className="snap-line" style={{ left: snapLine * zoom }} />}
            <Playhead zoom={zoom} scrollRef={scrollRef} />
          </div>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
    </section>
  );
}

function zoomToSlider(zoom: number): number {
  return Math.round(((Math.log(zoom) - Math.log(4)) / (Math.log(2000) - Math.log(4))) * 100);
}
function sliderToZoom(v: number): number {
  return Math.exp(Math.log(4) + (v / 100) * (Math.log(2000) - Math.log(4)));
}

// ---------- Lineal ----------

function Ruler({ zoom, width, fps, onPointerDown, rangeIn, rangeOut }: { zoom: number; width: number; fps: number; onPointerDown: (e: React.PointerEvent) => void; rangeIn: number | null; rangeOut: number | null }): React.ReactElement {
  const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const major = steps.find((s) => s * zoom >= 90) ?? 1800;
  const minor = major / (major >= 60 ? 6 : major >= 5 ? 5 : major === 2 ? 4 : major === 1 ? 4 : 2);
  const ticks: React.ReactNode[] = [];
  const total = width / zoom;
  const withFrames = major < 1;
  for (let tt = 0; tt <= total; tt += minor) {
    const isMajor = Math.abs(tt / major - Math.round(tt / major)) < 1e-6;
    ticks.push(
      <div key={tt.toFixed(4)} className={`tick${isMajor ? '' : ' minor'}`} style={{ left: tt * zoom }}>
        {isMajor && <span>{formatTime(tt, fps, withFrames)}</span>}
      </div>,
    );
    if (ticks.length > 3000) break;
  }
  return (
    <div className="ruler" style={{ width }} onPointerDown={onPointerDown}>
      {ticks}
      {rangeIn !== null && rangeOut !== null && rangeOut > rangeIn && <div className="range" style={{ left: rangeIn * zoom, width: (rangeOut - rangeIn) * zoom }} />}
    </div>
  );
}

function Playhead({ zoom, scrollRef }: { zoom: number; scrollRef: React.RefObject<HTMLDivElement> }): React.ReactElement {
  const playhead = useUi((s) => s.playhead);
  // Während der Wiedergabe mitscrollen
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !engine.isPlaying) return;
    const x = playhead * zoom;
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.1);
  }, [playhead, zoom, scrollRef]);
  return <div className="playhead" style={{ left: playhead * zoom }} />;
}

// ---------- Spur ----------

interface LaneProps {
  track: Track;
  top: number;
  height: number;
  project: Project;
  zoom: number;
  selection: string[];
  drag: DragState | null;
  dropPreview: { trackId: string; time: number; media: MediaItem | null; title?: string; transitionClip?: string } | null;
  onClipPointerDown: (e: React.PointerEvent, clip: Clip, kind: DragState['kind']) => void;
  onClipContextMenu: (clip: Clip, x: number, y: number) => void;
}

const Lane = React.memo(function Lane({ track, top, height, project, zoom, selection, drag, dropPreview, onClipPointerDown, onClipContextMenu }: LaneProps): React.ReactElement {
  const clips = useMemo(() => Object.values(project.clips).filter((c) => c.trackId === track.id), [project.clips, track.id]);
  const dragTarget = drag?.kind === 'move' && drag.trackId === track.id;
  // Clips, die per Spurwechsel hierher gezogen werden (Geister)
  const incoming = dragTarget && drag ? drag.clipIds.map((id) => project.clips[id]).filter((c) => c && c.trackId !== track.id) as Clip[] : [];
  return (
    <div className={`lane${track.locked ? ' locked' : ''}${dropPreview || dragTarget ? ' drop-target' : ''}`} style={{ position: 'absolute', top, left: 0, right: 0, height, '--track-h': `${height}px` } as React.CSSProperties}>
      {clips.map((clip) => {
        const inDrag = drag && drag.clipIds.includes(clip.id) ? drag : null;
        return (
          <TimelineClip
            key={clip.id}
            clip={clip}
            media={project.media[clip.mediaId]}
            zoom={zoom}
            selected={selection.includes(clip.id) || dropPreview?.transitionClip === clip.id}
            drag={inDrag}
            movedAway={!!inDrag && inDrag.kind === 'move' && !!inDrag.trackId && inDrag.trackId !== track.id && !inDrag.copy}
            onPointerDown={onClipPointerDown}
            onContextMenu={onClipContextMenu}
          />
        );
      })}
      {incoming.map((clip) => (
        <div key={`ghost_${clip.id}`} className={`clip ghost ${clipClass(project.media[clip.mediaId])}${drag && !drag.valid ? ' invalid' : ''}`} style={{ left: (clip.start + (drag?.dt ?? 0)) * zoom, width: clipDuration(clip) * zoom }}>
          <div className="clip-label">{clip.name}</div>
        </div>
      ))}
      {dropPreview && !dropPreview.transitionClip && (
        <div className={`clip ghost${dropPreview.title ? ' title' : ''}`} style={{ left: dropPreview.time * zoom, width: (dropPreview.title ? DEFAULT_TITLE_DURATION : dropPreview.media ? (dropPreview.media.type === 'image' ? DEFAULT_IMAGE_DURATION : dropPreview.media.info.duration) : 1) * zoom }}>
          <div className="clip-label">{dropPreview.title ? (TITLE_TEMPLATES.find((x) => x.id === dropPreview.title)?.name ?? 'Titel') : dropPreview.media?.name}</div>
        </div>
      )}
    </div>
  );
});

function clipClass(media: MediaItem | undefined, clip?: Clip): string {
  if (clip?.kind === 'title') return 'title';
  if (!media) return '';
  return media.type === 'audio' ? 'audio' : media.type === 'image' ? 'image' : '';
}

// ---------- Clip ----------

interface ClipProps {
  clip: Clip;
  media: MediaItem | undefined;
  zoom: number;
  selected: boolean;
  drag: DragState | null;
  movedAway: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, kind: DragState['kind']) => void;
  onContextMenu: (clip: Clip, x: number, y: number) => void;
}

const TimelineClip = React.memo(function TimelineClip({ clip, media, zoom, selected, drag, movedAway, onPointerDown, onContextMenu }: ClipProps): React.ReactElement {
  let start = clip.start;
  let end = clipEnd(clip);
  if (drag) {
    if (drag.kind === 'move') { start += drag.dt; end += drag.dt; }
    else if (drag.kind === 'trimStart') start += drag.dt;
    else end += drag.dt;
  }
  const left = start * zoom;
  const width = Math.max(2, (end - start) * zoom);
  const dur = media?.info.duration ?? 0;

  // Filmstreifen / Wellenform zeitlich passend zum Quellbereich ausrichten
  let strip: React.CSSProperties | undefined;
  const srcLen = Math.max(0.001, clip.out - clip.in);
  if (media?.sprite && media.type === 'video' && dur > 0) {
    const scaled = width * (dur / srcLen);
    strip = { backgroundImage: cssUrl(media.sprite.path), backgroundSize: `${scaled}px 100%`, backgroundPosition: `${-(clip.in / dur) * scaled}px 0`, transform: clip.reverse ? 'scaleX(-1)' : undefined };
  } else if (media?.waveform && dur > 0) {
    const scaled = width * (dur / srcLen);
    strip = { backgroundImage: cssUrl(media.waveform), backgroundSize: `${scaled}px 100%`, backgroundPosition: `${-(clip.in / dur) * scaled}px 0`, transform: clip.reverse ? 'scaleX(-1)' : undefined };
  } else if (media?.thumb) {
    strip = { backgroundImage: cssUrl(media.thumb), backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x' };
  }

  const tags: string[] = [];
  if (clip.speed !== 1) tags.push(`${clip.speed < 1 ? clip.speed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : Math.round(clip.speed * 100) / 100}×`);
  if (clip.reverse) tags.push('◀');
  if (clip.muted) tags.push('🔇');
  if (clip.stabilize?.enabled) tags.push('⟲');
  if (clip.subtitles?.enabled && clip.subtitles.segments.length) tags.push('CC');

  return (
    <div
      className={`clip ${clipClass(media, clip)}${selected ? ' selected' : ''}${drag ? ' dragging' : ''}${drag && !drag.valid ? ' invalid' : ''}`}
      style={{ left, width, visibility: movedAway ? 'hidden' : undefined }}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(clip, e.clientX, e.clientY); }}
      title={clip.name}
    >
      <div className="clip-label">
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{clip.kind === 'title' ? 'T' : clip.name}</span>
        {tags.map((tg, i) => <span className="tag" key={i}>{tg}</span>)}
      </div>
      {clip.kind === 'title'
        ? <div className="clip-text">{clip.title?.text}</div>
        : <div className={media?.type === 'audio' ? 'clip-wave' : 'clip-thumbs'} style={strip} />}
      {clip.transition && <div className="transition-mark" title="Übergang" />}
      {media?.info.is360 && clip.pano && <div className="pano-mark">360° {clip.pano.mode === 'flat' ? 'Ausschnitt' : clip.pano.mode === 'equirect' ? 'Panorama' : 'Planet'}</div>}
      <div className="handle l" onPointerDown={(e) => onPointerDown(e, clip, 'trimStart')} />
      <div className="handle r" onPointerDown={(e) => onPointerDown(e, clip, 'trimEnd')} />
    </div>
  );
});
