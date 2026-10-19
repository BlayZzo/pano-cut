import React, { useEffect, useRef, useState } from 'react';
import type { Model3DAnimation, Model3DSpec } from '@shared/types';
import { defaultModelSpec, MODEL_ANIMATIONS, MODEL_EXTENSIONS, modelFormat } from '@shared/model3d';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { IconClose } from './Icons';
import { cancelModelRender, insertModelClip, lightFromVideo, renderModel, rerenderModel, sharedStage } from '../three/actions';

const PREVIEW_W = 296, PREVIEW_H = 222;

/** Fenster „3D-Objekt“: Modell ansehen, Bewegung/Licht einstellen, als Ebene ins Video rendern. */
export function Model3DPanel(): React.ReactElement | null {
  const panel = useUi((s) => s.modelPanel);
  const setPanel = useUi((s) => s.setModelPanel);
  const settings = useProject((s) => s.project.settings);
  const editMedia = useProject((s) => (panel?.mediaId ? s.project.media[panel.mediaId] : undefined));
  const [spec, setSpec] = useState<Model3DSpec | null>(null);
  const [info, setInfo] = useState<{ triangles: number; clips: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ percent: number; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const specRef = useRef<Model3DSpec | null>(null);
  specRef.current = spec;

  // Einstellungen beim Öffnen: bestehendes Modell oder neue Datei
  useEffect(() => {
    if (!panel) { setSpec(null); setInfo(null); setError(null); return; }
    if (editMedia?.model3d) setSpec({ ...editMedia.model3d });
    else if (panel.file) setSpec(defaultModelSpec(panel.file, settings.width, settings.height, settings.fps));
    else setSpec(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel?.file, panel?.mediaId]);

  // Modell laden
  useEffect(() => {
    if (!spec?.file) return;
    let alive = true;
    setLoading(true); setError(null);
    sharedStage()
      .then(async (st) => {
        await st.load(spec);
        if (!alive) return;
        const inf = st.info;
        setInfo(inf);
        // Modelle mit eigener Animation (tanzende Figur, fahrendes Auto …): diese standardmäßig abspielen
        if (inf && inf.clips.length > 0 && !panel?.mediaId) setSpec((s) => (s && s.animation === 'turntable' ? { ...s, animation: 'embedded' } : s));
      })
      .catch((e) => { if (alive) setError(fmt(t.model3d.loadFailed, { msg: (e as Error).message })); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [spec?.file, spec?.format]);

  // Laufende Vorschau (Schleife über die Dauer)
  useEffect(() => {
    if (!spec?.file || loading || error) return;
    let raf = 0, alive = true;
    const t0 = performance.now();
    void sharedStage().then((st) => {
      const tick = () => {
        if (!alive) return;
        const s = specRef.current;
        const c = canvasRef.current;
        if (s && c && !busy) {
          const tt = ((performance.now() - t0) / 1000) % Math.max(0.1, s.duration);
          const ph = Math.round((PREVIEW_W * s.height) / s.width / 2) * 2;
          st.draw(s, tt, PREVIEW_W, ph);
          const ctx = c.getContext('2d')!;
          ctx.clearRect(0, 0, c.width, c.height);
          ctx.drawImage(st.canvas, 0, (c.height - ph) / 2, PREVIEW_W, ph);
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [spec?.file, loading, error, busy]);

  if (!panel) return null;
  const upd = (p: Partial<Model3DSpec>) => setSpec((s) => (s ? { ...s, ...p } : s));

  const pickFile = async () => {
    const f = await window.panocut.selectFile(t.model3d.pickTitle, MODEL_EXTENSIONS);
    if (f && modelFormat(f)) setPanel({ file: f });
  };
  const run = async () => {
    if (!spec) return;
    setBusy({ percent: 0, message: t.model3d.rendering });
    try {
      if (panel.mediaId && editMedia?.model3d) {
        await rerenderModel(panel.mediaId, spec, (percent, message) => setBusy({ percent, message }));
      } else {
        const media = await renderModel(spec, undefined, (percent, message) => setBusy({ percent, message }));
        insertModelClip(media);
      }
      setPanel(null);
    } catch (e) {
      if ((e as Error).message !== 'Abgebrochen') useUi.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const match = async () => {
    const l = await lightFromVideo();
    if (!l) { useUi.getState().toast(t.model3d.noScene, 'error'); return; }
    upd(l);
    useUi.getState().toast(t.model3d.matched, 'success');
  };
  const slider = (label: string, key: keyof Model3DSpec, min: number, max: number, step: number, show: (v: number) => string) => (
    <div className="field">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={Number(spec?.[key] ?? 0)} onChange={(e) => upd({ [key]: parseFloat(e.target.value) } as Partial<Model3DSpec>)} />
      <span className="num-label">{show(Number(spec?.[key] ?? 0))}</span>
    </div>
  );

  return (
    <div className="ai-panel model-panel">
      <div className="ai-panel-header">
        <strong>🧊 {t.model3d.title}{spec ? `: ${spec.name}` : ''}</strong>
        <div className="spacer" />
        <button className="btn icon ghost sm" onClick={() => setPanel(null)} disabled={!!busy}><IconClose /></button>
      </div>
      {!spec && (
        <>
          <button className="btn primary" onClick={() => void pickFile()}>{t.model3d.pick}</button>
          <div className="hint">{t.model3d.pickHint}</div>
        </>
      )}
      {spec && (
        <>
          <div className="model-view">
            <canvas ref={canvasRef} width={PREVIEW_W} height={PREVIEW_H} />
            {loading && <span className="model-view-msg">{t.model3d.loading}</span>}
            {error && <span className="model-view-msg error">{error}</span>}
          </div>
          {info && <div className="hint">{fmt(t.model3d.triangles, { n: info.triangles.toLocaleString('de-DE') })}</div>}
          {busy ? (
            <div>
              <div className="hint">{busy.message}</div>
              <div className="progress"><div style={{ width: `${busy.percent}%` }} /></div>
              <button className="btn sm" style={{ marginTop: 6 }} onClick={cancelModelRender}>{t.model3d.cancel}</button>
            </div>
          ) : (
            <>
              <div className="field">
                <label>{t.model3d.animation}</label>
                <select value={spec.animation} onChange={(e) => upd({ animation: e.target.value as Model3DAnimation })} style={{ gridColumn: '2 / span 2' }}>
                  {MODEL_ANIMATIONS.filter((a) => a.id !== 'embedded' || (info?.clips.length ?? 0) > 0).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              {spec.animation === 'embedded' && info && info.clips.length > 1 && (
                <div className="field">
                  <label>{t.model3d.clip}</label>
                  <select value={spec.clipIndex} onChange={(e) => upd({ clipIndex: Number(e.target.value) })} style={{ gridColumn: '2 / span 2' }}>
                    {info.clips.map((c, i) => <option key={i} value={i}>{c}</option>)}
                  </select>
                </div>
              )}
              {slider(t.model3d.duration, 'duration', 1, 20, 0.5, (v) => `${v.toFixed(1)} s`)}
              {spec.animation !== 'none' && slider(t.model3d.speed, 'speed', 0.25, 4, 0.25, (v) => `${v}×`)}
              {slider(t.model3d.yaw, 'yaw', -180, 180, 1, (v) => `${v}°`)}
              {slider(t.model3d.pitch, 'pitch', -10, 70, 1, (v) => `${v}°`)}
              <div className="music-auto">
                <div className="music-auto-title">{t.model3d.light}</div>
                <button className="btn sm" onClick={() => void match()}>{t.model3d.matchLight}</button>
                {slider(t.model3d.lightYaw, 'lightYaw', -180, 180, 1, (v) => `${v}°`)}
                {slider(t.model3d.lightPitch, 'lightPitch', 5, 90, 1, (v) => `${v}°`)}
                {slider(t.model3d.lightStrength, 'lightStrength', 0, 5, 0.05, (v) => v.toFixed(2))}
                {slider(t.model3d.ambient, 'ambient', 0, 2, 0.05, (v) => v.toFixed(2))}
                {slider(t.model3d.exposure, 'exposure', -2, 2, 0.05, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`)}
                {slider(t.model3d.shadow, 'shadow', 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`)}
                <div className="field">
                  <label>{t.model3d.lightColor}</label>
                  <input type="color" value={spec.lightColor} onChange={(e) => upd({ lightColor: e.target.value })} style={{ gridColumn: '2 / span 2' }} />
                </div>
              </div>
              {(spec.format === 'stl' || spec.format === 'obj') && (
                <>
                  <div className="field">
                    <label>{t.model3d.color}</label>
                    <input type="color" value={spec.color ?? '#b8bcc4'} onChange={(e) => upd({ color: e.target.value })} style={{ gridColumn: '2 / span 2' }} />
                  </div>
                  {slider(t.model3d.metal, 'metal', 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`)}
                </>
              )}
              <button className="btn primary" disabled={loading || !!error} onClick={() => void run()}>{panel.mediaId ? t.model3d.rerender : t.model3d.insert}</button>
            </>
          )}
        </>
      )}
    </div>
  );
}
