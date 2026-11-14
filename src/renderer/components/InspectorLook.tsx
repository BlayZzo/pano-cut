// Inspektor-Bereiche für v0.4: Bild (Farbe/Looks/LUT/Automatik), Effekte, Zuschnitt, Animation, Ducking.
import React, { useState } from 'react';
import type { Clip, ColorGrade, Crop, ImageFx, Motion, MotionKeyframe, MotionPreset } from '@shared/types';
import { clipDuration, defaultColor } from '@shared/timeline';
import { LOOKS } from '@shared/color';
import { MOTION_PRESETS, NEUTRAL_FX, createMotion, hasMotion, insertKeyframe, motionKeyAtPublic } from '@shared/effects';
import { useProject } from '../store/project';
import { useUi, usePlayheadCoarse } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { DEFAULT_TRAIL_THRESHOLD } from '@shared/lights';
import { removeLight } from '../lightActions';
import { Fold, KeyframeBar, Section, SelectField, Slider, Toggle } from './InspectorBits';
import { PathFields } from './InspectorPath';
import { seekTo } from '../engine/instance';
import { autoEnhanceClips, saveClipAsEffect } from '../actions';

const SubHead = ({ children }: { children: React.ReactNode }) => (
  <div className="panel-header" style={{ padding: '8px 0 2px', border: 'none' }}>{children}</div>
);

const isChanged = (g: ColorGrade) =>
  g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1 || g.hue !== 0 ||
  !!(g.exposure || g.temperature || g.tint || g.highlights || g.shadows || g.whites || g.blacks || g.vibrance || g.fade || g.dehaze || g.splitShadow || g.splitHighlight || g.look || g.lut) ||
  (g.gamma !== undefined && g.gamma !== 1);

// ---------- Bild (Farbe) ----------

