import React, { useEffect, useRef } from 'react';
import { formatTime, projectDuration } from '@shared/timeline';
import { useProject } from '../store/project';
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

  return (
    <section className="preview">
      <div className="preview-stage">
        <canvas ref={canvasRef} style={{ aspectRatio: `${settings.width} / ${settings.height}` }} />
        {!hasClips && <div className="preview-empty">{t.preview.empty}</div>}
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
