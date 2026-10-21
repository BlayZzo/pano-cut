import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Marker, MediaItem, Project, Track } from '@shared/types';
import { clipDuration, clipEnd, DEFAULT_IMAGE_DURATION, DEFAULT_TITLE_DURATION, formatTime, MIN_CLIP_DURATION, overlaps, projectDuration, sourceLimit } from '@shared/timeline';
import { beginTransaction, endTransaction, setDirty, useProject } from '../store/project';
import { useUi, useView, getView, updateView, ZOOM_MAX, ZOOM_MIN, type DragState } from '../store/ui';
import { Popover } from './Popover';
import { engine, seekTo, stopPlayback } from '../engine/instance';
import { addTitleToTimeline, applyEffectToClips, applyTransitionToClip, deleteSelection, duplicateSelection, splitAtPlayhead, zoomBy, zoomToFit } from '../actions';
import type { TransitionType } from '@shared/types';
import { TITLE_TEMPLATES } from '@shared/pano';
import { t } from '../i18n/de';
import { cssUrl } from '../utils/dom';
import { beatsOnTimeline } from '@shared/beats';
import { DRAG_EFFECT, DRAG_MIME, DRAG_TITLE, DRAG_TRANSITION, getDragging, getDraggingMedia } from '../utils/dnd';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { IconEye, IconEyeOff, IconFit, IconLock, IconMagnet, IconMute, IconPlus, IconScissors, IconTrash, IconUnlock, IconVolume, IconZoomIn, IconZoomOut } from './Icons';

const RULER_H = 24;
const TRACK_SIZES = { small: { video: 40, audio: 30 }, medium: { video: 64, audio: 48 }, large: { video: 100, audio: 72 } } as const;
let trackSize: keyof typeof TRACK_SIZES = 'medium';
const SNAP_PX = 8;
const DIVIDER_H = 6;

