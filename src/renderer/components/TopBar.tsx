import React, { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { doRedo, doUndo, saveProject } from '../actions';
import { t } from '../i18n/de';
import { IconExport, IconRedo, IconSave, IconSettings, IconUndo } from './Icons';
import logo from '../assets/logo.svg';
import { fmt } from '../i18n/de';
import { formatEta } from '../utils/prep';
import type { MediaItem } from '@shared/types';
import { formatBytes, formatDuration } from '@shared/timeline';
import { cssUrl } from '../utils/dom';
import { Popover } from './Popover';

/** Export-Warteschlange: laufende und fertige Exporte, mit Fortschritt, Abbrechen und „Im Ordner zeigen“. */
function ExportQueue(): React.ReactElement | null {
  const jobs = useUi((s) => s.exportJobs);
  const remove = useUi((s) => s.removeExportJob);
  const list = Object.values(jobs);
  if (list.length === 0) return null;
  const running = list.filter((j) => j.phase === 'queued' || j.phase === 'preparing' || j.phase === 'rendering');
  const cur = running.find((j) => j.phase === 'rendering' || j.phase === 'preparing');
  const status = (j: (typeof list)[number]) => j.phase === 'queued' ? t.exportExtra.statusQueued : j.phase === 'done' ? t.exportExtra.statusDone : j.phase === 'error' ? t.exportExtra.statusError : j.phase === 'cancelled' ? t.exportExtra.statusCancelled : `${j.percent} %`;
  return (
    <Popover label={running.length ? <><span className="spinner" /> {fmt(t.exportExtra.queueBusy, { n: running.length })}{cur ? ` · ${cur.percent} %` : ''}</> : <>✅ {t.exportExtra.queueDone}</>} title={t.exportExtra.queueTitle} align="right">
      {list.map((j) => (
        <div key={j.jobId} className="queue-row">
          <div className="queue-name" title={j.outputPath}>{j.name ?? j.outputPath?.split(/[\\/]/).pop() ?? j.jobId}</div>
          <div className="queue-status">{status(j)}{j.eta !== undefined && j.phase === 'rendering' ? ` · ${fmt(t.library.eta, { t: formatEta(j.eta) })}` : ''}</div>
          {(j.phase === 'rendering' || j.phase === 'preparing') && <div className="progress"><div style={{ width: `${j.percent}%` }} /></div>}
          {j.phase === 'error' && j.message && <div className="hint warn">{j.message}</div>}
          <div className="field-row">
            {(j.phase === 'queued' || j.phase === 'rendering' || j.phase === 'preparing') && <button className="btn sm danger" onClick={() => void window.panocut.cancelExport(j.jobId)}>{t.export.cancel}</button>}
            {j.phase === 'done' && j.outputPath && <button className="btn sm" onClick={() => void window.panocut.showInFolder(j.outputPath!)}>{t.exportExtra.showFile}</button>}
            {(j.phase === 'done' || j.phase === 'error' || j.phase === 'cancelled') && <button className="btn sm ghost" onClick={() => remove(j.jobId)}>{t.exportExtra.removeEntry}</button>}
          </div>
        </div>
      ))}
    </Popover>
  );
}

/** Restzeit aller Vorbereitungen schätzen: aus dem Tempo der laufenden Vorschau-Dateien. */
function estimate(busy: MediaItem[], mac: boolean): { percent: number; eta?: number } {
  if (!busy.length) return { percent: 0 };
  const now = Date.now();
  let doneSec = 0, totalSec = 0, speedSum = 0, speedN = 0;
  for (const m of busy) {
    const d = Math.max(1, m.info.duration || 1);
    const pct = m.prep?.percent ?? 0;
    totalSec += d;
    doneSec += (d * pct) / 100;
    if (m.prep && (m.prep.stage === 'proxy' || m.prep.stage === 'stitch') && m.prep.startedAt && pct > 2) {
      const el = (now - m.prep.startedAt) / 1000;
      if (el > 1) { speedSum += (d * pct) / 100 / el; speedN++; }
    }
  }
  const percent = Math.round((doneSec / totalSec) * 100);
  if (!speedN) return { percent };
  const speed = (speedSum / speedN) * Math.min(mac ? 2 : 1, busy.length);
  return { percent, eta: Math.max(1, (totalSec - doneSec) / Math.max(0.01, speed)) };
}

function prepStageText(m: MediaItem, running: boolean): string {
  const p = m.prep;
  if (!p || p.stage === 'waiting') return running ? t.library.prepThumbs : t.library.queueWaiting;
  if (p.stage === 'proxy') return fmt(t.library.queueProxy, { p: p.percent });
  if (p.stage === 'stitch') return fmt(t.library.queueStitch, { p: p.percent });
  if (p.stage === 'wave') return t.library.prepWave;
  return t.library.prepThumbs;
}

/** Anzeige oben: wie viele Dateien gerade vorbereitet werden – anklicken zeigt die Warteschlange (Reihenfolge per Ziehen). */
function PrepIndicator(): React.ReactElement | null {
  const importing = useUi((s) => s.importing);
  const importingFiles = useUi((s) => s.importingFiles);
  const media = useProject((s) => s.project.media);
  const queue = useUi((s) => s.prepQueue);
  const mac = useUi((s) => s.appInfo?.platform === 'darwin');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const busy = Object.values(media).filter((m) => m.status === 'processing' || m.status === 'analyzing');
  if (!importing && busy.length === 0) return null;
  if (importing) {
    return (
      <Popover label={<span className="prep-indicator-btn"><span className="spinner" />{fmt(t.library.importing, { n: importing })}</span>} title={t.library.queueTitle} align="right">
        <div className="hint">{t.library.importingHint}</div>
        <div className="queue-list">{importingFiles.map((f) => <div key={f} className="prep-row"><span className="spinner" /><span className="prep-name">{f.split(/[\\/]/).pop()}</span></div>)}</div>
      </Popover>
    );
  }
  const est = estimate(busy, mac);
  // Reihenfolge wie im Hauptprozess; Dateien ohne Eintrag (z. B. gerade fertig) hinten
  const rank = new Map(queue.map((q, i) => [q.id, i]));
  const running = new Set(queue.filter((q) => q.running).map((q) => q.id));
  const rows = [...busy].sort((a, b) => (running.has(b.id) ? 1 : 0) - (running.has(a.id) ? 1 : 0) || (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  const order = rows.map((m) => m.id);
  const move = (id: string, to: number) => {
    const ids = order.filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    void window.panocut.prepReorder(ids);
  };
  const firstWaiting = rows.findIndex((m) => !running.has(m.id));
  const label = (
    <span className="prep-indicator-btn" title={t.library.preparingHint}>
      <span className="spinner" />
      <span>{fmt(t.library.preparing, { n: busy.length })}</span>
      <span className="progress"><span style={{ width: `${est.percent}%` }} /></span>
      <span>{est.percent} %{est.eta !== undefined ? ` · ${fmt(t.library.eta, { t: formatEta(est.eta) })}` : ''}</span>
    </span>
  );
  return (
    <Popover label={label} title={t.library.queueTitle} align="right">
      <div className="hint">{t.library.queueHint}</div>
      <div className="queue-list">
        {rows.map((m, i) => {
          const run = running.has(m.id);
          const p = m.prep;
          const eta = p?.etaSec;
          return (
            <div
              key={m.id}
              className={`prep-row${run ? ' running' : ''}${overId === m.id && dragId && dragId !== m.id ? ' over' : ''}${dragId === m.id ? ' dragging' : ''}`}
              draggable={!run}
              onDragStart={(e) => { setDragId(m.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', m.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => { if (dragId && !run) { e.preventDefault(); setOverId(m.id); } }}
              onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== m.id) move(dragId, order.filter((x) => x !== dragId).indexOf(m.id)); setDragId(null); setOverId(null); }}
            >
              <span className="prep-handle" title={run ? t.library.queueRunning : t.library.queueDrag}>{run ? '▶' : '⠿'}</span>
              <span className="prep-thumb" style={{ backgroundImage: m.thumb ? cssUrl(m.thumb) : undefined }} />
              <div className="prep-main">
                <div className="prep-title"><span className="prep-name" title={m.path}>{m.name}</span><span className="hint">{formatBytes(m.info.fileSize)}{m.info.duration ? ` · ${formatDuration(m.info.duration)}` : ''}{m.info.width ? ` · ${m.info.width}×${m.info.height}` : ''}</span></div>
                <div className="prep-status"><span>{run ? prepStageText(m, true) : `${i - Math.max(0, firstWaiting) + 1}. ${prepStageText(m, false)}`}</span><span>{run && eta !== undefined ? fmt(t.library.eta, { t: formatEta(eta) }) : ''}</span></div>
                <span className="progress"><span style={{ width: `${p?.percent ?? 0}%` }} /></span>
              </div>
              {!run && (
                <div className="prep-actions">
                  <button className="btn sm ghost" title={t.library.queueNext} onClick={() => move(m.id, 0)}>⤒</button>
                  {!m.stitch || m.stitch.mode === 'equirect' ? <button className="btn sm ghost" title={t.library.queueSkipHint} onClick={() => void window.panocut.prepSkip(m.id)}>{t.library.queueSkip}</button> : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

export function TopBar({ mac }: { mac: boolean }): React.ReactElement {
  const name = useProject((s) => s.project.name);
  const rename = useProject((s) => s.rename);
  const dirty = useUi((s) => s.dirty);
  const openDialog = useUi((s) => s.openDialog);
  const canUndo = useStore(useProject.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useProject.temporal, (s) => s.futureStates.length > 0);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== name) rename(v);
    else setDraft(name);
  };

  return (
    <header className={`topbar${mac ? ' mac' : ''}`}>
      <div className="brand"><img src={logo} alt="" /> {t.app.name}</div>
      <input
        className="project-name"
        title={t.top.projectName}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(name); (e.target as HTMLInputElement).blur(); } }}
        spellCheck={false}
      />
      {dirty && <span className="dirty-dot" title={t.top.unsaved}>●</span>}
      <div className="spacer" />
      <PrepIndicator />
      <ExportQueue />
      <button className="btn icon ghost" title={t.top.undo} onClick={doUndo} disabled={!canUndo}><IconUndo /></button>
      <button className="btn icon ghost" title={t.top.redo} onClick={doRedo} disabled={!canRedo}><IconRedo /></button>
      <button className="btn" title={`${t.top.save} (⌘/Strg+S)`} onClick={() => void saveProject(false)}><IconSave />{t.top.save}</button>
      <button className="btn primary" title={`${t.top.export} (⌘/Strg+E)`} onClick={() => openDialog('export')}><IconExport />{t.top.export}</button>
      <button className="btn icon ghost" title={t.top.settings} onClick={() => openDialog('settings')}><IconSettings /></button>
    </header>
  );
}
