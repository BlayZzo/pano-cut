import React, { useEffect, useRef, useState } from 'react';
import { clipDuration, formatTime, projectDuration } from '@shared/timeline';
import { keyframeAt, panoViewAt, upsertKeyframe } from '@shared/pano';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { engine, playPause } from '../engine/instance';
import { goEnd, goStart, stepFrames } from '../actions';
import { t } from '../i18n/de';
import { IconLoop, IconPause, IconPlay, IconSkipBack, IconSkipFwd, IconStepBack, IconStepFwd } from './Icons';

export function Preview(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settings = useProject((s) => s.project.settings);
  const hasClips = useProject((s) => Object.keys(s.project.clips).length > 0);
  const duration = useProject((s) => projectDuration(s.project));
  const playing = useUi((s) => s.playing);
  const loop = useUi((s) => s.loop);
  const setLoop = useUi((s) => s.setLoop);
  const selection = useUi((s) => s.selection);
  const playhead = useUi((s) => s.playhead);
  const clips = useProject((s) => s.project.clips);
  const media = useProject((s) => s.project.media);
  const setPano = useProject((s) => s.setPano);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    // Vorschau intern maximal in Full HD rendern (schneller, der Export bleibt in voller Größe)
    const k = Math.min(1, 1920 / settings.width, 1920 / settings.height);
    c.width = Math.round((settings.width * k) / 2) * 2;
    c.height = Math.round((settings.height * k) / 2) * 2;
    engine.setCanvas(c);
    return () => engine.setCanvas(null);
  }, [settings.width, settings.height]);

  // 360°-Clip unter dem Abspielkopf, der ausgewählt ist → mit der Maus umschauen
  const panoClip = selection.map((id) => clips[id]).find((c) => c && c.pano && media[c.mediaId]?.info.is360 && playhead >= c.start && playhead < c.start + clipDuration(c));

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!panoClip || e.button !== 0) return;
    const clip = panoClip;
    const pano = clip.pano!;
    const local = Math.max(0, Math.min(clipDuration(clip), playhead - clip.start));
    const base = keyframeAt(pano, local) ?? (pano.keyframes.length === 1 ? pano.keyframes[0] : { t: local, ...panoViewAt(pano, local) });
    const startX = e.clientX, startY = e.clientY;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const degPerPx = (pano.mode === 'equirect' ? 360 : base.fov) / Math.max(1, rect.width);
    beginTransaction();
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      const yaw = ((base.yaw - dx * degPerPx + 540) % 360) - 180;
      const pitch = Math.max(-90, Math.min(90, base.pitch + dy * degPerPx));
      setPano(clip.id, upsertKeyframe(pano, { ...base, yaw, pitch }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      endTransaction();
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!panoClip || panoClip.pano!.mode === 'equirect') return;
    e.preventDefault();
    const clip = panoClip;
    const pano = clip.pano!;
    const local = Math.max(0, Math.min(clipDuration(clip), playhead - clip.start));
    const base = keyframeAt(pano, local) ?? (pano.keyframes.length === 1 ? pano.keyframes[0] : { t: local, ...panoViewAt(pano, local) });
    const min = pano.mode === 'littleplanet' ? 120 : 30;
    const max = pano.mode === 'littleplanet' ? 320 : 150;
    const fov = Math.max(min, Math.min(max, base.fov + e.deltaY * 0.05));
    setPano(clip.id, upsertKeyframe(pano, { ...base, fov }));
  };

  return (
    <section className="preview">
      <div className={`preview-stage${panoClip ? ' pano' : ''}${dragging ? ' dragging' : ''}`}>
        <canvas ref={canvasRef} style={{ aspectRatio: `${settings.width} / ${settings.height}` }} onPointerDown={onPointerDown} onWheel={onWheel} />
        {!hasClips && <div className="preview-empty">{t.preview.empty}</div>}
        {panoClip && <div className="preview-badge">360° · ziehen = umschauen · Mausrad = zoomen</div>}
      </div>
      <div className="transport">
        <Timecode />
        <div className="spacer" />
        <button className="btn icon ghost" title={t.preview.toStart} onClick={goStart}><IconSkipBack /></button>
        <button className="btn icon ghost" title={t.preview.prevFrame} onClick={() => stepFrames(-1)}><IconStepBack /></button>
        <button className="btn icon primary" title={playing ? t.preview.pause : t.preview.play} onClick={playPause} disabled={duration <= 0} style={{ width: 40 }}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="btn icon ghost" title={t.preview.nextFrame} onClick={() => stepFrames(1)}><IconStepFwd /></button>
        <button className="btn icon ghost" title={t.preview.toEnd} onClick={goEnd}><IconSkipFwd /></button>
        <div className="spacer" />
        <button className={`btn icon ghost${loop ? ' active' : ''}`} title={t.preview.loop} onClick={() => setLoop(!loop)}><IconLoop /></button>
        <span className="timecode dim">{formatTime(duration, settings.fps)}</span>
      </div>
    </section>
  );
}

function Timecode(): React.ReactElement {
  const playhead = useUi((s) => s.playhead);
  const fps = useProject((s) => s.project.settings.fps);
  return <span className="timecode">{formatTime(playhead, fps)}</span>;
}