function trackHeight(tr: Track): number {
  return tr.kind === 'video' ? TRACK_SIZES[trackSize].video : TRACK_SIZES[trackSize].audio;
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

/** Taktmarken aller Musik-Clips (Timeline-Zeit). */
function collectBeats(project: Project, exclude: Set<string> = new Set()): { beats: number[]; downs: number[] } {
  const beats: number[] = [], downs: number[] = [];
  for (const c of Object.values(project.clips)) {
    if (exclude.has(c.id)) continue;
    const m = project.media[c.mediaId];
    if (!m?.beats || m.beats.beats.length === 0) continue;
    const tr = project.tracks.find((x) => x.id === c.trackId);
    if (!tr || tr.muted || c.muted) continue;
    beats.push(...beatsOnTimeline(m.beats, c, 'beats'));
    downs.push(...beatsOnTimeline(m.beats, c, 'downbeats'));
  }
  return { beats, downs };
}

function snapTargets(project: Project, exclude: Set<string>, playhead: number): number[] {
  const pts = [0, playhead];
  for (const c of Object.values(project.clips)) {
    if (exclude.has(c.id)) continue;
    pts.push(c.start, clipEnd(c));
  }
  // Clips rasten auf den Schlägen der Musik ein
  if (useUi.getState().showBeats) pts.push(...collectBeats(project, exclude).beats);
  // … und immer auf den Markern
  for (const m of project.markers ?? []) pts.push(m.t);
  return pts;
}

/**
 * Neue Plätze für alle gezogenen Clips: gleicher Zeitversatz, und alle wandern um gleich viele Spuren derselben Art.
 * Nur ein Clip / eine Spur: wie bisher auch auf eine andere Spurart (Video ↔ Ton), wenn der Inhalt passt. null = geht nicht.
 */
function planMoves(project: Project, moving: Clip[], grabbed: Clip, target: Track | null, dt: number): Array<{ id: string; start: number; trackId: string }> | null {
  const minStart = Math.min(...moving.map((c) => c.start));
  const d = Math.max(dt, -minStart);
  const src = project.tracks.find((tr) => tr.id === grabbed.trackId);
  const sameTrack = moving.every((c) => c.trackId === grabbed.trackId);
  if (!target || target.locked || !src) return moving.map((c) => ({ id: c.id, start: c.start + d, trackId: c.trackId }));
  if (target.kind !== src.kind) {
    if (!sameTrack) return null;
    return moving.map((c) => {
      const media = project.media[c.mediaId];
      const ok = (target.kind === 'audio' && media?.type !== 'image') || (target.kind === 'video' && media?.type !== 'audio');
      return { id: c.id, start: c.start + d, trackId: ok ? target.id : c.trackId };
    });
  }
  const list = (kind: Track['kind']) => project.tracks.filter((tr) => tr.kind === kind);
  const delta = list(src.kind).findIndex((tr) => tr.id === target.id) - list(src.kind).findIndex((tr) => tr.id === src.id);
  const out: Array<{ id: string; start: number; trackId: string }> = [];
  for (const c of moving) {
    const tr = project.tracks.find((x) => x.id === c.trackId);
    if (!tr) return null;
    const l = list(tr.kind);
    const dest = l[l.findIndex((x) => x.id === tr.id) + delta];
    if (!dest || dest.locked) return null;
    out.push({ id: c.id, start: c.start + d, trackId: dest.id });
  }
  return out;
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
  const placeClips = useProject((s) => s.placeClips);
  const packTracks = useProject((s) => s.packTracks);
  const trimClip = useProject((s) => s.trimClip);
  const removeTrack = useProject((s) => s.removeTrack);
  const updateTrack = useProject((s) => s.updateTrack);
  const moveTrack = useProject((s) => s.moveTrack);

  const zoom = useUi((s) => s.zoom);
  const setZoom = useUi((s) => s.setZoom);
  const snapping = useUi((s) => s.snapping);
  const magnet = useUi((s) => s.magnet);
  const setMagnet = useUi((s) => s.setMagnet);
  const setSnapping = useUi((s) => s.setSnapping);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const toggleSelect = useUi((s) => s.toggleSelect);
  const drag = useUi((s) => s.drag);
  const setDrag = useUi((s) => s.setDrag);
  const rangeIn = useUi((s) => s.rangeIn);
  const rangeOut = useUi((s) => s.rangeOut);
  const showBeats = useUi((s) => s.showBeats);
  const view = useView();
  trackSize = view.trackSize;

  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropPreview, setDropPreview] = useState<{ trackId: string; time: number; media: MediaItem | null; title?: string; transitionClip?: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);

  const offsets = useMemo(() => trackOffsets(project.tracks), [project.tracks, view.trackSize]);
  const beatMarks = useMemo(() => (showBeats ? collectBeats(project) : null), [showBeats, project.clips, project.media, project.tracks]);
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
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
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
      if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSelect(clip.id); ids = useUi.getState().selection; if (!ids.includes(clip.id)) return; }
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
    let movesRef: Array<{ id: string; start: number; trackId: string }> | null = null;

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
        const magnet = useUi.getState().magnet;
        // Zielspur je Clip: alle Clips wandern um gleich viele Spuren (Mehrfachauswahl über mehrere Spuren)
        const placed = planMoves(project, moving, clip, target, dt);
        let valid = !!placed;
        if (placed && !magnet) {
          for (const mv of placed) {
            const c = project.clips[mv.id]!;
            if (overlaps(project, c, mv.start, mv.trackId, copy ? new Set() : exclude)) { valid = false; break; }
          }
        }
        movesRef = placed;
        last = { kind, clipIds: ids, dt, trackId, copy, valid, trackMap: placed ? Object.fromEntries(placed.map((m) => [m.id, m.trackId])) : undefined };
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
        if (!movesRef) return;
        const result = placeClips(movesRef, { copy: last.copy, magnet: useUi.getState().magnet });
        if (last.copy && result.length) select(result);
      } else {
        const side = last.kind === 'trimStart' ? 'start' : 'end';
        trimClip(clip.id, side, (side === 'start' ? clip.start : clipEnd(clip)) + last.dt);
        if (useUi.getState().magnet) packTracks([clip.trackId]);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------- Rahmen aufziehen = mehrere Clips auswählen ----------
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const onEmptyPointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement;
    if (e.button !== 0 || !(e.target === e.currentTarget || el.classList.contains('lane') || el.classList.contains('lanes-content'))) return;
    const sc = scrollRef.current;
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    const pos = (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX - r.left + sc.scrollLeft, y: ev.clientY - r.top + sc.scrollTop });
    const p0 = pos(e);
    if (p0.y < RULER_H) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? useUi.getState().selection : [];
    let rect = { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y };
    const hits = () => {
      const t0 = Math.min(rect.x0, rect.x1) / zoom, t1 = Math.max(rect.x0, rect.x1) / zoom;
      const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
      const lanes = offsets.filter((o) => o.top + o.height > y0 && o.top < y1).map((o) => o.track.id);
      return Object.values(project.clips).filter((c) => lanes.includes(c.trackId) && c.start < t1 && clipEnd(c) > t0).map((c) => c.id);
    };
    const move = (ev: PointerEvent) => {
      const p = pos(ev);
      rect = { ...rect, x1: p.x, y1: p.y };
      if (Math.abs(rect.x1 - rect.x0) + Math.abs(rect.y1 - rect.y0) < 4) return;
      setMarquee(rect);
      select([...new Set([...base, ...hits()])]);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
      if (Math.abs(rect.x1 - rect.x0) + Math.abs(rect.y1 - rect.y0) < 4 && !additive) select([]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------- Drop aus der Mediathek ----------
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(DRAG_MIME) && !types.includes(DRAG_TITLE) && !types.includes(DRAG_TRANSITION) && !types.includes(DRAG_EFFECT)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const track = trackAtClientY(e.clientY);
    if (!track || track.locked) { setDropPreview(null); return; }
    // getData ist in dragover in Chromium leer – die Daten kommen aus dem Drag-Hilfsmodul
    const payload = getDragging();
    if (!payload) return;
    let time = timeAtClientX(e.clientX);
    if (payload.kind === 'transition' || payload.kind === 'effect') {
      const target = Object.values(project.clips).find((c) => c.trackId === track.id && time >= c.start && time < clipEnd(c) && c.kind !== 'title' && project.media[c.mediaId]?.type !== 'audio');
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
    const effectId = e.dataTransfer.getData(DRAG_EFFECT) || (payload?.kind === 'effect' ? payload.id : '');
    if (!mediaId && !titleId && !trType && !effectId) return;
    e.preventDefault();
    const preview = dropPreview;
    setDropPreview(null);
    const track = trackAtClientY(e.clientY);
    if (!track) return;
    const time = preview?.time ?? timeAtClientX(e.clientX);
    if (effectId) {
      const target = preview?.transitionClip ?? Object.values(project.clips).find((c) => c.trackId === track.id && time >= c.start && time < clipEnd(c) && c.kind !== 'title')?.id;
      if (target && applyEffectToClips(effectId, [target])) select([target]);
      return;
    }
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
    if (clip) { select([clip.id]); if (useUi.getState().magnet) packTracks([track.id]); }
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
      { label: t.layers.trackUp, onClick: () => moveTrack(track.id, -1) },
      { label: t.layers.trackDown, onClick: () => moveTrack(track.id, 1) },
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
        <button className={`btn sm${magnet ? ' active' : ''}`} title={t.timeline.magnetHint} onClick={() => { const on = !magnet; setMagnet(on); if (on) packTracks(project.tracks.map((tr) => tr.id)); }}>⇤ {t.timeline.magnet}</button>
        <div className="sep" />
        <button className="btn sm icon ghost" title={t.timeline.zoomOut} onClick={() => zoomBy(1 / 1.3)}><IconZoomOut /></button>
        <input type="range" min={0} max={100} value={zoomToSlider(zoom)} onChange={(e) => setZoom(sliderToZoom(Number(e.target.value)))} style={{ width: 110, accentColor: 'var(--accent)' }} title="Zoom" />
        <button className="btn sm icon ghost" title={t.timeline.zoomIn} onClick={() => zoomBy(1.3)}><IconZoomIn /></button>
        <button className="btn sm icon ghost" title={t.timeline.zoomFit} onClick={() => zoomToFit(viewWidth)}><IconFit /></button>
        <Popover label={`⚙ ${t.view.button}`} title={t.view.timelineTitle}>
          <div className="form-grid compact">
            <label>{t.view.trackSize}</label>
            <select value={view.trackSize} onChange={(e) => updateView({ trackSize: e.target.value as 'small' | 'medium' | 'large' })}>
              <option value="small">{t.view.small}</option><option value="medium">{t.view.medium}</option><option value="large">{t.view.large}</option>
            </select>
          </div>
          <label className="toggle"><input type="checkbox" checked={view.thumbnails} onChange={(e) => updateView({ thumbnails: e.target.checked })} /> {t.view.thumbnails}</label>
          <label className="toggle"><input type="checkbox" checked={view.waveforms} onChange={(e) => updateView({ waveforms: e.target.checked })} /> {t.view.waveforms}</label>
          <label className="toggle"><input type="checkbox" checked={view.followPlayhead} onChange={(e) => updateView({ followPlayhead: e.target.checked })} /> {t.view.follow}</label>
          <label className="toggle"><input type="checkbox" checked={snapping} onChange={(e) => setSnapping(e.target.checked)} /> {t.timeline.snap}</label>
          <div className="hint">{t.view.zoomHint}</div>
        </Popover>
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
                  <span className="track-order">
                    <button title={t.layers.trackUp} onClick={() => moveTrack(track.id, -1)}>▲</button>
                    <button title={t.layers.trackDown} onClick={() => moveTrack(track.id, 1)}>▼</button>
                  </span>
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
          onPointerDown={onEmptyPointerDown}>
          <div className="lanes-content" style={{ width: contentWidth, height: contentHeight }}>
            <Ruler zoom={zoom} width={contentWidth} fps={fps} onPointerDown={onRulerPointerDown} rangeIn={rangeIn} rangeOut={rangeOut}>
              {beatMarks && beatMarks.beats.length > 0 && <BeatMarks marks={beatMarks} zoom={zoom} part="ruler" />}
              {project.markers && project.markers.length > 0 && <MarkerFlags markers={project.markers} zoom={zoom} />}
            </Ruler>
            {project.markers && project.markers.length > 0 && <div className="marker-lines">{project.markers.map((m) => <div key={m.id} className={`marker-line ${m.kind ?? 'user'}`} style={{ left: m.t * zoom, height: contentHeight }} />)}</div>}
            {beatMarks && beatMarks.beats.length > 0 && <BeatMarks marks={beatMarks} zoom={zoom} part="lines" height={contentHeight} />}
            {offsets.map(({ track, height, top }, i) => (
              <React.Fragment key={track.id}>
                {i > 0 && offsets[i - 1].track.kind !== track.kind && <div className="track-divider" style={{ position: 'absolute', top: top - DIVIDER_H, left: 0, right: 0 }} />}
                <Lane
                  track={track}
                  top={top}
                  height={height}
                  project={project}
                  zoom={zoom}
                  strips={(view.thumbnails ? 1 : 0) | (view.waveforms ? 2 : 0)}
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
            {marquee && <div className="marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
            <Playhead zoom={zoom} scrollRef={scrollRef} />
          </div>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
    </section>
  );
}

function zoomToSlider(zoom: number): number {
  return Math.round(((Math.log(zoom) - Math.log(ZOOM_MIN)) / (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN))) * 100);
}
function sliderToZoom(v: number): number {
  return Math.exp(Math.log(ZOOM_MIN) + (v / 100) * (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN)));
}

// ---------- Lineal ----------

function Ruler({ zoom, width, fps, onPointerDown, rangeIn, rangeOut, children }: { zoom: number; width: number; fps: number; onPointerDown: (e: React.PointerEvent) => void; rangeIn: number | null; rangeOut: number | null; children?: React.ReactNode }): React.ReactElement {
  const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
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
      {children}
    </div>
  );
}

/** Taktmarken im Lineal und schwache Linien durch die Spuren. */
/** Marker in der Zeitleiste: ziehen = verschieben (rastet auf Clips/Abspielkopf ein), Doppelklick = löschen. */
function MarkerFlags({ markers, zoom }: { markers: Marker[]; zoom: number }): React.ReactElement {
  const down = (e: React.PointerEvent, m: Marker) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const ruler = el.parentElement!.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    let moved = false;
    beginTransaction();
    const move = (ev: PointerEvent) => {
      moved = true;
      let t = Math.max(0, (ev.clientX - ruler.left) / zoom);
      if (useUi.getState().snapping && !ev.altKey) {
        const project = useProject.getState().project;
        const pts = [0, useUi.getState().playhead];
        for (const c of Object.values(project.clips)) pts.push(c.start, clipEnd(c));
        if (useUi.getState().showBeats) pts.push(...collectBeats(project).beats);
        t = snapValue(t, pts, SNAP_PX / zoom).value;
      }
      useProject.getState().moveMarker(m.id, t);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      endTransaction();
      if (moved) setDirty(true);
      else { useUi.getState().setPlayhead(m.t); seekTo(m.t); }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className="marker-flags">
      {markers.map((m) => (
        <div key={m.id} className={`marker-flag ${m.kind ?? 'user'}`} style={{ left: m.t * zoom }} title={t.timeline.markerHint}
          onPointerDown={(e) => down(e, m)}
          onDoubleClick={(e) => { e.stopPropagation(); useProject.getState().removeMarker(m.id); setDirty(true); }} />
      ))}
    </div>
  );
}

function BeatMarks({ marks, zoom, part, height = 0 }: { marks: { beats: number[]; downs: number[] }; zoom: number; part: 'ruler' | 'lines'; height?: number }): React.ReactElement | null {
  const downSet = new Set(marks.downs.map((d) => d.toFixed(3)));
  const spacing = marks.beats.length > 1 ? ((marks.beats[marks.beats.length - 1] - marks.beats[0]) / (marks.beats.length - 1)) * zoom : 99;
  const showAll = spacing >= 5;
  if (spacing * 4 < 5) return null;
  const items: React.ReactNode[] = [];
  const lines: React.ReactNode[] = [];
  for (const b of marks.beats) {
    const down = downSet.has(b.toFixed(3));
    if (!down && !showAll) continue;
    if (part === 'ruler') items.push(<div key={`m${b.toFixed(3)}`} className={`beat-mark${down ? ' down' : ''}`} style={{ left: b * zoom }} />);
    else if (down || spacing >= 14) lines.push(<div key={`l${b.toFixed(3)}`} className={`beat-line${down ? ' down' : ''}`} style={{ left: b * zoom }} />);
  }
  if (part === 'ruler') return <div className="beat-marks">{items}</div>;
  return <div className="beat-lines" style={{ top: RULER_H, height: height - RULER_H }}>{lines}</div>;
}

function Playhead({ zoom, scrollRef }: { zoom: number; scrollRef: React.RefObject<HTMLDivElement> }): React.ReactElement {
  const playhead = useUi((s) => s.playhead);
  // Während der Wiedergabe mitscrollen
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !engine.isPlaying || !getView().followPlayhead) return;
    const x = playhead * zoom;
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.1);
  }, [playhead, zoom, scrollRef]);
  return <div className="playhead" style={{ left: playhead * zoom }} />;
}

