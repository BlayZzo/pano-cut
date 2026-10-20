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

/** Anzeige oben: wie viele Dateien gerade vorbereitet werden, Gesamtfortschritt und Restzeit. */
function PrepIndicator(): React.ReactElement | null {
  const importing = useUi((s) => s.importing);
  const media = useProject((s) => s.project.media);
  const busy = Object.values(media).filter((m) => m.status === 'processing' || m.status === 'analyzing');
  if (!importing && busy.length === 0) return null;
  if (importing) return <div className="prep-indicator"><span className="spinner" />{fmt(t.library.importing, { n: importing })}</div>;
  const percent = Math.round(busy.reduce((s, m) => s + (m.prep?.percent ?? 0), 0) / busy.length);
  const etas = busy.map((m) => m.prep?.etaSec).filter((x): x is number => x !== undefined);
  const waiting = busy.filter((m) => !m.prep || m.prep.stage === 'waiting').length;
  const eta = etas.length ? Math.max(...etas) : undefined;
  return (
    <div className="prep-indicator" title={t.library.preparingHint}>
      <span className="spinner" />
      <span>{fmt(t.library.preparing, { n: busy.length })}</span>
      <div className="progress"><div style={{ width: `${percent}%` }} /></div>
      <span>{percent} %{eta !== undefined ? ` · ${fmt(t.library.eta, { t: formatEta(eta) })}${waiting ? ' +' : ''}` : ''}</span>
    </div>
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
