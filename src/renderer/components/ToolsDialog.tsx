import React, { useEffect, useState } from 'react';
import type { AiDetectModel, ExportOptions, StorageInfo } from '@shared/types';
import { EXPORT_PRESETS } from '@shared/presets';
import { TITLE_TEMPLATES, defaultTitle } from '@shared/pano';
import { createTitleClip, formatBytes, formatTime, projectDuration } from '@shared/timeline';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { IconClose } from './Icons';
import { reframeProject, targetSize, type ReframeOptions } from '../tools/reframe';
import { applyHookAsIntro, applyRoughCuts, findHooks, findRoughCuts, type HookCandidate, type RoughCandidate, type RoughOptions } from '../tools/analysis';
import { deleteTemplate, projectFromTemplate, saveTemplate } from '../tools/templates';
import { seekTo, stopPlayback } from '../engine/instance';
import { importFiles } from '../actions';
import { describeFactor, ensureTimes, syncAngles } from '../tools/timesync';
import { estimateTimelapse } from '@shared/timesync';
import { NumInput } from './InspectorBits';
import { SPEED_RAMPS, type SpeedRamp } from '@shared/cameraMoves';
import { applyLook, carReel, rampOnAccents, rigLook, shakesOnAccents, textBehindCar, whipBetween } from '../tools/carporn';

export type ToolPage = 'reframe' | 'hook' | 'cover' | 'rough' | 'time' | 'carporn' | 'templates' | 'watch' | 'storage';

const GROUPS: Array<{ name: string; pages: Array<{ id: ToolPage; icon: string; label: string }> }> = [
  { name: t.tools.groupSocial, pages: [
    { id: 'reframe', icon: '📱', label: t.tools.reframe },
    { id: 'hook', icon: '🎣', label: t.tools.hook },
    { id: 'cover', icon: '🖼️', label: t.tools.cover },
  ] },
  { name: t.tools.groupEdit, pages: [{ id: 'rough', icon: '✂️', label: t.tools.rough }, { id: 'time', icon: '⏱', label: t.time.title }, { id: 'carporn', icon: '🏎', label: t.carporn.title }] },
  { name: t.tools.groupProject, pages: [{ id: 'templates', icon: '📋', label: t.tools.templates }] },
  { name: t.tools.groupFiles, pages: [
    { id: 'watch', icon: '👀', label: t.tools.watch },
    { id: 'storage', icon: '🧹', label: t.tools.storage },
  ] },
];