export function InspectorColor({ clip, ids }: { clip: Clip; ids: string[] }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const [more, setMore] = useState(false);
  const c = clip.color;
  const patch = (p: Partial<ColorGrade>) => updateClips(ids, { color: { ...clip.color, ...p } });
  const num = (v: number | undefined, d = 0) => (v === undefined ? d : v);
  const changed = isChanged(c);

  const loadLut = async () => {
    const file = await window.panocut.selectFile(t.look.lut, ['cube']);
    if (file) patch({ lut: file, lutStrength: c.lutStrength ?? 1 });
  };

  return (
    <Section title={t.inspector.sectionColor} badge={changed ? (c.look ? LOOKS.find((l) => l.id === c.look)?.name ?? '•' : '•') : undefined}
      onReset={() => updateClips(ids, { color: defaultColor() })}>
      <div className="field-row">
        <button className="btn primary" style={{ flex: 1 }} onClick={() => void autoEnhanceClips(ids)}>{t.look.auto}</button>
        <button className="btn" onClick={() => useUi.getState().setImagePanel(true)} title={t.imageAssist.title}>{t.imageAssist.open}</button>
      </div>
      <div className="hint">{t.look.autoHint}</div>

      <SubHead>{t.look.lookGroup}</SubHead>
      <div className="look-grid">
        <button className={`chip${!c.look ? ' active' : ''}`} onClick={() => patch({ look: undefined })}>{t.look.lookNone}</button>
        {LOOKS.map((l) => (
          <button key={l.id} className={`chip${c.look === l.id ? ' active' : ''}`} onClick={() => patch({ look: l.id, lookStrength: c.lookStrength ?? 1 })}>{l.name}</button>
        ))}
      </div>
      {c.look && <Slider label={t.look.lookStrength} value={num(c.lookStrength, 1)} min={0} max={1} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patch({ lookStrength: v })} />}

      <SubHead>{t.look.light}</SubHead>
      <Slider label={t.look.exposure} value={num(c.exposure)} min={-3} max={3} step={0.05} unit=" EV" onChange={(v) => patch({ exposure: v })} />
      <Slider label={t.inspector.contrast} value={c.contrast} min={0} max={2} step={0.01} onChange={(v) => patch({ contrast: v })} />
      <Slider label={t.look.highlights} value={num(c.highlights)} min={-100} max={100} step={1} onChange={(v) => patch({ highlights: v })} />
      <Slider label={t.look.shadows} value={num(c.shadows)} min={-100} max={100} step={1} onChange={(v) => patch({ shadows: v })} />
      {more && (
        <>
          <Slider label={t.look.whites} value={num(c.whites)} min={-100} max={100} step={1} onChange={(v) => patch({ whites: v })} />
          <Slider label={t.look.blacks} value={num(c.blacks)} min={-100} max={100} step={1} onChange={(v) => patch({ blacks: v })} />
          <Slider label={t.look.gamma} value={num(c.gamma, 1)} min={0.3} max={3} step={0.01} onChange={(v) => patch({ gamma: v })} />
          {c.brightness !== 0 && <Slider label={t.inspector.brightness} value={c.brightness} min={-1} max={1} step={0.01} onChange={(v) => patch({ brightness: v })} />}
        </>
      )}

      <SubHead>{t.look.colorGroup}</SubHead>
      <Slider label={t.look.temperature} value={num(c.temperature)} min={-100} max={100} step={1} onChange={(v) => patch({ temperature: v })} />
      <Slider label={t.look.tint} value={num(c.tint)} min={-100} max={100} step={1} onChange={(v) => patch({ tint: v })} />
      <Slider label={t.look.vibrance} value={num(c.vibrance)} min={-100} max={100} step={1} onChange={(v) => patch({ vibrance: v })} />
      <Slider label={t.inspector.saturation} value={c.saturation} min={0} max={3} step={0.01} onChange={(v) => patch({ saturation: v })} />
      {more && (
        <>
          <Slider label={t.inspector.hue} value={c.hue} min={-180} max={180} step={1} unit="°" onChange={(v) => patch({ hue: v })} />
          <Slider label={t.look.splitShadow} value={num(c.splitShadow)} min={-100} max={100} step={1} onChange={(v) => patch({ splitShadow: v })} />
          <Slider label={t.look.splitHighlight} value={num(c.splitHighlight)} min={-100} max={100} step={1} onChange={(v) => patch({ splitHighlight: v })} />
          <div className="hint">{t.look.splitHint}</div>
          <SubHead>{t.look.style}</SubHead>
          <Slider label={t.look.fade} value={num(c.fade)} min={0} max={100} step={1} onChange={(v) => patch({ fade: v })} />
          <Slider label={t.look.dehaze} value={num(c.dehaze)} min={0} max={100} step={1} onChange={(v) => patch({ dehaze: v })} />
          <SubHead>{t.look.lut}</SubHead>
          <div className="field-row">
            <button className="btn sm" onClick={() => void loadLut()}>{t.look.lutLoad}</button>
            {c.lut && <button className="btn sm ghost" onClick={() => patch({ lut: undefined })}>{t.look.lutRemove}</button>}
          </div>
          {c.lut && <div className="hint" title={c.lut} style={{ wordBreak: 'break-all' }}>{c.lut.split(/[\\/]/).pop()}</div>}
          {c.lut && <Slider label={t.look.lookStrength} value={num(c.lutStrength, 1)} min={0} max={1} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patch({ lutStrength: v })} />}
          <div className="hint">{t.look.lutHint}</div>
        </>
      )}
      <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setMore(!more)}>{more ? '▴' : '▾'} {t.look.advanced}</button>
    </Section>
  );
}

// ---------- Effekte + Zuschnitt ----------

export function InspectorFx({ clip, ids }: { clip: Clip; ids: string[] }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const fx = { ...NEUTRAL_FX, ...(clip.fx ?? {}) };
  const patchFx = (p: Partial<ImageFx>) => updateClips(ids, { fx: { ...fx, ...p } });
  const active = fx.vignette > 0 || fx.sharpen > 0 || fx.denoise > 0 || fx.blur > 0 || fx.grain > 0 || fx.mirror || fx.flip;
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  return (
    <Section title={t.fx.section} defaultOpen={active} badge={active ? '•' : undefined} onReset={() => patchFx({ vignette: 0, blur: 0, sharpen: 0, denoise: 0, grain: 0, mirror: false, flip: false })}>
      <Slider label={t.fx.vignette} value={fx.vignette} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ vignette: v })} />
      <Slider label={t.fx.blur} value={fx.blur} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ blur: v })} />
      <Slider label={t.fx.sharpen} value={fx.sharpen} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ sharpen: v })} />
      <Slider label={t.fx.denoise} value={fx.denoise} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ denoise: v })} />
      <Slider label={t.fx.grain} value={fx.grain} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ grain: v })} />
      {(fx.sharpen > 0 || fx.denoise > 0 || fx.grain > 0) && <div className="hint">{t.fx.exportOnly}</div>}
      <Toggle label={t.fx.mirror} checked={fx.mirror} onChange={(v) => patchFx({ mirror: v })} />
      <Toggle label={t.fx.flip} checked={fx.flip} onChange={(v) => patchFx({ flip: v })} />
    </Section>
  );
}

