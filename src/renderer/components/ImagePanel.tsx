// Bild-Assistent: analysiert einen Clip (sehr dunkel/hell, schwankend, Farbstich …) und passt ihn automatisch an.
import React, { useEffect, useRef, useState } from 'react';
import type { CameraProfile, Clip, ColorGrade, MediaItem } from '@shared/types';
import { clipDuration, defaultColor } from '@shared/timeline';
import { CAMERA_PROFILES, bakeGradeLut, exposureGainAt, frameStats, gradeForLut, sampleLut } from '@shared/color';
import { FINDING_TEXT, analyzeClip, rescueGrade, type Analysis, type Sample } from '@shared/rescue';
import { NEUTRAL_FX } from '@shared/effects';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi, usePlayheadCoarse } from '../store/ui';
import { engine } from '../engine/instance';
import { t } from '../i18n/de';
import { IconClose } from './Icons';

interface AnalysisState { key: string; samples: Sample[]; analysis: Analysis; frames: Array<{ t: number; img: ImageData }> }

/** Clip an mehreren Stellen abtasten. */
async function sampleClip(clip: Clip, media: MediaItem): Promise<{ samples: Sample[]; frames: Array<{ t: number; img: ImageData }> }> {
  const dur = clipDuration(clip);
  const n = media.type === 'image' ? 1 : Math.max(5, Math.min(36, Math.round(dur / 0.6)));
  const samples: Sample[] = [];
  const frames: Array<{ t: number; img: ImageData }> = [];
  for (let i = 0; i < n; i++) {
    const tt = n === 1 ? 0 : (dur * (i + 0.5)) / n;
    const img = await engine.grabFrame(clip, media, tt, 240);
    if (!img) continue;
    samples.push({ t: tt, stats: frameStats(img.data) });
    frames.push({ t: tt, img });
  }
  return { samples, frames };
}

/** Histogramm eines Bildes nach Anwendung einer Farbeinstellung (für die Vorher/Nachher-Anzeige). */
function gradedHistogram(img: ImageData, grade: ColorGrade, gain: number): Uint32Array {
  const lut = bakeGradeLut(gradeForLut(grade), null, 17);
  const hist = new Uint32Array(256);
  const d = img.data;
  for (let i = 0; i < d.length; i += 8) {
    const [r, g, b] = sampleLut(lut, (d[i] / 255) * gain, (d[i + 1] / 255) * gain, (d[i + 2] / 255) * gain);
    hist[Math.min(255, Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) * 255))]++;
  }
  return hist;
}

function drawHistogram(c: HTMLCanvasElement, before: Uint32Array | undefined, after: Uint32Array | undefined): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f1218';
  ctx.fillRect(0, 0, W, H);
  const draw = (h: Uint32Array, color: string) => {
    let max = 1;
    for (let i = 2; i < 254; i++) max = Math.max(max, h[i]);
    ctx.fillStyle = color;
    for (let i = 0; i < 256; i++) {
      const v = Math.min(1, h[i] / max);
      const x = (i / 256) * W;
      ctx.fillRect(x, H - v * H, W / 256 + 0.5, v * H);
    }
  };
  if (before) draw(before, 'rgba(154,163,181,0.55)');
  if (after) draw(after, 'rgba(61,214,193,0.6)');
}