/** Werkzeuge in Kategorien (links) – jedes Werkzeug startet nur mit seinem Knopf. */
export function ToolsDialog(): React.ReactElement {
  const page = useUi((s) => s.toolsPage) as ToolPage;
  const setPage = useUi((s) => s.setToolsPage);
  const close = () => useUi.getState().openDialog('none');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal xwide">
        <div className="modal-header">
          <span>🧰 {t.tools.title}</span>
          <button className="btn icon ghost" onClick={close}><IconClose /></button>
        </div>
        <div className="side-layout">
          <nav className="side-nav">
            {GROUPS.map((g) => (
              <div key={g.name}>
                <div className="side-group">{g.name}</div>
                {g.pages.map((p) => <button key={p.id} className={`side-item${page === p.id ? ' active' : ''}`} onClick={() => setPage(p.id)}><span>{p.icon}</span> {p.label}</button>)}
              </div>
            ))}
          </nav>
          <div className="side-content">
            {page === 'reframe' && <ReframeTool />}
            {page === 'hook' && <HookTool />}
            {page === 'cover' && <CoverTool />}
            {page === 'rough' && <RoughCutTool />}
          {page === 'time' && <TimeTool />}
            {page === 'carporn' && <CarpornTool />}
            {page === 'templates' && <TemplatesTool />}
            {page === 'watch' && <WatchFolderSettings />}
            {page === 'storage' && <StorageSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Busy({ pct, msg }: { pct: number; msg?: string }): React.ReactElement {
  return (
    <div>
      <div className="hint">{msg ?? t.tools.working}</div>
      <div className="progress"><div style={{ width: `${Math.round(pct)}%` }} /></div>
    </div>
  );
}

// ---------------------------------------------------------------- Hochformat

let reframeLast: ReframeOptions = { target: '9:16', follow: 'object', model: 'yolox-tiny', prefer: 'auto', smooth: 0.6 };

function ReframeTool(): React.ReactElement {
  const [o, setO] = useState(reframeLast);
  const upd = (p: Partial<ReframeOptions>) => { reframeLast = { ...o, ...p }; setO(reframeLast); };
  const [busy, setBusy] = useState<{ pct: number; msg: string } | null>(null);
  const project = useProject((s) => s.project);
  const toast = useUi((s) => s.toast);
  const size = targetSize(project, o.target);
  const run = async () => {
    stopPlayback();
    setBusy({ pct: 0, msg: t.tools.working });
    try {
      const r = await reframeProject(o, (pct, name) => setBusy({ pct, msg: name ? fmt(t.tools.reframeWorking, { name }) : t.tools.working }));
      toast(fmt(t.tools.reframeDone, { w: size.W, h: size.H, n: r.followed }) + (r.skipped ? ` ${fmt(t.tools.reframeSkipped, { n: r.skipped })}` : ''), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  return (
    <div className="tool-page">
      <h3>📱 {t.tools.reframe}</h3>
      <div className="hint">{t.tools.reframeHint}</div>
      <div className="form-grid compact">
        <label>{t.tools.format}</label>
        <select value={o.target} onChange={(e) => upd({ target: e.target.value as ReframeOptions['target'] })}>
          <option value="9:16">9:16 – TikTok, Reels, Shorts</option>
          <option value="4:5">4:5 – Instagram-Feed</option>
          <option value="1:1">1:1 – Quadrat</option>
          <option value="16:9">16:9 – zurück ins Querformat</option>
        </select>
        <label>{t.tools.framing}</label>
        <select value={o.follow} onChange={(e) => upd({ follow: e.target.value as ReframeOptions['follow'] })}>
          <option value="object">{t.tools.followObject}</option>
          <option value="center">{t.tools.followCenter}</option>
        </select>
        {o.follow === 'object' && <>
          <label>{t.tools.followWhat}</label>
          <select value={o.prefer} onChange={(e) => upd({ prefer: e.target.value as ReframeOptions['prefer'] })}>
            <option value="auto">{t.tools.preferAuto}</option>
            <option value="car">{t.tools.preferCar}</option>
            <option value="person">{t.tools.preferPerson}</option>
          </select>
          <label>{t.tools.detection}</label>
          <select value={o.model} onChange={(e) => upd({ model: e.target.value as AiDetectModel })}>
            <option value="yolox-nano">{t.ai.modelFast}</option><option value="yolox-tiny">{t.ai.modelBetter}</option><option value="yolox-s">{t.ai.modelBest}</option>
          </select>
          <label>{t.tools.calm}</label>
          <input type="range" min={0} max={1} step={0.05} value={o.smooth} onChange={(e) => upd({ smooth: Number(e.target.value) })} />
        </>}
      </div>
      <div className="hint">{fmt(t.tools.reframeResult, { w: size.W, h: size.H })}</div>
      {busy ? <Busy pct={busy.pct} msg={busy.msg} /> : <button className="btn primary" onClick={() => void run()} disabled={projectDuration(project) <= 0}>{t.tools.reframeStart}</button>}
      <div className="hint">{t.tools.undoHint}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Hook-Finder

let hookLast = { length: 3, count: 3, weight: 0.65 };

function HookTool(): React.ReactElement {
  const [o, setO] = useState(hookLast);
  const upd = (p: Partial<typeof o>) => { hookLast = { ...o, ...p }; setO(hookLast); };
  const [busy, setBusy] = useState<number | null>(null);
  const [found, setFound] = useState<HookCandidate[] | null>(null);
  const fps = useProject((s) => s.project.settings.fps);
  const toast = useUi((s) => s.toast);
  const run = async () => {
    stopPlayback();
    setBusy(0);
    try { setFound(await findHooks(o.length, o.count, o.weight, setBusy)); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  return (
    <div className="tool-page">
      <h3>🎣 {t.tools.hook}</h3>
      <div className="hint">{t.tools.hookHint}</div>
      <div className="form-grid compact">
        <label>{t.tools.hookLength}</label>
        <select value={o.length} onChange={(e) => upd({ length: Number(e.target.value) })}>{[1.5, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{String(v).replace('.', ',')} s</option>)}</select>
        <label>{t.tools.hookCount}</label>
        <select value={o.count} onChange={(e) => upd({ count: Number(e.target.value) })}>{[1, 3, 5].map((v) => <option key={v} value={v}>{v}</option>)}</select>
        <label>{t.tools.hookWeight}</label>
        <div className="inline"><span className="hint">{t.tools.sound}</span><input type="range" min={0} max={1} step={0.05} value={o.weight} onChange={(e) => upd({ weight: Number(e.target.value) })} style={{ flex: 1 }} /><span className="hint">{t.tools.motion}</span></div>
      </div>
      {busy !== null ? <Busy pct={busy} /> : <button className="btn primary" onClick={() => void run()}>{t.tools.hookStart}</button>}
      {found && found.length === 0 && <div className="hint warn">{t.tools.hookNone}</div>}
      {found && found.map((h, i) => (
        <div key={i} className="result-row">
          <span className="pill">#{i + 1}</span>
          <span style={{ flex: 1 }}>{formatTime(h.start, fps)} – {formatTime(h.end, fps)} <span className="hint">· {t.tools.motion} {Math.round(h.motion * 100)} % · {t.tools.sound} {Math.round(h.loud * 100)} %</span></span>
          <button className="btn sm" onClick={() => { useUi.getState().setPlayhead(h.start); seekTo(h.start); }}>{t.tools.jump}</button>
          <button className="btn sm primary" onClick={() => { applyHookAsIntro(h); setFound(null); toast(t.tools.hookApplied, 'success'); }}>{t.tools.asIntro}</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Vorschaubild (Cover)

let coverLast = { text: '', template: 'meme', size: 'project' as 'project' | '1080x1920' | '1280x720' };

function CoverTool(): React.ReactElement {
  const [o, setO] = useState(coverLast);
  const upd = (p: Partial<typeof o>) => { coverLast = { ...o, ...p }; setO(coverLast); };
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const project = useProject((s) => s.project);
  const playhead = useUi((s) => s.playhead);
  const toast = useUi((s) => s.toast);
  const run = async () => {
    stopPlayback();
    const name = `${project.name.replace(/[\\/:*?"<>|]+/g, '_')} Cover`;
    const path = await window.panocut.selectExportPath(name, 'jpg');
    if (!path) return;
    setBusy(true); setOut(null);
    try {
      // Kopie des Projekts mit Titel oben drauf – das eigentliche Projekt bleibt unverändert
      const p = structuredClone(project);
      if (o.text.trim()) {
        const top = p.tracks.find((tr) => tr.kind === 'video');
        if (top) {
          const tpl = TITLE_TEMPLATES.find((x) => x.id === o.template) ?? TITLE_TEMPLATES[0];
          const tc = createTitleClip(top.id, Math.max(0, playhead - 0.5), { ...defaultTitle(), ...tpl.style, text: o.text, animation: 'none' }, 1.5);
          p.clips[tc.id] = tc;
        }
      }
      const [W, H] = o.size === 'project' ? [p.settings.width, p.settings.height] : o.size.split('x').map(Number);
      const opts: ExportOptions = { outputPath: path, width: W, height: H, fps: p.settings.fps, format: 'jpg', codec: 'jpeg', quality: 'max', hardware: false, audioBitrate: 128, range: { start: playhead, end: playhead + 0.2 }, name: path.split(/[\\/]/).pop() };
      const id = await window.panocut.startExport(p, opts);
      await new Promise<void>((resolve, reject) => {
        const off = useUi.subscribe((s) => {
          const j = s.exportJobs[id];
          if (j?.phase === 'done') { off(); resolve(); }
          else if (j?.phase === 'error' || j?.phase === 'cancelled') { off(); reject(new Error(j.message ?? 'Fehler')); }
        });
      });
      useUi.getState().removeExportJob(id);
      setOut(path);
      toast(t.tools.coverDone, 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="tool-page">
      <h3>🖼️ {t.tools.cover}</h3>
      <div className="hint">{t.tools.coverHint}</div>
      <div className="form-grid compact">
        <label>{t.tools.coverText}</label>
        <input type="text" value={o.text} placeholder={t.tools.coverTextPh} onChange={(e) => upd({ text: e.target.value })} />
        <label>{t.tools.coverStyle}</label>
        <select value={o.template} onChange={(e) => upd({ template: e.target.value })}>{TITLE_TEMPLATES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <label>{t.tools.coverSize}</label>
        <select value={o.size} onChange={(e) => upd({ size: e.target.value as typeof o.size })}>
          <option value="project">{fmt(t.tools.likeProject, { w: project.settings.width, h: project.settings.height })}</option>
          <option value="1080x1920">1080×1920 (Reels/TikTok)</option>
          <option value="1280x720">1280×720 (YouTube)</option>
        </select>
      </div>
      <div className="hint">{fmt(t.tools.coverAt, { t: formatTime(playhead, project.settings.fps) })}</div>
      {busy ? <Busy pct={50} /> : <button className="btn primary" onClick={() => void run()} disabled={projectDuration(project) <= 0}>{t.tools.coverStart}</button>}
      {out && <div className="result-row"><span style={{ flex: 1, wordBreak: 'break-all' }}>{out}</span><button className="btn sm" onClick={() => void window.panocut.showInFolder(out)}>{t.exportExtra.showFile}</button></div>}
    </div>
  );
}

// ---------------------------------------------------------------- Grobschnitt

let roughLast: RoughOptions = { pauses: true, pauseDb: -38, pauseMin: 0.8, keep: 0.25, blur: false, blurLevel: 0.5, fillers: true };

function RoughCutTool(): React.ReactElement {
  const [o, setO] = useState(roughLast);
  const upd = (p: Partial<RoughOptions>) => { roughLast = { ...o, ...p }; setO(roughLast); };
  const [busy, setBusy] = useState<number | null>(null);
  const [found, setFound] = useState<{ candidates: RoughCandidate[]; noSubtitles: boolean } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const fps = useProject((s) => s.project.settings.fps);
  const toast = useUi((s) => s.toast);
  const run = async () => {
    stopPlayback();
    setBusy(0);
    try {
      const r = await findRoughCuts(o, setBusy);
      setFound(r);
      setChecked(new Set(r.candidates.map((c) => c.id)));
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  const apply = () => {
    if (!found) return;
    const sel = found.candidates.filter((c) => checked.has(c.id));
    const removed = applyRoughCuts(sel);
    setFound(null);
    toast(fmt(t.tools.roughDone, { n: sel.length, s: removed.toFixed(1).replace('.', ',') }), 'success');
  };
  const reasonLabel = (r: RoughCandidate['reason']) => (r === 'pause' ? t.tools.reasonPause : r === 'blur' ? t.tools.reasonBlur : t.tools.reasonFiller);
  return (
    <div className="tool-page">
      <h3>✂️ {t.tools.rough}</h3>
      <div className="hint">{t.tools.roughHint}</div>
      <label className="toggle"><input type="checkbox" checked={o.pauses} onChange={(e) => upd({ pauses: e.target.checked })} /> {t.tools.findPauses}</label>
      {o.pauses && (
        <div className="form-grid compact">
          <label>{t.tools.pauseMin}</label>
          <select value={o.pauseMin} onChange={(e) => upd({ pauseMin: Number(e.target.value) })}>{[0.4, 0.6, 0.8, 1.2, 2].map((v) => <option key={v} value={v}>{String(v).replace('.', ',')} s</option>)}</select>
          <label>{t.tools.pauseLevel}</label>
          <select value={o.pauseDb} onChange={(e) => upd({ pauseDb: Number(e.target.value) })}>
            <option value={-45}>{t.tools.levelQuiet}</option><option value={-38}>{t.tools.levelNormal}</option><option value={-30}>{t.tools.levelNoisy}</option>
          </select>
          <label>{t.tools.keepAir}</label>
          <select value={o.keep} onChange={(e) => upd({ keep: Number(e.target.value) })}>{[0, 0.15, 0.25, 0.4].map((v) => <option key={v} value={v}>{String(v).replace('.', ',')} s</option>)}</select>
        </div>
      )}
      <label className="toggle"><input type="checkbox" checked={o.blur} onChange={(e) => upd({ blur: e.target.checked })} /> {t.tools.findBlur}</label>
      {o.blur && <div className="form-grid compact"><label>{t.tools.blurStrict}</label><input type="range" min={0} max={1} step={0.05} value={o.blurLevel} onChange={(e) => upd({ blurLevel: Number(e.target.value) })} /></div>}
      <label className="toggle"><input type="checkbox" checked={o.fillers} onChange={(e) => upd({ fillers: e.target.checked })} /> {t.tools.findFillers}</label>
      {busy !== null ? <Busy pct={busy} /> : <button className="btn primary" onClick={() => void run()} disabled={!o.pauses && !o.blur && !o.fillers}>{t.tools.roughStart}</button>}
      {found?.noSubtitles && o.fillers && <div className="hint warn">{t.tools.needSubtitles}</div>}
      {found && found.candidates.length === 0 && <div className="hint">{t.tools.roughNone}</div>}
      {found && found.candidates.length > 0 && (
        <>
          <div className="field-row">
            <button className="btn sm ghost" onClick={() => setChecked(new Set(found.candidates.map((c) => c.id)))}>{t.tools.all}</button>
            <button className="btn sm ghost" onClick={() => setChecked(new Set())}>{t.tools.none}</button>
          </div>
          <div className="result-list">
            {found.candidates.map((c) => (
              <label key={c.id} className="result-row">
                <input type="checkbox" checked={checked.has(c.id)} onChange={(e) => { const n = new Set(checked); if (e.target.checked) n.add(c.id); else n.delete(c.id); setChecked(n); }} />
                <span className={`pill reason-${c.reason}`}>{reasonLabel(c.reason)}</span>
                <span style={{ flex: 1 }}>{formatTime(c.start, fps)} · {c.detail}</span>
                <button className="btn sm ghost" onClick={(e) => { e.preventDefault(); useUi.getState().setPlayhead(Math.max(0, c.start - 1)); seekTo(Math.max(0, c.start - 1)); }}>{t.tools.jump}</button>
              </label>
            ))}
          </div>
          <button className="btn primary" onClick={apply} disabled={checked.size === 0}>{fmt(t.tools.roughApply, { n: checked.size })}</button>
          <div className="hint">{t.tools.undoHint}</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Vorlagen

const NO_TEMPLATES: never[] = [];

function TemplatesTool(): React.ReactElement {
  const templates = useUi((s) => s.settings.templates) ?? NO_TEMPLATES;
  const selection = useUi((s) => s.selection);
  const toast = useUi((s) => s.toast);
  const playhead = useUi((s) => s.playhead);
  const [name, setName] = useState('Meine Vorlage');
  const [o, setO] = useState({ look: true, subtitles: true, intro: false, exportPreset: '' });
  const [newName, setNewName] = useState('Neues Video');
  const save = async () => {
    try {
      await saveTemplate({ name, look: o.look, subtitles: o.subtitles, intro: o.intro, exportPreset: o.exportPreset || undefined });
      toast(fmt(t.tools.tplSaved, { name }), 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="tool-page">
      <h3>📋 {t.tools.templates}</h3>
      <div className="hint">{t.tools.tplHint}</div>
      <div className="side-sub">{t.tools.tplSaveTitle}</div>
      <div className="form-grid compact">
        <label>{t.tools.tplName}</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        <label>{t.tools.tplExport}</label>
        <select value={o.exportPreset} onChange={(e) => setO({ ...o, exportPreset: e.target.value })}>
          <option value="">–</option>
          {EXPORT_PRESETS.filter((p) => p.id !== 'custom').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <label className="toggle"><input type="checkbox" checked={o.look} onChange={(e) => setO({ ...o, look: e.target.checked })} /> {t.tools.tplLook}{!selection.length && o.look ? ` (${t.tools.tplNeedClip})` : ''}</label>
      <label className="toggle"><input type="checkbox" checked={o.subtitles} onChange={(e) => setO({ ...o, subtitles: e.target.checked })} /> {t.tools.tplSubs}</label>
      <label className="toggle"><input type="checkbox" checked={o.intro} onChange={(e) => setO({ ...o, intro: e.target.checked })} /> {fmt(t.tools.tplIntro, { s: playhead.toFixed(1).replace('.', ',') })}</label>
      <button className="btn primary" onClick={() => void save()}>{t.tools.tplSave}</button>
      <div className="side-sub">{t.tools.tplList}</div>
      {templates.length === 0 && <div className="hint">{t.tools.tplEmpty}</div>}
      {templates.map((tp) => (
        <div key={tp.id} className="result-row">
          <span style={{ flex: 1 }}><strong>{tp.name}</strong> <span className="hint">· {tp.settings.width}×{tp.settings.height}{tp.intro ? ` · Intro ${tp.intro.duration.toFixed(1).replace('.', ',')} s` : ''}{tp.defaults.color?.look ? ' · Look' : ''}</span></span>
          <button className="btn sm primary" onClick={() => { projectFromTemplate(tp, newName); useUi.getState().openDialog('none'); toast(fmt(t.tools.tplCreated, { name: tp.name }), 'success'); }}>{t.tools.tplUse}</button>
          <button className="btn sm ghost" onClick={() => void deleteTemplate(tp.id)}>×</button>
        </div>
      ))}
      {templates.length > 0 && <div className="form-grid compact"><label>{t.tools.tplNewName}</label><input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------- Ordner & Speicher (auch in den Einstellungen)

export function WatchFolderSettings(): React.ReactElement {
  const settings = useUi((s) => s.settings);
  const setSettings = useUi((s) => s.setSettings);
  const toast = useUi((s) => s.toast);
  const patch = async (p: Partial<typeof settings>) => setSettings(await window.panocut.setSettings(p));
  const choose = async () => {
    const d = await window.panocut.selectFolder(t.tools.watchChoose);
    if (!d) return;
    await patch({ watchFolder: d, watchEnabled: true });
    const r = await window.panocut.setWatchFolder(d);
    if (!r.ok) toast(r.message ?? 'Fehler', 'error');
  };
  const toggle = async (on: boolean) => {
    await patch({ watchEnabled: on });
    const r = await window.panocut.setWatchFolder(on ? settings.watchFolder ?? null : null);
    if (!r.ok) toast(r.message ?? 'Fehler', 'error');
  };
  return (
    <div className="tool-page">
      <h3>👀 {t.tools.watch}</h3>
      <div className="hint">{t.tools.watchHint}</div>
      <div className="result-row"><span style={{ flex: 1, wordBreak: 'break-all' }}>{settings.watchFolder ?? t.tools.watchNone}</span><button className="btn sm" onClick={() => void choose()}>{t.export.choose}</button></div>
      <label className="toggle"><input type="checkbox" checked={!!settings.watchEnabled && !!settings.watchFolder} disabled={!settings.watchFolder} onChange={(e) => void toggle(e.target.checked)} /> {t.tools.watchOn}</label>
    </div>
  );
}

export function StorageSettings(): React.ReactElement {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useUi((s) => s.toast);
  const media = useProject((s) => s.project.media);
  const appInfo = useUi((s) => s.appInfo);
  const load = () => void window.panocut.storageInfo().then(setInfo);
  useEffect(load, []);
  const clean = async (mode: 'old' | 'unused' | 'all') => {
    setBusy(true);
    try {
      const r = await window.panocut.cleanStorage(mode, Object.values(media).map((m) => m.path));
      toast(fmt(t.tools.freed, { size: formatBytes(r.freedBytes) }), 'success');
      load();
    } finally { setBusy(false); }
  };
  return (
    <div className="tool-page">
      <h3>🧹 {t.tools.storage}</h3>
      <div className="hint">{t.tools.storageHint}</div>
      {info ? (
        <dl className="kv">
          <dt>{t.tools.stPreviews}</dt><dd>{formatBytes(info.cacheBytes)} ({info.cacheItems} {t.tools.files})</dd>
          <dt>{t.tools.stOld}</dt><dd>{formatBytes(info.oldBytes)}</dd>
          <dt>{t.tools.stSounds}</dt><dd>{formatBytes(info.soundsBytes)}</dd>
          <dt>{t.tools.stEffects}</dt><dd>{formatBytes(info.effectsBytes)}</dd>
          <dt>{t.tools.stModels}</dt><dd>{formatBytes(info.modelsBytes)}</dd>
        </dl>
      ) : <div className="hint">…</div>}
      <div className="field-row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={() => void clean('old')}>{t.tools.cleanOld}</button>
        <button className="btn" disabled={busy} onClick={() => void clean('unused')}>{t.tools.cleanUnused}</button>
        <button className="btn danger" disabled={busy} onClick={() => void clean('all')}>{t.tools.cleanAll}</button>
        {appInfo && <button className="btn ghost" onClick={() => void window.panocut.showInFolder(appInfo.cacheDir)}>{t.tools.openFolder}</button>}
      </div>
      <div className="hint">{t.tools.cleanHint}</div>
    </div>
  );
}

/** Hinweis „Neue Dateien im beobachteten Ordner“ – importiert wird erst auf Knopfdruck. */
export function WatchBanner(): React.ReactElement | null {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => window.panocut.onWatchNew((f) => setFiles((prev) => [...new Set([...prev, ...f])])), []);
  if (!files.length) return null;
  return (
    <div className="watch-banner">
      <span>👀 {fmt(t.tools.watchFound, { n: files.length })}</span>
      <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{files.map((f) => f.split(/[\\/]/).pop()).join(', ')}</span>
      <button className="btn sm primary" onClick={() => { void importFiles(files); setFiles([]); }}>{t.tools.watchImport}</button>
      <button className="btn sm ghost" onClick={() => setFiles([])}>{t.tools.watchIgnore}</button>
    </div>
  );
}

// ---------------------------------------------------------------- Zeit & Tempo

function CarpornTool(): React.ReactElement {
  const toast = useUi((s) => s.toast);
  const letterbox = useProject((s) => s.project.settings.letterbox ?? 0);
  const [ramp, setRamp] = useState<SpeedRamp>('passby');
  const [strength, setStrength] = useState(1);
  const [text, setText] = useState('PANOCUT');
  const [busy, setBusy] = useState(false);
  const run = (fn: () => number, msg: string) => { const n = fn(); if (n > 0) toast(fmt(msg, { n }), 'success'); };
  return (
    <div className="tool-page">
      <h3>🏎 {t.carporn.title}</h3>
      <div className="hint">{t.carporn.hint}</div>

      <div className="panel-header" style={{ border: 'none' }}>🎬 {t.carporn.reelTitle}</div>
      <div className="hint">{t.carporn.reelHint}</div>
      <button className="btn primary" disabled={busy} onClick={() => { setBusy(true); void carReel().finally(() => setBusy(false)); }}>{busy ? '…' : t.carporn.reel}</button>

      <div className="panel-header" style={{ border: 'none', marginTop: 12 }}>⏩ {t.carporn.rampTitle}</div>
      <div className="form-grid compact">
        <label>{t.carporn.ramp}</label>
        <select value={ramp} onChange={(e) => setRamp(e.target.value as SpeedRamp)}>{SPEED_RAMPS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <label>{t.carporn.strength}</label>
        <div className="inline"><input type="range" min={0.3} max={2} step={0.05} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} /><span>{Math.round(strength * 100)} %</span></div>
      </div>
      <div className="field-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="btn" onClick={() => run(() => rampOnAccents(ramp, strength), t.carporn.rampDone)}>⏩ {t.carporn.rampRun}</button>
        <button className="btn" onClick={() => run(() => shakesOnAccents(strength), t.carporn.shakeDone)}>💥 {t.carporn.shakeRun}</button>
        <button className="btn" onClick={() => run(() => whipBetween(), t.carporn.whipDone)}>↔️ {t.carporn.whipRun}</button>
      </div>
      <div className="hint">{t.carporn.rampHint}</div>

      <div className="panel-header" style={{ border: 'none', marginTop: 12 }}>💨 {t.carporn.lookTitle}</div>
      <div className="field-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="btn" onClick={() => run(() => rigLook(strength), t.carporn.rigDone)}>🚗 {t.carporn.rig}</button>
        <button className="btn" onClick={() => run(() => applyLook('carshow', null), t.carporn.lookDone)}>✨ {t.carporn.lookShowroom}</button>
        <button className="btn" onClick={() => run(() => applyLook('teal', null), t.carporn.lookDone)}>🎞 {t.carporn.lookTeal}</button>
        <button className="btn" onClick={() => run(() => applyLook('night', null), t.carporn.lookDone)}>🌃 {t.carporn.lookNight}</button>
      </div>
      <div className="form-grid compact">
        <label>{t.carporn.letterbox}</label>
        <select value={String(letterbox)} onChange={(e) => { useProject.getState().updateSettings({ letterbox: parseFloat(e.target.value) }); }}>
          <option value="0">{t.carporn.lbOff}</option>
          <option value="2">2:1</option>
          <option value="2.39">2,39:1 ({t.carporn.lbCinema})</option>
          <option value="2.76">2,76:1 ({t.carporn.lbUltra})</option>
        </select>
      </div>
      <div className="hint">{t.carporn.rigHint}</div>

      <div className="panel-header" style={{ border: 'none', marginTop: 12 }}>✂️ {t.carporn.cutoutTitle}</div>
      <div className="hint">{t.carporn.cutoutHint}</div>
      <div className="form-grid compact">
        <label>{t.carporn.text}</label>
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <button className="btn" onClick={() => { if (textBehindCar(text)) toast(t.carporn.textDone, 'success'); }}>🔤 {t.carporn.textBehind}</button>
    </div>
  );
}

function TimeTool(): React.ReactElement {
  const selection = useUi((s) => s.selection);
  const project = useProject((s) => s.project);
  const toast = useUi((s) => s.toast);
  const clips = selection.map((id) => project.clips[id]).filter((c) => c && c.kind !== 'title' && project.media[c.mediaId]?.type === 'video');
  const first = clips[0];
  const media = first ? project.media[first.mediaId] : undefined;
  const est = media ? estimateTimelapse(media.info) : null;
  const [factor, setFactor] = useState<number | null>(null);
  const f = factor ?? est?.factor ?? 1;
  const [refIdx, setRefIdx] = useState(0);
  const [auto, setAuto] = useState(true);
  const [refine, setRefine] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => { setFactor(null); }, [first?.id]);
  useEffect(() => { if (media && !media.info.recordedAt) void ensureTimes(media); }, [media?.id]);

  const transfer = () => {
    if (!first || clips.length < 2) { toast(t.time.needMore, 'info'); return; }
    // gleiche reale Geschwindigkeit wie der erste Clip: Tempo = (Tempo₁ · Faktor₁) / Faktor des anderen
    const rate = first.speed * f;
    beginTransaction();
    for (const c of clips.slice(1)) {
      const fo = estimateTimelapse(project.media[c.mediaId].info).factor;
      useProject.getState().setSpeed([c.id], Math.max(0.05, Math.min(100, rate / fo)));
    }
    endTransaction();
    toast(fmt(t.time.transferred, { n: clips.length - 1, f: describeFactor(rate) }), 'success');
  };

  const sync = async () => {
    if (clips.length !== 2) { toast(t.time.needTwo, 'info'); return; }
    const ref = clips[refIdx], other = clips[1 - refIdx];
    const mr = project.media[ref.mediaId], mo = project.media[other.mediaId];
    setBusy(0);
    try {
      const fr = refIdx === 0 ? f : estimateTimelapse(mr.info).factor;
      const r = await syncAngles(ref, mr, other, mo, { factorRef: fr, factorOther: auto ? 'auto' : estimateTimelapse(mo.info).factor, refine }, setBusy);
      const cur = useProject.getState().project.clips[other.id];
      const out = r.in + (cur.out - cur.in);
      const srcLen = mo.info.duration;
      const moved = { ...cur, start: r.start, in: Math.min(r.in, srcLen - 0.1), out: Math.min(srcLen, out), speed: r.speed };
      beginTransaction();
      // erst Tempo/Ausschnitt, dann an die richtige Stelle – auf eine eigene Spur, falls dort etwas im Weg liegt
      useProject.getState().updateClip(cur.id, { in: moved.in, out: moved.out, speed: moved.speed, start: -1e6 });
      const ok = useProject.getState().placeClips([{ id: cur.id, start: moved.start, trackId: cur.trackId }]).length > 0;
      if (!ok) {
        const tid = useProject.getState().addVideoTrackAbove(ref.trackId, t.time.trackName);
        useProject.getState().placeClips([{ id: cur.id, start: moved.start, trackId: tid }]);
      }
      endTransaction();
      toast(fmt(r.score > 0.45 ? t.time.synced : t.time.syncedWeak, { f: describeFactor(r.factorOther), o: r.offsetSec.toFixed(1).replace('.', ',') }), r.score > 0.45 ? 'success' : 'info');
    } catch (e) { toast((e as Error).message, 'error'); }
    setBusy(null);
  };

  const when = (ms?: number) => (ms ? new Date(ms).toLocaleString('de-DE') : '–');
  return (
    <div className="tool-page">
      <h3>⏱ {t.time.title}</h3>
      <div className="hint">{t.time.hint}</div>
      {!first || !media ? <div className="hint warn">{t.time.select}</div> : (
        <>
          <div className="panel-header" style={{ border: 'none' }}>🐇 {t.time.tlTitle}</div>
          <div className="form-grid compact">
            <label>{t.time.clip}</label><span>{media.name}</span>
            <label>{t.time.start}</label><span>{when(media.info.recordedAt)}</span>
            <label>{t.time.real}</label><span>{est?.realSeconds ? formatTime(est.realSeconds, 1, false) : '–'}</span>
            <label>{t.time.factor}</label>
            <div className="inline"><NumInput value={f} min={1} max={1000} step={0.1} onChange={setFactor} className="speed-num" /><span>×</span>
              <span className="hint">{est && est.factor > 1 ? fmt(t.time.detected, { f: describeFactor(est.factor) }) : t.time.normal}</span></div>
          </div>
          <button className="btn" disabled={clips.length < 2} onClick={transfer}>➡️ {t.time.transfer}</button>
          <div className="hint">{t.time.transferHint}</div>

          <div className="panel-header" style={{ border: 'none', marginTop: 12 }}>🎥 {t.time.syncTitle}</div>
          <div className="hint">{t.time.syncHint}</div>
          {clips.length === 2 && (
            <div className="form-grid compact">
              <label>{t.time.reference}</label>
              <select value={refIdx} onChange={(e) => setRefIdx(Number(e.target.value))}>
                {clips.map((c, i) => <option key={c.id} value={i}>{c.name}</option>)}
              </select>
              <label />
              <label className="toggle"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t.time.autoFactor}</label>
              <label />
              <label className="toggle"><input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} /> {t.time.refine}</label>
            </div>
          )}
          {busy !== null ? <Busy pct={busy} /> : <button className="btn primary" disabled={clips.length !== 2} onClick={() => void sync()}>🎯 {t.time.syncStart}</button>}
        </>
      )}
    </div>
  );
}
