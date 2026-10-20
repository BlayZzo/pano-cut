// 🎯 Verfolgen in der Vorschau: Rechteck um das Objekt ziehen → das Programm verfolgt es; bei 360° folgt der Blick,
// bei normalen Videos entsteht eine Objekt-Spur und auf Wunsch ein mitlaufender Ausschnitt.
import React, { useEffect, useRef, useState } from 'react';
import type { Clip, MediaItem } from '@shared/types';
import { clipDuration, formatTime } from '@shared/timeline';
import { defaultPano, panoMatrix, panoViewAt, verticalFov } from '@shared/pano';
import { hasReframe, reframeAt, reframeRect } from '@shared/reframe';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { followObject, samplesToPano, samplesToReframe, samplesToTrack, type FollowStart } from '../ai/follow';
import { clipBox, canvasToSource } from './previewTools';
import { seekTo } from '../engine/instance';

interface Props { clip: Clip; media: MediaItem; canvas: HTMLCanvasElement; onClose: () => void }

export function FollowTool({ clip, media, canvas, onClose }: Props): React.ReactElement {
  const settings = useProject((s) => s.project.settings);
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [running, setRunning] = useState<{ percent: number; lost: boolean } | null>(null);
  const [follow, setFollow] = useState(true);
  const [followPitch, setFollowPitch] = useState(true);
  const [zoom, setZoom] = useState(1.6);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const signal = useRef({ cancelled: false });
  const is360 = !!media.info.is360;

  useEffect(() => () => { signal.current.cancelled = true; }, []);

  const toStart = (r: { x0: number; y0: number; x1: number; y1: number }): FollowStart | null => {
    const cr = canvas.getBoundingClientRect();
    const W = canvas.width, H = canvas.height;
    const px = (x: number) => ((x - cr.left) / cr.width) * W, py = (y: number) => ((y - cr.top) / cr.height) * H;
    const ax = px(Math.min(r.x0, r.x1)), bx = px(Math.max(r.x0, r.x1)), ay = py(Math.min(r.y0, r.y1)), by = py(Math.max(r.y0, r.y1));
    if (bx - ax < 6 || by - ay < 6) return null;
    const local = Math.max(0, Math.min(clipDuration(clip), useUi.getState().playhead - clip.start));
    if (is360) {
      const pano = clip.pano ?? defaultPano('flat');
      const view = panoViewAt(pano, local);
      const cx = (ax + bx) / 2, cy = (ay + by) / 2;
      let d: number[];
      let size: number;
      if (pano.mode === 'equirect') {
        const lon = ((cx / W) * 2 - 1) * Math.PI, lat = ((cy / H) * 2 - 1) * (Math.PI / 2);
        d = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
        size = ((bx - ax) / W) * 360;
      } else {
        const hf = view.fov, vf = verticalFov(hf, W, H);
        d = [((cx / W) * 2 - 1) * Math.tan((hf * Math.PI) / 360), ((cy / H) * 2 - 1) * Math.tan((vf * Math.PI) / 360), 1];
        size = ((bx - ax) / W) * hf;
      }
      const R = panoMatrix(view.yaw, view.pitch, view.roll);
      const w = [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
      const n = Math.hypot(w[0], w[1], w[2]);
      return { local, dir: { yaw: (Math.atan2(w[0], w[2]) * 180) / Math.PI, pitch: (-Math.asin(w[1] / n) * 180) / Math.PI, size } };
    }
    // normal: Ecken ins Quellbild umrechnen (mit Ausschnitt-Fahrt bzw. Lage/Zuschnitt des Clips)
    let u0: number, v0: number, u1: number, v1: number;
    if (hasReframe(clip)) {
      const rr = reframeRect(reframeAt(clip.reframe!, local), media.info.width, media.info.height, W / H);
      u0 = rr.x + (ax / W) * rr.w; u1 = rr.x + (bx / W) * rr.w; v0 = rr.y + (ay / H) * rr.h; v1 = rr.y + (by / H) * rr.h;
    } else {
      const box = clipBox(clip, media, W, H);
      if (!box) return null;
      const a = canvasToSource(box, clip, ax, ay), b = canvasToSource(box, clip, bx, by);
      u0 = Math.min(a.u, b.u); u1 = Math.max(a.u, b.u); v0 = Math.min(a.v, b.v); v1 = Math.max(a.v, b.v);
    }
    return { local, box: { x: u0, y: v0, w: u1 - u0, h: v1 - v0 } };
  };

  const run = async (start: FollowStart) => {
    signal.current = { cancelled: false };
    setRunning({ percent: 0, lost: false });
    try {
      const samples = await followObject(clip, media, start, (p) => {
        setRunning({ percent: p.percent, lost: p.lost });
        const vc = viewRef.current;
        if (vc) vc.getContext('2d')?.drawImage(p.view, 0, 0, vc.width, vc.height);
      }, signal.current);
      if (signal.current.cancelled && samples.length < 3) { onClose(); return; }
      const last = samples[samples.length - 1]?.t ?? start.local;
      const st = useProject.getState();
      const cur = st.project.clips[clip.id] ?? clip;
      beginTransaction();
      if (is360) {
        if (follow) {
          const pano = cur.pano ?? defaultPano('flat');
          const fov = panoViewAt(pano, start.local).fov;
          const basePitch = panoViewAt(pano, start.local).pitch;
          const keys = samplesToPano(samples, fov, followPitch, basePitch);
          const before = pano.keyframes.filter((k) => k.t < start.local - 1e-3);
          const after = pano.keyframes.filter((k) => k.t > last + 1e-3);
          st.setPano(cur.id, { ...pano, keyframes: [...before, ...keys, ...after], ease: 'linear', smooth: true });
        }
      } else {
        st.addObjectTrack(cur.id, samplesToTrack(samples));
        if (follow) {
          const keys = samplesToReframe(samples, zoom, media.info.width, media.info.height, settings.width / settings.height);
          const old = cur.reframe?.keyframes ?? [];
          useProject.getState().updateClip(cur.id, { reframe: { ease: 'linear', keyframes: [...old.filter((k) => k.t < start.local - 1e-3), ...keys, ...old.filter((k) => k.t > last + 1e-3)] } });
        }
      }
      endTransaction();
      const lostEarly = last < clipDuration(clip) - 0.3 && !signal.current.cancelled;
      useUi.getState().toast(fmt(lostEarly ? t.follow.lostAt : t.follow.done, { t: formatTime(last, settings.fps) }), lostEarly ? 'info' : 'success');
      seekTo(clip.start + start.local);
    } catch (e) {
      useUi.getState().toast((e as Error).message, 'error');
    }
    onClose();
  };

  const onDown = (e: React.PointerEvent) => {
    if (running || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const r0 = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    setRect(r0);
    let cur = r0;
    const move = (ev: PointerEvent) => { cur = { ...cur, x1: ev.clientX, y1: ev.clientY }; setRect(cur); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const s = toStart(cur);
      if (!s) { setRect(null); return; }
      void run(s);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const stage = canvas.parentElement?.getBoundingClientRect();
  const box = rect && stage ? { left: Math.min(rect.x0, rect.x1) - stage.left, top: Math.min(rect.y0, rect.y1) - stage.top, width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) } : null;
  return (
    <div className="follow-layer" onPointerDown={onDown}>
      {box && !running && <div className="follow-rect" style={box} />}
      <div className="follow-bar" onPointerDown={(e) => e.stopPropagation()}>
        {running ? (
          <>
            <canvas ref={viewRef} width={120} height={120} className={`follow-view${running.lost ? ' lost' : ''}`} />
            <div className="follow-status">
              <strong>🎯 {running.lost ? t.follow.searching : t.follow.running}</strong>
              <div className="progress"><div style={{ width: `${running.percent}%` }} /></div>
              <span>{Math.round(running.percent)} %</span>
            </div>
            <button className="btn sm" onClick={() => { signal.current.cancelled = true; }}>{t.follow.stop}</button>
          </>
        ) : (
          <>
            <span>🎯 {t.follow.drawHint}</span>
            <label className="toggle"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {is360 ? t.follow.camera360 : t.follow.cameraFlat}</label>
            {is360 && <label className="toggle"><input type="checkbox" checked={followPitch} onChange={(e) => setFollowPitch(e.target.checked)} /> {t.follow.pitch}</label>}
            {!is360 && follow && (
              <label className="toggle">{t.follow.zoom} <input type="range" min={1.1} max={3} step={0.1} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} style={{ width: 70 }} /> {zoom.toFixed(1).replace('.', ',')}×</label>
            )}
            <button className="btn sm ghost" onClick={onClose}>{t.common.cancel}</button>
          </>
        )}
      </div>
    </div>
  );
}
