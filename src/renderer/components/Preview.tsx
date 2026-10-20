import React, { useEffect, useRef, useState } from 'react';
import { clipDuration, formatTime, projectDuration } from '@shared/timeline';
import { keyframeAt, panoViewAt, upsertKeyframe } from '@shared/pano';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi, usePlayheadCoarse, useView, updateView, getView } from '../store/ui';
import { Popover } from './Popover';
import { engine, playPause } from '../engine/instance';
import { goEnd, goStart, stepFrames } from '../actions';
import { t } from '../i18n/de';
import { IconLoop, IconPause, IconPlay, IconSkipBack, IconSkipFwd, IconStepBack, IconStepFwd } from './Icons';
import { AiPanel } from './AiPanel';
import { EffectPanel } from './EffectPanel';
import { ImagePanel } from './ImagePanel';
import { MulticamStrip } from './MulticamStrip';
import { Model3DPanel } from './Model3DPanel';
import { groupAt } from '../multicamActions';
import { maskAt, trackActiveAt, trackBoxAt } from '@shared/ai';
import { forgetMask } from '../engine/playback';
import { boxToSource, canvasToPng, canvasToSource, clipBox, dabToBox, drawSelection, loadMaskCanvas, paintDab, tintMask } from './previewTools';

export function Preview(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settings = useProject((s) => s.project.settings);
  const hasClips = useProject((s) => Object.keys(s.project.clips).length > 0);
  const duration = useProject((s) => projectDuration(s.project));
  const playing = useUi((s) => s.playing);
  const loop = useUi((s) => s.loop);
  const setLoop = useUi((s) => s.setLoop);
  const selection = useUi((s) => s.selection);
  const clips = useProject((s) => s.project.clips);
  const media = useProject((s) => s.project.media);
  const setPano = useProject((s) => s.setPano);
  const setChroma = useProject((s) => s.setChroma);
  const [dragging, setDragging] = useState(false);
  const aiPanel = useUi((s) => s.aiPanel);
  const setAiPanel = useUi((s) => s.setAiPanel);
  const pickColor = useUi((s) => s.pickColor);
  const pointPick = useUi((s) => s.pointPick);
  const setPickColor = useUi((s) => s.setPickColor);
  const vfxPanel = useUi((s) => s.vfxPanel);
  const imagePanel = useUi((s) => s.imagePanel);
  const multicamPanel = useUi((s) => s.multicamPanel);
  const modelPanel = useUi((s) => s.modelPanel);
  const setModelPanel = useUi((s) => s.setModelPanel);
  const setMulticamPanel = useUi((s) => s.setMulticamPanel);
  const multicamGroups = useProject((s) => s.project.multicam);
  const hasMulticam = !!multicamGroups && Object.keys(multicamGroups).length > 0;
  const setImagePanel = useUi((s) => s.setImagePanel);
  const setVfxPanel = useUi((s) => s.setVfxPanel);
  const maskBrush = useUi((s) => s.maskBrush);
  const setMaskBrush = useUi((s) => s.setMaskBrush);
  const updateClip = useProject((s) => s.updateClip);
  const updateObjectTrack = useProject((s) => s.updateObjectTrack);
  const toast = useUi((s) => s.toast);
  const [placing, setPlacing] = useState(false);
  // Pinsel: bearbeitete Maske (Canvas), eingefärbte Anzeige, Version für Neuzeichnen
  const brushRef = useRef<{ path: string; index: number; canvas: HTMLCanvasElement; tint: HTMLCanvasElement } | null>(null);
  const [brushVersion, setBrushVersion] = useState(0);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Ausgewählter Clip (für KI-Bereich und Objekt-Rahmen)
  const selectedClip = selection.map((id) => clips[id]).find(Boolean) ?? null;
  const selectedMedia = selectedClip ? media[selectedClip.mediaId] ?? null : null;
  // Während der Wiedergabe nur grob mitzählen (sonst zeichnet sich die ganze Vorschau-Leiste 30× pro Sekunde neu);
  // genau nur, wenn erkannte Objekte live eingezeichnet werden
  const playhead = usePlayheadCoarse(0.5, !!(aiPanel && selectedClip?.objects?.length));
  const view = useView();
  const [hover, setHover] = useState(false);
  const guidesRef = useRef<HTMLDivElement>(null);

  // Objekt-Rahmen über der Vorschau zeichnen
  useEffect(() => {
    const ov = overlayRef.current, c = canvasRef.current;
    if (!ov || !c) return;
    const rect = c.getBoundingClientRect();
    const stage = stageRef.current?.getBoundingClientRect();
    ov.width = Math.max(1, Math.round(rect.width));
    ov.height = Math.max(1, Math.round(rect.height));
    ov.style.left = `${rect.left - (stage?.left ?? 0)}px`;
    ov.style.top = `${rect.top - (stage?.top ?? 0)}px`;
    const ctx = ov.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, ov.width, ov.height);
    const k = ov.width / Math.max(1, c.width);
    // Rahmen des ausgewählten Clips (zum Verschieben/Skalieren) bzw. Maske beim Pinseln
    if (selectedClip && selectedMedia && !playing && selectedClip.kind !== 'title' && selectedMedia.type !== 'audio'
      && playhead >= selectedClip.start && playhead < selectedClip.start + clipDuration(selectedClip) && !(selectedClip.pano && selectedMedia.info.is360)) {
      const box = clipBox(selectedClip, selectedMedia, c.width, c.height);
      if (box) {
        const br = brushRef.current;
        if (maskBrush && maskBrush.clipId === selectedClip.id && br) {
          ctx.save();
          ctx.scale(k, k);
          ctx.translate(box.cx, box.cy);
          ctx.rotate((box.rot * Math.PI) / 180);
          ctx.scale(selectedClip.fx?.mirror ? -1 : 1, selectedClip.fx?.flip ? -1 : 1);
          const cr = selectedClip.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
          const mw = br.tint.width, mh = br.tint.height;
          ctx.drawImage(br.tint, (cr.left / 100) * mw, (cr.top / 100) * mh, mw * (1 - (cr.left + cr.right) / 100), mh * (1 - (cr.top + cr.bottom) / 100), -box.w / 2, -box.h / 2, box.w, box.h);
          ctx.restore();
        } else if ((!aiPanel || !selectedClip.objects?.length) && (view.selectionFrame === 'always' || (view.selectionFrame === 'hover' && (hover || dragging || placing)))) {
          drawSelection(ctx, box, k);
        }
      }
    }
    if (!selectedClip?.objects?.length || (!aiPanel && !maskBrush)) return;
    const local = playhead - selectedClip.start;
    for (const tr of selectedClip.objects) {
      if (!trackActiveAt(tr, local)) continue;
      const b = trackBoxAt(tr, local);
      if (!b) continue;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x * ov.width, b.y * ov.height, b.w * ov.width, b.h * ov.height);
      ctx.fillStyle = tr.color;
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(tr.labelDe, b.x * ov.width + 4, Math.max(12, b.y * ov.height - 4));
    }
  }, [selectedClip, selectedMedia, playhead, playing, aiPanel, maskBrush, brushVersion, settings.width, settings.height, view.selectionFrame, hover, dragging, placing, view.leftWidth, view.rightWidth, view.timelineHeight]);

  // Pinsel: Maske an der aktuellen Stelle laden
  const brushTrack = maskBrush ? clips[maskBrush.clipId]?.objects?.find((o) => o.id === maskBrush.trackId) : undefined;
  const brushMask = maskBrush && brushTrack ? maskAt(brushTrack, playhead - (clips[maskBrush.clipId]?.start ?? 0)) : null;
  useEffect(() => {
    if (!brushMask) { brushRef.current = null; setBrushVersion((v) => v + 1); return; }
    if (brushRef.current?.path === brushMask.path) return;
    let alive = true;
    const index = brushTrack!.masks!.findIndex((m) => m.path === brushMask.path);
    void loadMaskCanvas(brushMask.path).then((canvas) => {
      if (!alive) return;
      brushRef.current = { path: brushMask.path, index, canvas, tint: tintMask(canvas) };
      setBrushVersion((v) => v + 1);
    }).catch(() => {});
    return () => { alive = false; };
  }, [brushMask?.path]);

  // Esc beendet den Pinsel
  useEffect(() => {
    if (!maskBrush) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaskBrush(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maskBrush, setMaskBrush]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    // Vorschau intern nur so groß rendern, wie sie angezeigt wird (höchstens Full HD) – spart viel Rechenzeit,
    // der Export bleibt in voller Größe
    const fit = () => {
      const stage = stageRef.current;
      const rect = stage?.getBoundingClientRect();
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const cssW = rect && rect.width > 50 ? Math.max(50, Math.min(rect.width - 28, (rect.height - 28) * (settings.width / settings.height))) : 0;
      // Anzeigegröße fest vorgeben (unabhängig von der internen Auflösung)
      if (cssW) { c.style.width = `${Math.floor(cssW)}px`; c.style.height = `${Math.floor(cssW * settings.height / settings.width)}px`; }
      const q = getView().previewQuality;
      const qk = q === 'half' ? 0.5 : q === 'quarter' ? 0.25 : 1;
      const shown = (q === 'full' ? 1920 : cssW ? cssW * dpr : 1920) * qk;
      const longSide = Math.max(settings.width, settings.height);
      const targetLong = Math.max(q === 'quarter' ? 320 : q === 'half' ? 480 : 640, Math.min(1920, Math.ceil((shown * (longSide / settings.width)) / 160) * 160));
      // Hilfslinien genau über das Bild legen
      const g = guidesRef.current;
      if (g && rect && cssW) { const cssH = cssW * settings.height / settings.width; g.style.left = `${(rect.width - cssW) / 2}px`; g.style.top = `${(rect.height - cssH) / 2}px`; g.style.width = `${cssW}px`; g.style.height = `${cssH}px`; }
      const k = Math.min(1, targetLong / longSide);
      const w = Math.round((settings.width * k) / 2) * 2, h = Math.round((settings.height * k) / 2) * 2;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; engine.redraw(); }
    };
    fit();
    engine.setCanvas(c);
    let timer = 0;
    const ro = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(fit, 200); });
    if (stageRef.current) ro.observe(stageRef.current);
    return () => { ro.disconnect(); window.clearTimeout(timer); engine.setCanvas(null); };
  }, [settings.width, settings.height, view.previewQuality]);

  // 360°-Clip unter dem Abspielkopf, der ausgewählt ist → mit der Maus umschauen
  const panoClip = selection.map((id) => clips[id]).find((c) => c && c.pano && media[c.mediaId]?.info.is360 && playhead >= c.start && playhead < c.start + clipDuration(c));

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pickColor && selectedClip && e.button === 0) {
      const c = e.currentTarget;
      const rect = c.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * c.width);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * c.height);
      const d = c.getContext('2d')?.getImageData(x, y, 1, 1).data;
      if (d) {
        const hex = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
        setChroma(selectedClip.id, { ...(selectedClip.chroma ?? { enabled: true, similarity: 0.3, blend: 0.1, despill: true, color: hex }), color: hex, enabled: true });
      }
      setPickColor(false);
      return;
    }
    if (e.button !== 0) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const toCanvas = (cx: number, cy: number) => ({ x: ((cx - rect.left) / rect.width) * canvas.width, y: ((cy - rect.top) / rect.height) * canvas.height });

    // Punkt anklicken (z. B. „Objekt per Klick freistellen“)
    const pp = useUi.getState().pointPick;
    if (pp) {
      const clip = clips[pp.clipId];
      const m = clip ? media[clip.mediaId] : undefined;
      const box = clip && m ? clipBox(clip, m, canvas.width, canvas.height) : null;
      useUi.getState().setPointPick(null);
      if (clip && box) {
        const p0 = toCanvas(e.clientX, e.clientY);
        const { u, v } = canvasToSource(box, clip, p0.x, p0.y);
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) pp.onPick(u, v);
        else useUi.getState().toast(t.cutout.outside, 'error');
      }
      return;
    }

    // Masken-Pinsel
    if (maskBrush && selectedClip && selectedMedia && maskBrush.clipId === selectedClip.id && brushRef.current && brushTrack) {
      const box = clipBox(selectedClip, selectedMedia, canvas.width, canvas.height);
      const br = brushRef.current;
      if (!box) return;
      const add = !e.altKey;
      const local = playhead - selectedClip.start;
      const sampleT = brushTrack.masks![br.index]?.t ?? local;
      const dabs: Array<{ u: number; v: number; r: number }> = [];
      const radiusFrac = maskBrush.size / 100;   // relativ zur Bildhöhe des Quellbilds
      const paintAt = (cx: number, cy: number) => {
        const p0 = toCanvas(cx, cy);
        const { u, v } = canvasToSource(box, selectedClip, p0.x, p0.y);
        const rpx = radiusFrac * br.canvas.height;
        paintDab(br.canvas, u, v, rpx, add);
        dabs.push({ u, v, r: radiusFrac });
        br.tint = tintMask(br.canvas);
        setBrushVersion((x) => x + 1);
      };
      canvas.setPointerCapture(e.pointerId);
      paintAt(e.clientX, e.clientY);
      const move = (ev: PointerEvent) => paintAt(ev.clientX, ev.clientY);
      const up = async () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        // Speichern: diese Maske – und auf Wunsch alle anderen (Strich folgt der Objekt-Box)
        try {
          const masks = [...brushTrack.masks!];
          const stamp = Date.now().toString(36);
          const save = async (i: number, cnv: HTMLCanvasElement) => {
            const path = await window.panocut.aiSaveMask(selectedMedia.path, brushTrack.id, `edit_${i}_${stamp}`, await canvasToPng(cnv));
            forgetMask(masks[i].path);
            masks[i] = { t: masks[i].t, path };
          };
          await save(br.index, br.canvas);
          if (maskBrush.all) {
            for (let i = 0; i < masks.length; i++) {
              if (i === br.index) continue;
              const other = await loadMaskCanvas(masks[i].path);
              let any = false;
              for (const d of dabs) {
                const rel = dabToBox(brushTrack, sampleT, d.u, d.v);
                const src = rel ? boxToSource(brushTrack, masks[i].t, rel.bu, rel.bv) : null;
                if (!rel || !src) continue;
                paintDab(other, src.u, src.v, d.r * other.height * (src.bh / Math.max(1e-4, rel.bh)), add);
                any = true;
              }
              if (any) await save(i, other);
            }
          }
          brushRef.current = { ...br, path: masks[br.index].path };
          updateObjectTrack(selectedClip.id, brushTrack.id, { masks });
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => void up(), { once: true });
      return;
    }

    // Ausgewählten Clip in der Vorschau verschieben (Umschalt = drehen)
    const target = selectedClip && !panoClip && playhead >= selectedClip.start && playhead < selectedClip.start + clipDuration(selectedClip)
      ? (selectedClip.link ? clips[selectedClip.link.clipId] ?? selectedClip : selectedClip) : null;
    if (target && (target.kind === 'title' || (media[target.mediaId] && media[target.mediaId].type !== 'audio'))) {
      const start = toCanvas(e.clientX, e.clientY);
      const base = target.kind === 'title' ? { x: target.title!.x, y: target.title!.y, rot: 0 } : { x: target.transform.x, y: target.transform.y, rot: target.transform.rotation };
      const cx = target.kind === 'title' ? (base.x / 100) * canvas.width : canvas.width / 2 + (base.x / 100) * canvas.width;
      const cy = target.kind === 'title' ? (base.y / 100) * canvas.height : canvas.height / 2 + (base.y / 100) * canvas.height;
      const rotate = e.shiftKey && target.kind !== 'title';
      const a0 = Math.atan2(start.y - cy, start.x - cx);
      beginTransaction();
      setPlacing(true);
      canvas.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const p1 = toCanvas(ev.clientX, ev.clientY);
        if (rotate) {
          const a1 = Math.atan2(p1.y - cy, p1.x - cx);
          let rot = base.rot + ((a1 - a0) * 180) / Math.PI;
          if (ev.ctrlKey || ev.metaKey) rot = Math.round(rot / 15) * 15;
          updateClip(target.id, { transform: { ...target.transform, rotation: Math.round(rot * 10) / 10 } });
          return;
        }
        const nx = base.x + ((p1.x - start.x) / canvas.width) * 100;
        const ny = base.y + ((p1.y - start.y) / canvas.height) * 100;
        if (target.kind === 'title') updateClip(target.id, { title: { ...target.title!, x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 } });
        else updateClip(target.id, { transform: { ...target.transform, x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 } });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        endTransaction();
        setPlacing(false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    if (!panoClip) return;
    const clip = panoClip;
    const pano = clip.pano!;
    const local = Math.max(0, Math.min(clipDuration(clip), playhead - clip.start));
    const base = keyframeAt(pano, local) ?? (pano.keyframes.length === 1 ? pano.keyframes[0] : { t: local, ...panoViewAt(pano, local) });
    const startX = e.clientX, startY = e.clientY;
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
    if (maskBrush) {
      setMaskBrush({ ...maskBrush, size: Math.max(0.5, Math.min(30, maskBrush.size * Math.exp(-e.deltaY * 0.002))) });
      return;
    }
    const sel = selectedClip && !panoClip && playhead >= selectedClip.start && playhead < selectedClip.start + clipDuration(selectedClip)
      ? (selectedClip.link ? clips[selectedClip.link.clipId] ?? selectedClip : selectedClip) : null;
    if (sel && sel.kind === 'title') {
      updateClip(sel.id, { title: { ...sel.title!, size: Math.max(1, Math.min(40, sel.title!.size * Math.exp(-e.deltaY * 0.0015))) } });
      return;
    }
    if (sel && media[sel.mediaId]?.type !== 'audio') {
      updateClip(sel.id, { transform: { ...sel.transform, scale: Math.round(Math.max(0.05, Math.min(6, sel.transform.scale * Math.exp(-e.deltaY * 0.0015))) * 1000) / 1000 } });
      return;
    }
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
      <div className={`preview-stage${panoClip ? ' pano' : ''}${dragging ? ' dragging' : ''}${pickColor || pointPick ? ' picking' : ''}${placing ? ' placing' : ''}${maskBrush ? ' brushing' : ''}${view.previewBackground === 'checker' ? ' checker' : ''}`} ref={stageRef} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        <canvas ref={canvasRef} style={{ aspectRatio: `${settings.width} / ${settings.height}` }} onPointerDown={onPointerDown} onWheel={onWheel} />
        <canvas ref={overlayRef} className="preview-overlay" />
        <div className="preview-guides" ref={guidesRef} style={{ display: view.previewGuides === 'none' ? 'none' : undefined }}>
          {(view.previewGuides === 'thirds' || view.previewGuides === 'both') && <div className="g3" />}
          {(view.previewGuides === 'safe' || view.previewGuides === 'both') && <div className="safe"><span>{t.view.guidesSafe}</span></div>}
        </div>
        {!hasClips && <div className="preview-empty">{t.preview.empty}</div>}
        {panoClip && !pickColor && <div className="preview-badge">360° · ziehen = umschauen · Mausrad = zoomen</div>}
        {pickColor && <div className="preview-badge">{t.ai.picking}</div>}
        {pointPick && <div className="preview-badge">{t.cutout.clickHint} <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => useUi.getState().setPointPick(null)}>{t.common.cancel}</button></div>}
        {maskBrush && (
          <div className="preview-badge">
            {brushMask ? t.layers.brushOn : t.layers.noMaskHere}
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setMaskBrush(null)}>{t.layers.brushDone}</button>
          </div>
        )}
        <AiPanel clip={selectedClip} media={selectedMedia} />
        <EffectPanel />
        <ImagePanel />
        <Model3DPanel />
      </div>
      <MulticamStrip />
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
        <button className={`btn sm${imagePanel ? ' active' : ''}`} title={t.imageAssist.title} onClick={() => { setImagePanel(!imagePanel); if (!imagePanel) { setVfxPanel(false); setModelPanel(null); } }} style={{ fontWeight: 700 }}>✦ {t.imageAssist.button}</button>
        <button className={`btn sm${vfxPanel ? ' active' : ''}`} title={t.vfx.title} onClick={() => { setVfxPanel(!vfxPanel); if (!vfxPanel) { setImagePanel(false); setModelPanel(null); } }} style={{ fontWeight: 700 }}>✦ {t.vfx.button}</button>
        <button className={`btn sm${aiPanel ? ' active' : ''}`} title={t.ai.title} onClick={() => setAiPanel(!aiPanel)} style={{ fontWeight: 700 }}>✦ {t.ai.button}</button>
        <button className={`btn sm${modelPanel ? ' active' : ''}`} title={t.model3d.title} onClick={() => setModelPanel(modelPanel ? null : {})} style={{ fontWeight: 700 }}>🧊 {t.model3d.button}</button>
        {hasMulticam && <button className={`btn sm${multicamPanel ? ' active' : ''}`} title={t.multicam.title} onClick={() => setMulticamPanel(multicamPanel ? null : (groupAt(useUi.getState().playhead)?.id ?? Object.keys(multicamGroups ?? {})[0] ?? null))}>🎥 {t.multicam.button}</button>}
        <button className="btn sm" title={t.tools.title} onClick={() => useUi.getState().openTools()} style={{ fontWeight: 700 }}>🧰 {t.tools.button}</button>
        <Popover label={`⚙ ${t.view.button}`} title={t.view.previewTitle} align="right" up>
          <div className="form-grid compact">
            <label>{t.view.quality}</label>
            <select value={view.previewQuality} onChange={(e) => updateView({ previewQuality: e.target.value as 'auto' })}>
              <option value="auto">{t.view.qualityAuto}</option><option value="full">{t.view.qualityFull}</option>
              <option value="half">{t.view.qualityHalf}</option><option value="quarter">{t.view.qualityQuarter}</option>
            </select>
            <label>{t.view.guides}</label>
            <select value={view.previewGuides} onChange={(e) => updateView({ previewGuides: e.target.value as 'none' })}>
              <option value="none">{t.view.guidesNone}</option><option value="thirds">{t.view.guidesThirds}</option>
              <option value="safe">{t.view.guidesSafe}</option><option value="both">{t.view.guidesBoth}</option>
            </select>
            <label>{t.view.frame}</label>
            <select value={view.selectionFrame} onChange={(e) => updateView({ selectionFrame: e.target.value as 'hover' })}>
              <option value="always">{t.view.frameAlways}</option><option value="hover">{t.view.frameHover}</option><option value="never">{t.view.frameNever}</option>
            </select>
            <label>{t.view.background}</label>
            <select value={view.previewBackground} onChange={(e) => updateView({ previewBackground: e.target.value as 'black' })}>
              <option value="black">{t.view.bgBlack}</option><option value="checker">{t.view.bgChecker}</option>
            </select>
          </div>
          <div className="hint">{t.view.qualityHint}</div>
          <div className="popover-title" style={{ marginTop: 4 }}>{t.view.panels}</div>
          <label className="toggle"><input type="checkbox" checked={view.leftWidth > 0} onChange={(e) => updateView({ leftWidth: e.target.checked ? 300 : 0 })} /> {t.view.showLibrary}</label>
          <label className="toggle"><input type="checkbox" checked={view.rightWidth > 0} onChange={(e) => updateView({ rightWidth: e.target.checked ? 300 : 0 })} /> {t.view.showInspector}</label>
          <button className="btn sm" onClick={() => updateView({ leftWidth: 300, rightWidth: 300, timelineHeight: 300 })}>{t.view.resetLayout}</button>
        </Popover>
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