// ---------- Zuschnitt (im Reiter „Video“) ----------

export function InspectorCrop({ clip, ids }: { clip: Clip; ids: string[] }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const crop: Crop = clip.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const patchCrop = (p: Partial<Crop>) => updateClips(ids, { crop: { ...crop, ...p } });
  const active = crop.left > 0 || crop.right > 0 || crop.top > 0 || crop.bottom > 0;
  return (
    <Section title={t.fx.crop} defaultOpen={active} badge={active ? '•' : undefined} onReset={() => updateClips(ids, { crop: undefined })}>
      <Slider label={t.fx.cropLeft} value={crop.left} min={0} max={45} step={0.5} unit=" %" onChange={(v) => patchCrop({ left: v })} />
      <Slider label={t.fx.cropRight} value={crop.right} min={0} max={45} step={0.5} unit=" %" onChange={(v) => patchCrop({ right: v })} />
      <Slider label={t.fx.cropTop} value={crop.top} min={0} max={45} step={0.5} unit=" %" onChange={(v) => patchCrop({ top: v })} />
      <Slider label={t.fx.cropBottom} value={crop.bottom} min={0} max={45} step={0.5} unit=" %" onChange={(v) => patchCrop({ bottom: v })} />
    </Section>
  );
}

// ---------- Licht & Bewegung (Glühen, Leuchtspuren, Bewegungsunschärfe) ----------