export function ImagePanel(): React.ReactElement | null {
  const open = useUi((s) => s.imagePanel);
  const setOpen = useUi((s) => s.setImagePanel);
  const selection = useUi((s) => s.selection);
  const playhead = usePlayheadCoarse(0.5);
  const toast = useUi((s) => s.toast);
  const clip = useProject((s) => selection.map((id) => s.project.clips[id]).find((c) => c && c.kind !== 'title') ?? null);
  const media = useProject((s) => (clip ? s.project.media[clip.mediaId] ?? null : null));
  const updateClip = useProject((s) => s.updateClip);
  const [state, setState] = useState<AnalysisState | null>(null);
  const [busy, setBusy] = useState(false);
  const [strength, setStrength] = useState(1);
  const [dynamic, setDynamic] = useState(true);
  const [denoise, setDenoise] = useState(true);
  const [color, setColor] = useState(true);
  const [applied, setApplied] = useState(false);
  const histRef = useRef<HTMLCanvasElement>(null);
  const key = clip && media ? `${clip.id}:${clip.in}:${clip.out}:${clip.speed}:${media.id}` : '';
  const usable = !!clip && !!media && media.type !== 'audio';

  // Analyse beim Öffnen bzw. wenn sich der Clip ändert
  useEffect(() => {
    if (!open || !usable || state?.key === key) return;
    let alive = true;
    setBusy(true);
    setApplied(false);
    void sampleClip(clip!, media!).then(({ samples, frames }) => {
      if (!alive) return;
      setState({ key, samples, frames, analysis: analyzeClip(samples) });
    }).catch((err) => toast((err as Error).message, 'error')).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open, key]);

  // Histogramm (Bild am Abspielkopf, vorher/nachher)
  useEffect(() => {
    const c = histRef.current;
    if (!c || !state || !clip) return;
    const local = playhead - clip.start;
    const f = state.frames.reduce((best, x) => (Math.abs(x.t - local) < Math.abs(best.t - local) ? x : best), state.frames[0]);
    if (!f) return;
    const before = frameStats(f.img.data).hist;
    const after = gradedHistogram(f.img, clip.color, exposureGainAt(clip.color, f.t));
    drawHistogram(c, before, after);
  }, [state, busy, open, clip?.color, playhead]);

  if (!open) return null;

  const apply = (k = strength) => {
    if (!clip || !state) return;
    const res = rescueGrade(state.samples, { strength: k, dynamic, denoise, color });
    beginTransaction();
    const keep = { look: clip.color.look, lookStrength: clip.color.lookStrength, lut: clip.color.lut, lutStrength: clip.color.lutStrength, profile: clip.color.profile };
    updateClip(clip.id, { color: { ...defaultColor(), ...keep, ...res.grade } });
    if (denoise || (clip.fx?.denoise ?? 0) > 0) updateClip(clip.id, { fx: { ...NEUTRAL_FX, ...(clip.fx ?? {}), denoise: res.denoise } });
    endTransaction();
    setApplied(true);
    toast(t.imageAssist.done, 'success');
  };

  const setProfile = (p: string) => {
    if (!clip) return;
    updateClip(clip.id, { color: { ...clip.color, profile: (p || undefined) as CameraProfile | undefined } });
  };

  const compare = (on: boolean) => { engine.compareOriginal = on; engine.render(useUi.getState().playhead); };

  return (
    <div className="ai-panel image-panel">
      <div className="ai-panel-header">
        <strong>✦ {t.imageAssist.title}</strong>
        <div className="spacer" />
        <button className="btn icon ghost sm" onClick={() => { compare(false); setOpen(false); }}><IconClose /></button>
      </div>
      {!usable ? <div className="hint">{t.imageAssist.selectClip}</div> : busy || !state ? (
        <div className="hint"><span className="spinner" /> {t.imageAssist.analyzing}</div>
      ) : (
        <>
          <div className="hint">{t.imageAssist.findings}:</div>
          <div className="vfx-chips">
            {state.analysis.findings.map((f) => <span key={f} className={`chip${f === 'ok' ? ' active' : ''}`}>{FINDING_TEXT[f]}</span>)}
          </div>
          {state.analysis.findings.includes('log') && !clip!.color.profile && <div className="hint warn">{t.imageAssist.logSuggest}</div>}
          <canvas ref={histRef} className="histogram" width={300} height={70} />
          <div className="hist-legend"><span className="hb">■ {t.imageAssist.histBefore}</span><span className="ha">■ {t.imageAssist.histAfter}</span></div>
          <div className="field">
            <label>{t.imageAssist.strength}</label>
            <input type="range" min={0} max={1.5} step={0.05} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))}
              onPointerUp={() => { if (applied) apply(); }} />
            <span className="hint">{Math.round(strength * 100)} %</span>
          </div>
          {state.analysis.evRange > 0.5 && <label className="toggle"><input type="checkbox" checked={dynamic} onChange={(e) => setDynamic(e.target.checked)} /> {t.imageAssist.dynamic}</label>}
          <label className="toggle"><input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} /> {t.imageAssist.denoise}</label>
          <label className="toggle"><input type="checkbox" checked={color} onChange={(e) => setColor(e.target.checked)} /> {t.imageAssist.color}</label>
          <div className="field-row">
            <button className="btn primary" style={{ flex: 1 }} onClick={() => apply()}>{applied ? t.imageAssist.reapply : t.imageAssist.apply}</button>
            <button className="btn" title={t.imageAssist.beforeHint} onPointerDown={() => compare(true)} onPointerUp={() => compare(false)} onPointerLeave={() => compare(false)}>{t.imageAssist.before}</button>
          </div>
          <div className="field">
            <label>{t.imageAssist.profile}</label>
            <select value={clip!.color.profile ?? ''} onChange={(e) => setProfile(e.target.value)} style={{ gridColumn: '2 / span 2' }}>
              <option value="">{t.imageAssist.profileNone}</option>
              {CAMERA_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="hint">{t.imageAssist.profileHint}</div>
          <button className="btn sm ghost" onClick={() => { updateClip(clip!.id, { color: defaultColor(), fx: clip!.fx ? { ...clip!.fx, denoise: 0 } : undefined }); setApplied(false); }}>{t.imageAssist.reset}</button>
          <div className="hint">{t.imageAssist.hint}</div>
        </>
      )}
    </div>
  );
}
