import React, { useEffect, useMemo, useState } from 'react';
import type { ExportCodec, ExportFormat, ExportOptions, ExportQuality } from '@shared/types';
import { CODEC_NAMES, EXPORT_PRESETS, FORMAT_CODECS, QUALITY_NAMES } from '@shared/presets';
import { formatBytes, formatDuration, projectDuration } from '@shared/timeline';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { stopPlayback } from '../engine/instance';
import { t } from '../i18n/de';
import { IconClose } from './Icons';

export function ExportDialog(): React.ReactElement {
  const project = useProject((s) => s.project);
  const close = () => useUi.getState().openDialog('none');
  const appInfo = useUi((s) => s.appInfo);
  const settings = useUi((s) => s.settings);
  const progress = useUi((s) => s.exportProgress);
  const setProgress = useUi((s) => s.setExportProgress);
  const rangeIn = useUi((s) => s.rangeIn);
  const rangeOut = useUi((s) => s.rangeOut);
  const toast = useUi((s) => s.toast);

  const [presetId, setPresetId] = useState('hd');
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId)!;
  const [width, setWidth] = useState(preset.width);
  const [height, setHeight] = useState(preset.height);
  const [fps, setFps] = useState(preset.fps);
  const [format, setFormat] = useState<ExportFormat>(preset.format);
  const [codec, setCodec] = useState<ExportCodec>(preset.codec);
  const [quality, setQuality] = useState<ExportQuality>(preset.quality);
  const [hardware, setHardware] = useState(settings.hardwareAccel);
  const [useRange, setUseRange] = useState(false);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [photosState, setPhotosState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  useEffect(() => {
    setWidth(preset.width); setHeight(preset.height); setFps(preset.fps);
    setFormat(preset.format); setCodec(preset.codec); setQuality(preset.quality);
  }, [presetId]);

  useEffect(() => {
    if (!FORMAT_CODECS[format].includes(codec)) setCodec(FORMAT_CODECS[format][0]);
  }, [format]);

  useEffect(() => { setProgress(null); return () => { /* Fortschritt bleibt sichtbar bis zum Schließen */ }; }, []);

  const duration = useMemo(() => {
    const total = projectDuration(project);
    if (useRange && rangeIn !== null && rangeOut !== null && rangeOut > rangeIn) return Math.min(total, rangeOut) - Math.max(0, rangeIn);
    return total;
  }, [project, useRange, rangeIn, rangeOut]);

  const estSize = useMemo(() => {
    const bpp = codec === 'prores' ? 2.5 : { low: 0.05, medium: 0.08, high: 0.12, max: 0.2 }[quality];
    const bits = width * height * fps * bpp * duration + 192_000 * duration;
    return bits / 8;
  }, [width, height, fps, quality, codec, duration]);

  const safeName = project.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Video';

  const start = async () => {
    stopPlayback();
    let out = outputPath;
    if (!out || !out.toLowerCase().endsWith(`.${format}`)) {
      out = await window.panocut.selectExportPath(safeName, format);
      if (!out) return;
      setOutputPath(out);
    }
    const options: ExportOptions = {
      outputPath: out, width, height, fps, format, codec, quality, hardware, audioBitrate: quality === 'low' ? 128 : 192,
      range: useRange && rangeIn !== null && rangeOut !== null ? { start: rangeIn, end: rangeOut } : undefined,
    };
    setPhotosState('idle');
    const id = await window.panocut.startExport(project, options);
    setJobId(id);
  };

  const cancel = () => { if (jobId) void window.panocut.cancelExport(jobId); };

  const importToPhotos = async () => {
    if (!progress?.outputPath) return;
    setPhotosState('busy');
    const r = await window.panocut.importToPhotos(progress.outputPath);
    setPhotosState(r.ok ? 'done' : 'error');
    if (r.ok) toast(t.export.photosDone, 'success'); else toast(r.message ?? 'Fehler', 'error');
  };

  const busy = progress && (progress.phase === 'preparing' || progress.phase === 'rendering');
  const done = progress?.phase === 'done';
  const failed = progress?.phase === 'error';
  const isCustom = presetId === 'custom';
  const empty = projectDuration(project) <= 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) close(); }}>
      <div className="modal wide">
        <div className="modal-header">
          <span>{t.export.title}</span>
          <button className="btn icon ghost" onClick={close} disabled={!!busy}><IconClose /></button>
        </div>
        <div className="modal-body">
          {!busy && !done && (
            <>
              <div>
                <div className="hint" style={{ marginBottom: 8, fontSize: 12 }}>{t.export.preset}</div>
                <div className="preset-list">
                  {EXPORT_PRESETS.map((p) => (
                    <div key={p.id} className={`preset${presetId === p.id ? ' active' : ''}`} onClick={() => setPresetId(p.id)}>
                      <div className="name">{p.name}</div>
                      <div className="desc">{p.description}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="form-grid">
                <label>{t.export.format}</label>
                <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                  <option value="mp4">MP4 (empfohlen)</option>
                  <option value="mov">MOV (QuickTime)</option>
                  <option value="webm">WebM</option>
                  <option value="gif">GIF</option>
                </select>
                <label>{t.export.codec}</label>
                <select value={codec} onChange={(e) => setCodec(e.target.value as ExportCodec)}>
                  {FORMAT_CODECS[format].map((c) => <option key={c} value={c}>{CODEC_NAMES[c]}</option>)}
                </select>
                <label>{t.export.quality}</label>
                <select value={quality} onChange={(e) => setQuality(e.target.value as ExportQuality)} disabled={codec === 'gif'}>
                  {(Object.keys(QUALITY_NAMES) as ExportQuality[]).map((q) => <option key={q} value={q}>{QUALITY_NAMES[q]}</option>)}
                </select>
                <label>{t.export.resolution}</label>
                <div className="inline">
                  <input type="number" value={width} min={16} max={8192} step={2} onChange={(e) => setWidth(Math.max(16, Math.round(Number(e.target.value) / 2) * 2))} disabled={!isCustom} style={{ width: 90 }} />
                  ×
                  <input type="number" value={height} min={16} max={8192} step={2} onChange={(e) => setHeight(Math.max(16, Math.round(Number(e.target.value) / 2) * 2))} disabled={!isCustom} style={{ width: 90 }} />
                  {isCustom && <button className="btn sm ghost" onClick={() => { setWidth(project.settings.width); setHeight(project.settings.height); }}>Wie Projekt</button>}
                </div>
                <label>{t.export.fps}</label>
                <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f}</option>)}
                  {![24, 25, 30, 50, 60].includes(fps) && <option value={fps}>{fps}</option>}
                </select>
                <label />
                <label className="toggle"><input type="checkbox" checked={hardware} onChange={(e) => setHardware(e.target.checked)} /> {t.export.hardware}</label>
                {rangeIn !== null && rangeOut !== null && rangeOut > rangeIn && (
                  <>
                    <label />
                    <label className="toggle"><input type="checkbox" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} /> {t.export.range}</label>
                  </>
                )}
                <label>{t.export.outputTo}</label>
                <div className="inline">
                  <span className="hint" style={{ flex: 1, wordBreak: 'break-all' }}>{outputPath ?? `… /${safeName}.${format}`}</span>
                  <button className="btn sm" onClick={async () => { const p = await window.panocut.selectExportPath(safeName, format); if (p) setOutputPath(p); }}>{t.export.choose}</button>
                </div>
              </div>
              <div className="hint">
                {t.export.estimatedSize}: ~{formatBytes(estSize)} · {formatDuration(duration)} · {width}×{height} @ {fps} fps
              </div>
              {failed && <div className="error-box">{progress?.message}</div>}
            </>
          )}

          {busy && (
            <div>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>{progress?.message ?? t.export.rendering}</div>
              <div className="progress"><div style={{ width: `${progress?.percent ?? 0}%` }} /></div>
              <div className="progress-text">
                <span>{progress?.percent ?? 0} %{progress?.fps ? ` · ${Math.round(progress.fps)} fps` : ''}{progress?.speed ? ` · ${progress.speed}` : ''}</span>
                <span>{progress?.eta !== undefined ? `${formatDuration(progress.eta)} ${t.export.eta}` : ''}</span>
              </div>
            </div>
          )}

          {done && progress?.outputPath && (
            <div className="result-box">
              <div style={{ fontWeight: 700, fontSize: 15 }}>✅ {t.export.done}</div>
              <div className="path">{progress.outputPath}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => void window.panocut.showInFolder(progress.outputPath!)}>{t.export.showInFolder}</button>
                {appInfo?.platform === 'darwin' && (
                  <button className="btn" onClick={() => void importToPhotos()} disabled={photosState === 'busy' || photosState === 'done'}>
                    {photosState === 'busy' ? <span className="spinner" /> : null} {photosState === 'done' ? t.export.photosDone : t.export.importToPhotos}
                  </button>
                )}
              </div>
              {appInfo?.platform === 'darwin' && <div className="hint">{t.export.importToPhotosHint}</div>}
            </div>
          )}
        </div>
        <div className="modal-footer">
          {busy ? (
            <button className="btn danger" onClick={cancel}>{t.export.cancel}</button>
          ) : done ? (
            <button className="btn primary" onClick={close}>{t.export.close}</button>
          ) : (
            <>
              <button className="btn" onClick={close}>{t.export.cancel}</button>
              <button className="btn primary" onClick={() => void start()} disabled={empty} title={empty ? t.export.emptyTimeline : ''}>{t.export.start}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
