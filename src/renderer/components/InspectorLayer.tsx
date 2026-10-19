// Inspektor: Ebene (Mischmodus, Schatten, Verknüpfung) und Effekt-Einstellungen (Neu berechnen, An Szene anpassen).
import React, { useEffect, useState } from 'react';
import type { BlendMode, Clip, LayerShadow, MediaItem, VfxSpec } from '@shared/types';
import { BLEND_MODES, DEFAULT_SHADOW } from '@shared/layers';
import { vfxKind } from '@shared/vfx';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';
import { Section, SelectField, Slider, Toggle } from './InspectorBits';
import { matchEffectToScene, rerenderEffect } from '../vfx/actions';
import { cancelVfx } from '../vfx/render';

export function InspectorLayer({ clip, ids }: { clip: Clip; ids: string[] }): React.ReactElement {
  const updateClips = useProject((s) => s.updateClips);
  const master = useProject((s) => (clip.link ? s.project.clips[clip.link.clipId] : undefined));
  const sh: LayerShadow = clip.shadow ?? { ...DEFAULT_SHADOW, enabled: false };
  const patchShadow = (p: Partial<LayerShadow>) => updateClips(ids, { shadow: { ...sh, ...p } });
  const active = (clip.blend && clip.blend !== 'normal') || sh.enabled || !!clip.link;
  const badge = clip.blend && clip.blend !== 'normal' ? BLEND_MODES.find((b) => b.id === clip.blend)?.name.split(' (')[0] : sh.enabled ? t.layers.shadow : clip.link ? '🔗' : undefined;
  return (
    <Section title={t.layers.section} defaultOpen={!!active} badge={badge} onReset={() => updateClips(ids, { blend: undefined, shadow: undefined })}>
      {clip.link && master && (
        <div className="result-box" style={{ gap: 4 }}>
          <span className="link-badge">🔗 {t.layers.linked}: {master.name}</span>
          <div className="hint">{t.layers.linkedHint}</div>
          <button className="btn sm" onClick={() => updateClips([clip.id], { link: undefined })}>{t.layers.unlink}</button>
        </div>
      )}
      <SelectField label={t.layers.blend} value={clip.blend ?? 'normal'} onChange={(v) => updateClips(ids, { blend: v === 'normal' ? undefined : (v as BlendMode) })}
        options={BLEND_MODES.map((b) => ({ value: b.id, label: b.name }))} />
      <Toggle label={t.layers.shadow} checked={sh.enabled} onChange={(v) => patchShadow({ enabled: v })} />
      {sh.enabled && (
        <>
          <Slider label={t.layers.shadowOpacity} value={sh.opacity} min={0} max={1} step={0.01} display={(v) => `${Math.round(v * 100)} %`} onChange={(v) => patchShadow({ opacity: v })} />
          <Slider label={t.layers.shadowBlur} value={sh.blur} min={0} max={10} step={0.1} unit=" %" onChange={(v) => patchShadow({ blur: v })} />
          <Slider label={t.layers.shadowDistance} value={sh.distance} min={0} max={20} step={0.1} unit=" %" onChange={(v) => patchShadow({ distance: v })} />
          <Slider label={t.layers.shadowAngle} value={sh.angle} min={-180} max={180} step={1} unit="°" onChange={(v) => patchShadow({ angle: v })} />
        </>
      )}
    </Section>
  );
}

/** Einstellungen eines erzeugten Effekts – Änderungen werden mit „Neu berechnen“ übernommen. */
export function InspectorVfx({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement | null {
  const spec = media.vfx;
  const toast = useUi((s) => s.toast);
  const [draft, setDraft] = useState<VfxSpec | null>(spec ?? null);
  const [busy, setBusy] = useState<{ percent: number; message: string } | null>(null);
  useEffect(() => { setDraft(media.vfx ?? null); }, [media.vfx]);
  if (!spec || !draft || media.vfxRole === 'light') return null;
  const def = vfxKind(spec.kind);
  const changed = JSON.stringify(draft) !== JSON.stringify(spec);
  const patch = (p: Partial<VfxSpec>) => setDraft({ ...draft, ...p });
  const pct = (v: number) => `${Math.round(v * 100)} %`;

  const rerender = async (next: VfxSpec) => {
    setBusy({ percent: 0, message: t.vfx.generating });
    try { await rerenderEffect(media.id, next, (percent, message) => setBusy({ percent, message })); }
    catch (err) { if ((err as Error).message !== 'Abgebrochen') toast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  return (
    <Section title={`${def.icon} ${t.vfx.section}: ${def.name}`} badge={changed ? '•' : undefined}>
      {spec.prompt && spec.prompt !== def.name && <div className="hint">„{spec.prompt}“</div>}
      <Slider label={t.vfx.intensity} value={draft.intensity} min={0.2} max={2} step={0.05} display={pct} onChange={(v) => patch({ intensity: v })} />
      <Slider label={t.vfx.speed} value={draft.speed} min={0.3} max={2.5} step={0.05} display={pct} onChange={(v) => patch({ speed: v })} />
      <Slider label={t.vfx.wind} value={draft.wind} min={-1} max={1} step={0.05} onChange={(v) => patch({ wind: v })} />
      {(spec.kind === 'explosion' || spec.kind === 'fire') && <Slider label={t.vfx.smoke} value={draft.smoke} min={0} max={2} step={0.05} display={pct} onChange={(v) => patch({ smoke: v })} />}
      {(def.fullFrame || spec.kind === 'sparks') && <Slider label={t.vfx.size} value={draft.size} min={0.4} max={2} step={0.05} display={pct} onChange={(v) => patch({ size: v })} />}
      <Slider label={t.vfx.duration} value={draft.duration} min={0.5} max={30} step={0.5} unit=" s" onChange={(v) => patch({ duration: v })} />
      <div className="field">
        <label>{t.vfx.color}</label>
        <input type="checkbox" checked={!!draft.color} onChange={(e) => patch({ color: e.target.checked ? '#ff8a1f' : undefined })} />
        {draft.color ? <input type="color" value={draft.color} onChange={(e) => patch({ color: e.target.value })} /> : <span />}
      </div>
      {busy ? (
        <div>
          <div className="hint">{busy.message}</div>
          <div className="progress"><div style={{ width: `${busy.percent}%` }} /></div>
          <button className="btn sm" style={{ marginTop: 6 }} onClick={cancelVfx}>{t.vfx.cancel}</button>
        </div>
      ) : (
        <div className="field-row">
          <button className={`btn sm${changed ? ' primary' : ''}`} onClick={() => void rerender(draft)}>{t.vfx.rerender}</button>
          <button className="btn sm" onClick={() => void rerender({ ...draft, seed: Math.floor(Math.random() * 1000) })}>↻ {t.vfx.variant}</button>
          <button className="btn sm" onClick={() => void matchEffectToScene(clip.id, { shake: false })}>{t.vfx.match}</button>
        </div>
      )}
      {changed && !busy && <div className="hint">{t.vfx.rerenderHint}</div>}
    </Section>
  );
}
