// ✏️ Maske von Hand zeichnen (wie in Photoshop): Pinsel, Radierer, Lasso, alles füllen/leeren, umkehren, weiche Kante.
// Die Maske ist ein Graustufenbild über das ganze Quellbild (weiß = sichtbar). „Neue Maske ab hier“ erlaubt Änderungen über die Zeit.
import React, { useState } from 'react';
import type { Clip, MediaItem, ObjectTrack } from '@shared/types';
import { clipDuration, makeId } from '@shared/timeline';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi, usePlayheadCoarse } from '../store/ui';
import { t } from '../i18n/de';
import { Section, Slider, Toggle } from './InspectorBits';
import { canvasToPng, loadMaskCanvas } from './previewTools';
import { forgetMask } from '../engine/playback';
import { maskAt } from '@shared/ai';

const MASK_W = 1280;

async function blankMask(media: MediaItem, fill: 0 | 255): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  const ar = (media.info.height || 9) / Math.max(1, media.info.width || 16);
  c.width = MASK_W; c.height = Math.max(2, Math.round(MASK_W * ar));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = fill ? '#fff' : '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

export function InspectorMaskDraw({ clip, media }: { clip: Clip; media: MediaItem }): React.ReactElement {
  const maskBrush = useUi((s) => s.maskBrush);
  const setMaskBrush = useUi((s) => s.setMaskBrush);
  const playhead = usePlayheadCoarse(0.1);
  const [busy, setBusy] = useState(false);
  const track = clip.objects?.find((o) => o.label === 'manual');
  const cut = clip.cutout;
  const active = !!maskBrush && maskBrush.trackId === track?.id;
  const local = Math.max(0, Math.min(clipDuration(clip), playhead - clip.start));
  const tool = maskBrush?.tool ?? 'brush';

  const save = async (c: HTMLCanvasElement, tr: ObjectTrack, at: number, replaceIndex?: number) => {
    const path = await window.panocut.aiSaveMask(media.path, tr.id, `manual_${Date.now().toString(36)}`, await canvasToPng(c));
    const masks = [...(tr.masks ?? [])];
    if (replaceIndex !== undefined && masks[replaceIndex]) { forgetMask(masks[replaceIndex].path); masks[replaceIndex] = { t: masks[replaceIndex].t, path }; }
    else { masks.push({ t: at, path }); masks.sort((a, b) => a.t - b.t); }
    return masks;
  };

  const create = async () => {
    setBusy(true);
    try {
      const tr: ObjectTrack = { id: makeId('trk'), label: 'manual', labelDe: t.mask.trackName, color: '#ff4f8b', boxes: [{ t: 0, x: 0, y: 0, w: 1, h: 1 }], masks: [] };
      const c = await blankMask(media, 0);
      tr.masks = await save(c, tr, 0);
      beginTransaction();
      useProject.getState().addObjectTrack(clip.id, tr);
      useProject.getState().setCutout(clip.id, { enabled: true, trackId: tr.id, feather: 4, grow: 0, invert: false });
      endTransaction();
      useUi.getState().select([clip.id]);
      setMaskBrush({ clipId: clip.id, trackId: tr.id, size: 4, all: false, tool: 'brush' });
    } catch (e) { useUi.getState().toast((e as Error).message, 'error'); }
    setBusy(false);
  };

  // ganze Maske an dieser Stelle verändern
  const edit = async (op: 'fill' | 'clear' | 'keyHere') => {
    if (!track) return;
    setBusy(true);
    try {
      const cur = maskAt(track, local);
      const idx = cur ? track.masks!.findIndex((m) => m.path === cur.path) : -1;
      let c: HTMLCanvasElement;
      if (op === 'keyHere') c = cur ? await loadMaskCanvas(cur.path) : await blankMask(media, 0);
      else c = await blankMask(media, op === 'fill' ? 255 : 0);
      const masks = await save(c, track, local, op === 'keyHere' || idx < 0 ? undefined : idx);
      useProject.getState().updateObjectTrack(clip.id, track.id, { masks });
    } catch (e) { useUi.getState().toast((e as Error).message, 'error'); }
    setBusy(false);
  };

  const setTool = (tl: 'brush' | 'erase' | 'lasso') => {
    if (!track) return;
    useUi.getState().select([clip.id]);
    setMaskBrush({ clipId: clip.id, trackId: track.id, size: maskBrush?.size ?? 4, all: false, tool: tl });
  };

  return (
    <Section title={`✏️ ${t.mask.title}`} defaultOpen={!!track}>
      <div className="hint">{t.mask.hint}</div>
      {!track ? (
        <button className="btn primary" style={{ width: '100%' }} disabled={busy} onClick={() => void create()}>✏️ {t.mask.create}</button>
      ) : (
        <>
          <div className="tool-row">
            <button className={`btn sm${active && tool === 'brush' ? ' active' : ''}`} onClick={() => setTool('brush')}>🖌 {t.mask.brush}</button>
            <button className={`btn sm${active && tool === 'erase' ? ' active' : ''}`} onClick={() => setTool('erase')}>🧽 {t.mask.erase}</button>
            <button className={`btn sm${active && tool === 'lasso' ? ' active' : ''}`} onClick={() => setTool('lasso')}>➰ {t.mask.lasso}</button>
            {active && <button className="btn sm ghost" onClick={() => setMaskBrush(null)}>✔ {t.mask.done}</button>}
          </div>
          {active && tool !== 'lasso' && <Slider label={t.mask.size} value={maskBrush!.size} min={0.5} max={30} step={0.5} unit=" %" onChange={(v) => setMaskBrush({ ...maskBrush!, size: v })} />}
          {active && <div className="hint">{tool === 'lasso' ? t.mask.lassoHint : t.mask.brushHint}</div>}
          <div className="tool-row">
            <button className="btn sm ghost" disabled={busy} onClick={() => void edit('fill')}>⬜ {t.mask.fill}</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => void edit('clear')}>⬛ {t.mask.clear}</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => void edit('keyHere')} title={t.mask.keyHereHint}>➕ {t.mask.keyHere}</button>
          </div>
          {(track.masks?.length ?? 0) > 1 && <div className="hint">{track.masks!.length} {t.mask.keys}</div>}
          {cut && cut.trackId === track.id && (
            <>
              <Toggle label={t.mask.enabled} checked={cut.enabled} onChange={(v) => useProject.getState().setCutout(clip.id, { ...cut, enabled: v })} />
              <Toggle label={`🔄 ${t.mask.invert}`} checked={cut.invert} onChange={(v) => useProject.getState().setCutout(clip.id, { ...cut, invert: v })} />
              <Slider label={t.mask.feather} value={cut.feather} min={0} max={40} step={1} unit=" px" onChange={(v) => useProject.getState().setCutout(clip.id, { ...cut, feather: v })} />
            </>
          )}
          {!(cut && cut.trackId === track.id) && (
            <button className="btn sm" onClick={() => useProject.getState().setCutout(clip.id, { enabled: true, trackId: track.id, feather: 4, grow: 0, invert: false })}>{t.mask.use}</button>
          )}
          <button className="btn sm ghost danger" onClick={() => { setMaskBrush(null); useProject.getState().removeObjectTrack(clip.id, track.id); if (cut?.trackId === track.id) useProject.getState().setCutout(clip.id, undefined); }}>🗑 {t.mask.remove}</button>
        </>
      )}
    </Section>
  );
}