export function InspectorLightFx({ clip, ids }: { clip: Clip; ids: string[] }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const fx = { ...NEUTRAL_FX, ...(clip.fx ?? {}) };
  const patchFx = (p: Partial<ImageFx>) => updateClips(ids, { fx: { ...fx, ...p } });
  const glow = fx.glow ?? 0, trails = fx.trails ?? 0, mb = fx.motionBlur ?? 0;
  const active = glow > 0 || trails > 0 || mb > 0;
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const lightPick = useUi((s) => s.lightPick);
  const setLightPick = useUi((s) => s.setLightPick);
  const is360 = useProject((s) => !!s.project.media[clip.mediaId]?.info.is360);
  const nightPreset = () => updateClips(ids, { fx: { ...fx, glow: 0.55, trails: 0.6 }, color: { ...clip.color, look: 'night', lookStrength: 1 } });
  return (
    <Section title={t.lightFx.section} defaultOpen={active} badge={active ? '•' : undefined} onReset={() => patchFx({ glow: 0, trails: 0, motionBlur: 0 })}>
      <div className="field-row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={nightPreset}>🌃 {t.lightFx.night}</button>
        <button className="btn sm" onClick={() => patchFx({ motionBlur: 0.6 })}>💨 {t.lightFx.speedPreset}</button>
        <button className="btn sm" onClick={() => patchFx({ glow: 0.5 })}>✨ {t.lightFx.dreamPreset}</button>
      </div>
      <Slider label={t.lightFx.glow} value={glow} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ glow: v })} />
      <Slider label={t.lightFx.trails} value={trails} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ trails: v })} />
      {trails > 0.01 && (
        <>
          <SelectField label={t.lights.mode} value={fx.trailsMode ?? 'all'} onChange={(v) => patchFx({ trailsMode: v as ImageFx['trailsMode'] })} options={[
            { value: 'all', label: t.lights.modeAll },
            { value: 'lights', label: t.lights.modeLights },
            ...(is360 ? [] : [{ value: 'marked', label: t.lights.modeMarked }]),
          ]} />
          {(fx.trailsMode ?? 'all') !== 'all' && (
            <Slider label={t.lights.threshold} value={fx.trailsThreshold ?? DEFAULT_TRAIL_THRESHOLD} min={0.3} max={0.95} step={0.01} display={pct} onChange={(v) => patchFx({ trailsThreshold: v })} />
          )}
          {fx.trailsMode === 'marked' && (
            <div className="music-auto">
              <div className="hint">{t.lights.markHint}</div>
              <button className={`btn sm${lightPick?.clipId === clip.id ? ' active' : ' primary'}`} onClick={() => {
                if (lightPick?.clipId === clip.id) { setLightPick(null); return; }
                useUi.getState().select([clip.id]);
                setLightPick({ clipId: clip.id, r: 0.04 });
              }}>{lightPick?.clipId === clip.id ? t.path.done : t.lights.mark}</button>
              {(fx.lights ?? []).map((l, i) => (
                <div key={l.id} className="field-row">
                  <span className="num-label">💡 {fmt(t.lights.item, { n: i + 1, s: l.keys.length > 1 ? (l.keys[l.keys.length - 1].t - l.keys[0].t).toFixed(1) : '0' })}</span>
                  <div className="spacer" />
                  <button className="btn sm ghost" onClick={() => removeLight(clip.id, l.id)}>{t.common.delete}</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <Slider label={t.lightFx.motionBlur} value={mb} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchFx({ motionBlur: v })} />
      <div className="hint">{t.lightFx.hint}</div>
    </Section>
  );
}

// ---------- Animation (selten gebraucht → eigener Reiter) ----------

/** Vorlagen, die anderswo schon einfacher gehen, nur zeigen, wenn sie gerade benutzt werden:
 *  Zoom/Ken Burns = „Kamera“ (verlustfrei aus dem vollen Bild), Auftritte = „Auftritt mit Aufprall“. */
const HIDDEN_PRESETS = new Set<MotionPreset>(['kenburns', 'zoomin', 'zoomout', 'dropin', 'slam', 'flyin-left', 'flyin-right', 'rise']);
const IDENTITY = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export function InspectorMotion({ clip, ids }: { clip: Clip; ids: string[] }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const fps = useProject((s) => s.project.settings.fps);
  const playhead = usePlayheadCoarse(0.1);
  const dur = clipDuration(clip);
  const m = clip.motion;
  const on = hasMotion(m) || m?.preset === 'custom';
  const setMotion = (next: Motion | undefined) => updateClips(ids, { motion: next });
  const setPreset = (preset: string) => {
    if (!preset) { setMotion(undefined); return; }
    setMotion({ ...createMotion(preset as MotionPreset, dur, m?.intensity ?? 1), smooth: m?.smooth ?? true });
  };
  const local = Math.max(0, Math.min(dur, playhead - clip.start));
  const cur = m ? motionKeyAtPublic(m, local) : IDENTITY;
  const atKey = m?.keyframes.find((k) => Math.abs(k.t - local) < 0.5 / Math.max(1, fps));
  // Regler ändern den Keyframe am Abspielkopf (bzw. den einzigen); sonst entsteht dort ein neuer
  const patchKey = (p: Partial<MotionKeyframe>) => {
    if (!m) return;
    const base: MotionKeyframe = atKey ?? (m.keyframes.length === 1 ? m.keyframes[0] : { t: local, ...cur });
    const rest = m.keyframes.filter((k) => k !== base && Math.abs(k.t - base.t) > 1e-6);
    setMotion({ ...m, preset: 'custom', keyframes: [...rest, { ...base, ...p }].sort((a, b) => a.t - b.t) });
  };
  const addKey = () => {
    const t0 = Math.round(local * 100) / 100;
    if (!m) setMotion({ preset: 'custom', intensity: 1, smooth: true, keyframes: [{ t: t0, ...IDENTITY }] });
    else setMotion(insertKeyframe(m, t0));
  };
  const removeKey = (k: number) => {
    if (!m) return;
    const rest = m.keyframes.filter((x) => Math.abs(x.t - k) > 1e-6);
    setMotion(rest.length || m.osc ? { ...m, preset: 'custom', keyframes: rest } : undefined);
  };
  const presets = MOTION_PRESETS.filter((p) => p.id !== 'custom' && (!HIDDEN_PRESETS.has(p.id) || p.id === m?.preset));
  const pct = (v: number) => `${Math.round(v * 100)} %`;

  return (
    <Section title={t.motion.section} defaultOpen={on} badge={on && m ? (m.preset === 'custom' ? fmt(t.path.points, { n: m.keyframes.length }) : MOTION_PRESETS.find((p) => p.id === m.preset)?.name.split(' (')[0]) : undefined}
      onReset={on ? () => setMotion(undefined) : undefined}>
      <SelectField label={t.motion.preset} value={m && m.preset !== 'custom' ? m.preset : ''} onChange={setPreset}
        options={[{ value: '', label: m?.preset === 'custom' ? t.motion.own : t.motion.none }, ...presets.map((p) => ({ value: p.id, label: p.name }))]} />
      {m && m.preset !== 'custom' && (
        <Slider label={t.motion.intensity} value={m.intensity} min={0} max={2} step={0.05} display={pct}
          onChange={(v) => setMotion({ ...createMotion(m.preset, dur, v), smooth: m.smooth })} />
      )}
      {m && m.keyframes.length > 0 && (
        <>
          <Slider label={t.motion.x} value={cur.x} min={-100} max={100} step={0.5} unit=" %" onChange={(v) => patchKey({ x: v })} />
          <Slider label={t.motion.y} value={cur.y} min={-100} max={100} step={0.5} unit=" %" onChange={(v) => patchKey({ y: v })} />
          <Slider label={t.motion.scale} value={cur.scale} min={0.05} max={4} step={0.01} display={pct} onChange={(v) => patchKey({ scale: v })} />
          <Slider label={t.motion.rotation} value={cur.rotation} min={-360} max={360} step={1} unit="°" onChange={(v) => patchKey({ rotation: v })} />
          <Slider label={t.motion.opacity} value={cur.opacity} min={0} max={1} step={0.01} display={pct} onChange={(v) => patchKey({ opacity: v })} />
        </>
      )}
      <KeyframeBar times={m?.keyframes.map((k) => k.t) ?? []} local={local} fps={fps} onSeek={(k) => seekTo(clip.start + k)} onAdd={addKey} onRemove={removeKey} />
      {!m && <div className="hint">{t.motion.startHint}</div>}
      {m && <Toggle label={t.motion.smooth} checked={m.smooth} onChange={(v) => setMotion({ ...m, smooth: v })} />}
      {ids.length === 1 && <Fold title={t.path.section}><PathFields clip={clip} /></Fold>}
    </Section>
  );
}

// ---------- Ducking (im Ton-Bereich) ----------

export function DuckingFields({ clip, ids }: { clip: Clip; ids: string[] }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const d = clip.ducking ?? { enabled: false, amount: 0.7 };
  return (
    <>
      <Toggle label={t.ducking.enable} checked={d.enabled} onChange={(v) => updateClips(ids, { ducking: { ...d, enabled: v } })} />
      {d.enabled && (
        <>
          <Slider label={t.ducking.amount} value={d.amount} min={0.1} max={1} step={0.05} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => updateClips(ids, { ducking: { ...d, amount: v } })} />
          <div className="hint">{t.ducking.hint}</div>
        </>
      )}
    </>
  );
}

// ---------- Eigener Effekt ----------

export function SaveEffectButton({ clip }: { clip: Clip }): React.ReactElement {
  const [name, setName] = useState<string | null>(null);
  if (name === null) {
    return <button className="btn sm" style={{ width: '100%', marginTop: 4 }} onClick={() => setName(t.effects.ownDefaultName)}>☆ {t.effects.saveOwn}</button>;
  }
  return (
    <div className="field-row" style={{ marginTop: 4 }}>
      <input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder={t.effects.ownName} style={{ flex: 1, minWidth: 0 }}
        onKeyDown={(e) => { if (e.key === 'Enter') { void saveClipAsEffect(clip, name); setName(null); } if (e.key === 'Escape') setName(null); }} />
      <button className="btn sm primary" onClick={() => { void saveClipAsEffect(clip, name); setName(null); }}>{t.common.ok}</button>
    </div>
  );
}
