import React, { useEffect, useState } from 'react';
import type { AiDetectModel, AiSegmentModel, Clip, Detection, MediaItem } from '@shared/types';
import { clipDuration } from '@shared/timeline';
import { trackActiveAt, trackBoxAt } from '@shared/ai';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';
import { cancelAi, detectAt, maskTrack, trackObject } from '../ai/tracking';
import { IconClose } from './Icons';

/** Der „KI-Info“-Bereich über der Vorschau: erkennen, verfolgen, Masken. */
export function AiPanel({ clip, media }: { clip: Clip | null; media: MediaItem | null }): React.ReactElement | null {
  const open = useUi((s) => s.aiPanel);
  const setOpen = useUi((s) => s.setAiPanel);
  const busy = useUi((s) => s.aiBusy);
  const setBusy = useUi((s) => s.setAiBusy);
  const playhead = useUi((s) => s.playhead);
  const toast = useUi((s) => s.toast);
  const settings = useUi((s) => s.settings);
  const addObjectTrack = useProject((s) => s.addObjectTrack);
  const updateObjectTrack = useProject((s) => s.updateObjectTrack);
  const setCutout = useProject((s) => s.setCutout);
  const [status, setStatus] = useState<{ available: boolean; models: Record<string, boolean> } | null>(null);
  const [dets, setDets] = useState<Detection[]>([]);
  const [detModel, setDetModel] = useState<AiDetectModel>(settings.aiDetectModel ?? 'yolox-nano');
  const [segModel, setSegModel] = useState<AiSegmentModel>(settings.aiSegmentModel ?? 'u2netp');
  const [progress, setProgress] = useState<{ percent: number; message?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.panocut.aiStatus().then(setStatus);
    return window.panocut.onAiProgress((p) => { if (p.phase === 'download' || p.phase === 'load') setProgress({ percent: p.percent, message: p.message }); });
  }, [open]);

  if (!open) return null;
  const local = clip ? Math.max(0, Math.min(clipDuration(clip), playhead - clip.start)) : 0;
  const canRun = !!clip && !!media && media.type !== 'audio' && clip.kind !== 'title' && !busy;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy({ percent: 0, message: label });
    try { await fn(); } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(null); setProgress(null); }
  };

  const detect = () => run(t.ai.detecting, async () => {
    const found = await detectAt(clip!, media!, local, detModel);
    setDets(found);
    if (found.length === 0) toast(t.ai.nothingFound, 'info');
  });

  const track = (d: Detection) => run(t.ai.tracking, async () => {
    const tr = await trackObject(clip!, media!, d, local, detModel, (p) => setBusy({ percent: p.percent, message: p.message }));
    addObjectTrack(clip!.id, tr);
    toast(`${d.labelDe}: ${tr.boxes.length} ${t.ai.positions}`, 'success');
  });

  const mask = (trackId: string) => run(t.ai.masking, async () => {
    const tr = clip!.objects?.find((x) => x.id === trackId);
    if (!tr) return;
    const masks = await maskTrack(clip!, media!, tr, segModel, (p) => setBusy({ percent: p.percent, message: p.message }));
    updateObjectTrack(clip!.id, trackId, { masks, maskModel: segModel });
    if (!clip!.cutout) setCutout(clip!.id, { enabled: true, trackId, feather: 2, grow: 0, invert: false });
    toast(`${masks.length} ${t.ai.masksDone}`, 'success');
  });

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <strong>{t.ai.title}</strong>
        <div className="spacer" />
        <button className="btn icon ghost sm" onClick={() => setOpen(false)}><IconClose /></button>
      </div>
      {status && !status.available && <div className="hint warn">{t.ai.unavailable}</div>}
      {!clip || !media ? (
        <div className="hint">{t.ai.selectClip}</div>
      ) : (
        <>
          <div className="field-row">
            <select value={detModel} onChange={(e) => { setDetModel(e.target.value as AiDetectModel); void window.panocut.setSettings({ aiDetectModel: e.target.value as AiDetectModel }); }} title={t.ai.detectModel}>
              <option value="yolox-nano">{t.ai.modelFast}{status?.models['yolox-nano'] ? ' ✓' : ''}</option>
              <option value="yolox-tiny">{t.ai.modelBetter}{status?.models['yolox-tiny'] ? ' ✓' : ''}</option>
              <option value="yolox-s">{t.ai.modelBest}{status?.models['yolox-s'] ? ' ✓' : ''}</option>
            </select>
            <button className="btn sm primary" onClick={() => void detect()} disabled={!canRun}>{t.ai.detect}</button>
          </div>
          {busy && (
            <div>
              <div className="hint">{progress?.message ?? busy.message}</div>
              <div className="progress"><div style={{ width: `${progress?.percent ?? busy.percent}%` }} /></div>
              <button className="btn sm" style={{ marginTop: 6 }} onClick={cancelAi}>{t.common.cancel}</button>
            </div>
          )}
          {dets.length > 0 && !busy && (
            <div className="ai-list">
              <div className="hint">{t.ai.found}</div>
              {dets.map((d, i) => (
                <div key={i} className="ai-row">
                  <span className="pill">{d.labelDe} · {Math.round(d.score * 100)} %</span>
                  <div className="spacer" />
                  <button className="btn sm" onClick={() => void track(d)}>{t.ai.track}</button>
                </div>
              ))}
            </div>
          )}
          {(clip.objects?.length ?? 0) > 0 && (
            <div className="ai-list">
              <div className="hint">{t.ai.tracked}</div>
              <div className="field-row">
                <select value={segModel} onChange={(e) => { setSegModel(e.target.value as AiSegmentModel); void window.panocut.setSettings({ aiSegmentModel: e.target.value as AiSegmentModel }); }} title={t.ai.segmentModel}>
                  <option value="u2netp">{t.ai.segFast}{status?.models.u2netp ? ' ✓' : ''}</option>
                  <option value="u2net-human">{t.ai.segHuman}{status?.models['u2net-human'] ? ' ✓' : ''}</option>
                  <option value="isnet">{t.ai.segBest}{status?.models.isnet ? ' ✓' : ''}</option>
                </select>
              </div>
              {clip.objects!.map((tr) => (
                <div key={tr.id} className="ai-row">
                  <span className="swatch" style={{ background: tr.color }} />
                  <span>{tr.labelDe}{trackActiveAt(tr, local) && trackBoxAt(tr, local) ? '' : ' (hier nicht sichtbar)'}{tr.masks?.length ? ` · ${tr.masks.length} Masken` : ''}</span>
                  <div className="spacer" />
                  <button className="btn sm" onClick={() => void mask(tr.id)} disabled={!!busy}>{tr.masks?.length ? t.ai.remask : t.ai.mask}</button>
                </div>
              ))}
            </div>
          )}
          <div className="hint">{t.ai.hint}</div>
        </>
      )}
    </div>
  );
}
