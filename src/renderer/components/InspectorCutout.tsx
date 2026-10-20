import React, { useState } from 'react';
import type { AiDetectModel, AiSegmentModel, Clip, Detection, MediaItem } from '@shared/types';
import { clipDuration } from '@shared/timeline';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi, usePlayheadCoarse } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { Section, SelectField, Toggle } from './InspectorBits';
import { cancelAi, detectAt, maskTrack, trackObject } from '../ai/tracking';
import { bringObjectToFront } from '../vfx/actions';

let last = { detModel: 'yolox-tiny' as AiDetectModel, segModel: 'isnet' as AiSegmentModel, toFront: false };

/** Erkennung, die den angeklickten Punkt enthält (kleinste passende), sonst die nächstgelegene. */
function pickDetection(dets: Detection[], u: number, v: number): Detection | null {
  const inside = dets.filter((d) => u >= d.x && u <= d.x + d.w && v >= d.y && v <= d.y + d.h).sort((a, b) => a.w * a.h - b.w * b.h);
  if (inside.length) return inside[0];
  let best: Detection | null = null, bd = Infinity;
  for (const d of dets) {
    const dx = u - (d.x + d.w / 2), dy = v - (d.y + d.h / 2);
    const dist = Math.hypot(dx, dy);
    if (dist < bd) { bd = dist; best = d; }
  }
  return bd < 0.25 ? best : null;
}

/** „Per Klick freistellen“: Knopf drücken, ins Bild klicken – Objekt wird über den ganzen Clip verfolgt und freigestellt. */
export function InspectorClickCutout({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const [o, setO] = useState(last);
  const upd = (p: Partial<typeof o>) => { const n = { ...o, ...p }; last = n; setO(n); };
  const [busy, setBusy] = useState<{ percent: number; message: string } | null>(null);
  const playhead = usePlayheadCoarse(0.25);
  const toast = useUi((s) => s.toast);
  const inClip = playhead >= clip.start && playhead < clip.start + clipDuration(clip);
  const local = Math.max(0, Math.min(clipDuration(clip), playhead - clip.start));

  const run = async (u: number, v: number) => {
    setBusy({ percent: 0, message: t.cutout.detecting });
    try {
      const dets = await detectAt(clip, media, local, o.detModel);
      // Kein passendes Objekt erkannt → Kasten um den Klickpunkt (Maske findet trotzdem die Form)
      const det: Detection = pickDetection(dets, u, v) ?? { label: 'object', labelDe: t.cutout.object, score: 1, x: Math.max(0, u - 0.18), y: Math.max(0, v - 0.18), w: 0.36, h: 0.36 };
      setBusy({ percent: 5, message: fmt(t.cutout.tracking, { name: det.labelDe }) });
      const tr = await trackObject(clip, media, det, local, o.detModel, (p) => setBusy({ percent: 5 + p.percent * 0.45, message: p.message }));
      useProject.getState().addObjectTrack(clip.id, tr);
      const masks = await maskTrack(clip, media, tr, o.segModel, (p) => setBusy({ percent: 50 + p.percent * 0.5, message: p.message }));
      beginTransaction();
      useProject.getState().updateObjectTrack(clip.id, tr.id, { masks, maskModel: o.segModel });
      useProject.getState().setCutout(clip.id, { enabled: true, trackId: tr.id, feather: 2, grow: 0, invert: false });
      endTransaction();
      if (o.toFront) bringObjectToFront(clip.id, tr.id);
      toast(fmt(t.cutout.done, { name: det.labelDe }), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const start = () => {
    if (!inClip) { toast(t.cutout.needPlayhead, 'error'); return; }
    useUi.getState().select([clip.id]);
    useUi.getState().setPointPick({ clipId: clip.id, onPick: (u, v) => void run(u, v) });
  };

  return (
    <Section title={t.cutout.section} defaultOpen>
      <div className="hint">{t.cutout.hint}</div>
      <SelectField label={t.cutout.detModel} value={o.detModel} onChange={(v) => upd({ detModel: v as AiDetectModel })} options={[
        { value: 'yolox-nano', label: t.ai.modelFast }, { value: 'yolox-tiny', label: t.ai.modelBetter }, { value: 'yolox-s', label: t.ai.modelBest },
      ]} />
      <SelectField label={t.cutout.segModel} value={o.segModel} onChange={(v) => upd({ segModel: v as AiSegmentModel })} options={[
        { value: 'u2netp', label: t.ai.segFast }, { value: 'u2net-human', label: t.ai.segHuman }, { value: 'isnet', label: t.ai.segBest },
      ]} />
      <Toggle label={t.cutout.toFront} checked={o.toFront} onChange={(v) => upd({ toFront: v })} />
      {busy ? (
        <div>
          <div className="hint">{busy.message}</div>
          <div className="progress"><div style={{ width: `${Math.round(busy.percent)}%` }} /></div>
          <button className="btn sm" style={{ marginTop: 6 }} onClick={cancelAi}>{t.common.cancel}</button>
        </div>
      ) : (
        <button className="btn primary" style={{ width: '100%' }} onClick={start}>🖱 {t.cutout.start}</button>
      )}
      {(clip.objects?.length ?? 0) > 0 && <div className="hint">{t.cutout.after}</div>}
    </Section>
  );
}