// ---------- Spur ----------

interface LaneProps {
  strips: number;   // 1 = Vorschaubilder, 2 = Tonwellen
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

const Lane = React.memo(function Lane({ track, top, height, project, zoom, strips, selection, drag, dropPreview, onClipPointerDown, onClipContextMenu }: LaneProps): React.ReactElement {
  const clips = useMemo(() => Object.values(project.clips).filter((c) => c.trackId === track.id), [project.clips, track.id]);
  const dragTarget = drag?.kind === 'move' && (drag.trackMap ? Object.values(drag.trackMap).includes(track.id) : drag.trackId === track.id);
  // Clips, die per Spurwechsel hierher gezogen werden (Geister)
  const incoming = dragTarget && drag ? drag.clipIds.map((id) => project.clips[id]).filter((c) => c && c.trackId !== track.id && (drag.trackMap ? drag.trackMap[c.id] === track.id : true)) as Clip[] : [];
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
            strips={strips}
            selected={selection.includes(clip.id) || dropPreview?.transitionClip === clip.id}
            drag={inDrag}
            movedAway={!!inDrag && inDrag.kind === 'move' && !inDrag.copy && (inDrag.trackMap ? inDrag.trackMap[clip.id] !== track.id : !!inDrag.trackId && inDrag.trackId !== track.id)}
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
  const base = media.type === 'audio' ? 'audio' : media.type === 'image' ? 'image' : '';
  return clip?.mc ? `${base} mc-piece` : base;
}

// ---------- Clip ----------

interface ClipProps {
  strips: number;
  clip: Clip;
  media: MediaItem | undefined;
  zoom: number;
  selected: boolean;
  drag: DragState | null;
  movedAway: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, kind: DragState['kind']) => void;
  onContextMenu: (clip: Clip, x: number, y: number) => void;
}

const TimelineClip = React.memo(function TimelineClip({ clip, media, zoom, strips, selected, drag, movedAway, onPointerDown, onContextMenu }: ClipProps): React.ReactElement {
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
  const thumbs = (strips & 1) !== 0, waves = (strips & 2) !== 0;
  if (!thumbs && media?.type !== 'audio') { /* keine Vorschaubilder */ }
  else if (!waves && media?.type === 'audio') { /* keine Tonwelle */ }
  else if (media?.sprite && media.type === 'video' && dur > 0) {
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
  if (media?.vfx) tags.push(media.vfxRole === 'light' ? '☀' : '✦');
  if (clip.link) tags.push('🔗');
  if (clip.blend && clip.blend !== 'normal') tags.push('◐');
  if (clip.cutout?.enabled) tags.push('✂');

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
