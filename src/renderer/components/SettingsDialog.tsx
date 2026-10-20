import React, { useState } from 'react';
import type { CloudSettings } from '@shared/types';
import { PROJECT_PRESETS } from '@shared/presets';
import { useProject } from '../store/project';
import { useUi, useView, updateView } from '../store/ui';
import { StorageSettings, WatchFolderSettings } from './ToolsDialog';
import { t } from '../i18n/de';
import { IconClose } from './Icons';

export function SettingsDialog(): React.ReactElement {
  const close = () => useUi.getState().openDialog('none');
  const settings = useUi((s) => s.settings);
  const setSettings = useUi((s) => s.setSettings);
  const appInfo = useUi((s) => s.appInfo);
  const project = useProject((s) => s.project.settings);
  const updateSettings = useProject((s) => s.updateSettings);
  const updateStatus = useUi((s) => s.updateStatus);
  const [cloud, setCloud] = useState<CloudSettings>(settings.cloud ?? { type: 'webdav', url: '', username: '', password: '' });
  const [cloudMsg, setCloudMsg] = useState<string | null>(null);
  const saveCloud = (c: CloudSettings) => { setCloud(c); void patch({ cloud: c }); };
  const testCloud = async () => {
    setCloudMsg('…');
    const r = await window.panocut.cloudTest(cloud);
    setCloudMsg(r.ok ? (r.message ?? t.cloud.ok) : (r.message ?? 'Fehler'));
  };

  const patch = async (p: Partial<typeof settings>) => {
    const next = await window.panocut.setSettings(p);
    setSettings(next);
  };

  const presetId = PROJECT_PRESETS.find((p) => p.width === project.width && p.height === project.height)?.id ?? 'custom';

  const page = useUi((s) => s.settingsPage);
  const setPage = useUi((s) => s.setSettingsPage);
  const view = useView();
  const pages: Array<{ id: string; icon: string; label: string; group: string }> = [
    { id: 'project', icon: '🎬', label: t.settings.pageProject, group: t.settings.groupWork },
    { id: 'import', icon: '📥', label: t.settings.pageImport, group: t.settings.groupWork },
    { id: 'view', icon: '🖥️', label: t.settings.pageView, group: t.settings.groupWork },
    { id: 'ai', icon: '✦', label: t.settings.pageAi, group: t.settings.groupWork },
    { id: 'watch', icon: '👀', label: t.tools.watch, group: t.settings.groupFiles },
    { id: 'storage', icon: '🧹', label: t.tools.storage, group: t.settings.groupFiles },
    { id: 'cloud', icon: '☁︎', label: t.cloud.section, group: t.settings.groupConnect },
    { id: 'remote', icon: '🎛️', label: t.remote.section, group: t.settings.groupConnect },
    { id: 'about', icon: 'ℹ️', label: t.settings.pageAbout, group: t.settings.groupApp },
  ];
  const groups = [...new Set(pages.map((p) => p.group))];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal xwide">
        <div className="modal-header">
          <span>{t.settings.title}</span>
          <button className="btn icon ghost" onClick={close}><IconClose /></button>
        </div>
        <div className="side-layout">
          <nav className="side-nav">
            {groups.map((g) => (
              <div key={g}>
                <div className="side-group">{g}</div>
                {pages.filter((p) => p.group === g).map((p) => <button key={p.id} className={`side-item${page === p.id ? ' active' : ''}`} onClick={() => setPage(p.id)}><span>{p.icon}</span> {p.label}</button>)}
              </div>
            ))}
          </nav>
          <div className="side-content">
            {page === 'project' && <div className="tool-page">
          <h3>{t.settings.project}</h3>
          <div className="form-grid">
            <label>{t.settings.projectSize}</label>
            <select value={presetId} onChange={(e) => { const p = PROJECT_PRESETS.find((x) => x.id === e.target.value); if (p) updateSettings({ width: p.width, height: p.height, is360: p.id === 'pano' }); }}>
              {PROJECT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              {presetId === 'custom' && <option value="custom">{project.width}×{project.height}</option>}
            </select>
            <label>{t.settings.projectFps}</label>
            <select value={project.fps} onChange={(e) => updateSettings({ fps: Number(e.target.value) })}>
              {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <label>{t.settings.background}</label>
            <input type="color" value={project.background} onChange={(e) => updateSettings({ background: e.target.value })} />
          </div>

            </div>}
            {page === 'import' && <div className="tool-page">
          <h3>{t.settings.pageImport}</h3>
          <div className="form-grid">
            <label>{t.settings.proxyHeight}</label>
            <select value={settings.proxyHeight} onChange={(e) => void patch({ proxyHeight: Number(e.target.value) })}>
              <option value={360}>Klein (360p)</option>
              <option value={540}>Normal (540p)</option>
              <option value={720}>Hoch (720p)</option>
              <option value={1080}>Sehr hoch (1080p)</option>
            </select>
            <label />
            <div className="hint">{t.settings.proxyHint}</div>
            <label>{t.settings.proxyMode}</label>
            <select value={settings.proxyMode ?? 'auto'} onChange={(e) => void patch({ proxyMode: e.target.value as 'auto' | 'always' })}>
              <option value="auto">{t.settings.proxyAuto}</option>
              <option value="always">{t.settings.proxyAlways}</option>
            </select>
            <label />
            <label className="toggle"><input type="checkbox" checked={settings.hardwareAccel} onChange={(e) => void patch({ hardwareAccel: e.target.checked })} /> {t.settings.hardware}</label>
            <label />
            <label className="toggle"><input type="checkbox" checked={settings.autosave} onChange={(e) => void patch({ autosave: e.target.checked })} /> {t.settings.autosave}</label>
          </div>
            </div>}
            {page === 'view' && <div className="tool-page">
              <h3>{t.settings.pageView}</h3>
              <div className="form-grid">
                <label>{t.view.quality}</label>
                <select value={view.previewQuality} onChange={(e) => updateView({ previewQuality: e.target.value as 'auto' })}>
                  <option value="auto">{t.view.qualityAuto}</option><option value="full">{t.view.qualityFull}</option><option value="half">{t.view.qualityHalf}</option><option value="quarter">{t.view.qualityQuarter}</option>
                </select>
                <label>{t.view.guides}</label>
                <select value={view.previewGuides} onChange={(e) => updateView({ previewGuides: e.target.value as 'none' })}>
                  <option value="none">{t.view.guidesNone}</option><option value="thirds">{t.view.guidesThirds}</option><option value="safe">{t.view.guidesSafe}</option><option value="both">{t.view.guidesBoth}</option>
                </select>
                <label>{t.view.frame}</label>
                <select value={view.selectionFrame} onChange={(e) => updateView({ selectionFrame: e.target.value as 'hover' })}>
                  <option value="always">{t.view.frameAlways}</option><option value="hover">{t.view.frameHover}</option><option value="never">{t.view.frameNever}</option>
                </select>
                <label>{t.view.trackSize}</label>
                <select value={view.trackSize} onChange={(e) => updateView({ trackSize: e.target.value as 'medium' })}>
                  <option value="small">{t.view.small}</option><option value="medium">{t.view.medium}</option><option value="large">{t.view.large}</option>
                </select>
                <label />
                <label className="toggle"><input type="checkbox" checked={view.thumbnails} onChange={(e) => updateView({ thumbnails: e.target.checked })} /> {t.view.thumbnails}</label>
                <label />
                <label className="toggle"><input type="checkbox" checked={view.waveforms} onChange={(e) => updateView({ waveforms: e.target.checked })} /> {t.view.waveforms}</label>
                <label />
                <label className="toggle"><input type="checkbox" checked={view.followPlayhead} onChange={(e) => updateView({ followPlayhead: e.target.checked })} /> {t.view.follow}</label>
                <label />
                <button className="btn sm" onClick={() => updateView({ leftWidth: 300, rightWidth: 300, timelineHeight: 300 })}>{t.view.resetLayout}</button>
              </div>
            </div>}
            {page === 'ai' && <div className="tool-page">
              <h3>{t.settings.pageAi}</h3>
              <div className="hint">{t.settings.aiHint}</div>
              <div className="form-grid">
                <label>{t.ai.detectModel}</label>
                <select value={settings.aiDetectModel ?? 'yolox-nano'} onChange={(e) => void patch({ aiDetectModel: e.target.value as 'yolox-nano' })}>
                  <option value="yolox-nano">{t.ai.modelFast}</option><option value="yolox-tiny">{t.ai.modelBetter}</option><option value="yolox-s">{t.ai.modelBest}</option>
                </select>
                <label>{t.ai.segmentModel}</label>
                <select value={settings.aiSegmentModel ?? 'u2netp'} onChange={(e) => void patch({ aiSegmentModel: e.target.value as 'u2netp' })}>
                  <option value="u2netp">{t.ai.segFast}</option><option value="u2net-human">{t.ai.segHuman}</option><option value="isnet">{t.ai.segBest}</option>
                </select>
              </div>
            </div>}
            {page === 'watch' && <WatchFolderSettings />}
            {page === 'storage' && <StorageSettings />}
            {page === 'cloud' && <div className="tool-page">
          <h3>{t.cloud.section}</h3>
          <div className="form-grid">
            <label>{t.cloud.url}</label>
            <input type="text" value={cloud.url} placeholder="https://…" onChange={(e) => saveCloud({ ...cloud, url: e.target.value })} spellCheck={false} />
            <label />
            <div className="hint">{t.cloud.urlHint}</div>
            <label>{t.cloud.user}</label>
            <input type="text" value={cloud.username} onChange={(e) => saveCloud({ ...cloud, username: e.target.value })} spellCheck={false} />
            <label>{t.cloud.password}</label>
            <input type="password" value={cloud.password} onChange={(e) => saveCloud({ ...cloud, password: e.target.value })} />
            <label />
            <div className="inline">
              <button className="btn sm" onClick={() => void testCloud()} disabled={!cloud.url}>{t.cloud.test}</button>
              {cloudMsg && <span className="hint">{cloudMsg}</span>}
            </div>
          </div>
            </div>}
            {page === 'remote' && <div className="tool-page">
          <h3>{t.remote.section}</h3>
          <div className="form-grid">
            <label />
            <label className="toggle"><input type="checkbox" checked={settings.remoteControl !== false} onChange={(e) => void patch({ remoteControl: e.target.checked })} /> {t.remote.enable}</label>
            {settings.remoteControl !== false && (
              <>
                <label>{t.remote.test}</label>
                <span className="hint" style={{ fontFamily: 'var(--mono)' }}>http://127.0.0.1:{settings.remotePort ?? 51888}/action/…</span>
              </>
            )}
            <label />
            <div className="hint">{t.remote.hint}</div>
            <label />
            <div className="hint">{t.remote.hotkeyHint}</div>
          </div>
        
            </div>}
            {page === 'about' && <div className="tool-page">
              <h3>{t.settings.pageAbout}</h3>
              <div className="form-grid">
            <label>{t.settings.cacheDir}</label>
            <div className="inline">
              <span className="hint" style={{ flex: 1, wordBreak: 'break-all' }}>{appInfo?.cacheDir}</span>
              {appInfo && <button className="btn sm" onClick={() => void window.panocut.showInFolder(appInfo.cacheDir)}>Öffnen</button>}
            </div>
            <label>{t.settings.version}</label>
            <div className="inline">
              <span>PanoCut {appInfo?.version ?? ''} · {appInfo?.platform === 'darwin' ? 'macOS' : appInfo?.platform === 'win32' ? 'Windows' : appInfo?.platform} {appInfo?.arch}</span>
              <button className="btn sm" onClick={() => void window.panocut.checkForUpdates()} disabled={updateStatus.state === 'checking'}>{t.settings.checkUpdates}</button>
            </div>
            <label />
            <div className="hint">
              {updateStatus.state === 'checking' && t.update.checking}
              {updateStatus.state === 'not-available' && t.update.notAvailable}
              {updateStatus.state === 'available' && `Version ${updateStatus.version} ist verfügbar – siehe Hinweis oben im Fenster.`}
              {updateStatus.state === 'error' && `Fehler: ${updateStatus.message}`}
            </div>
          </div>

              <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => void window.panocut.uninstall()}>{t.settings.uninstall}</button>
            </div>}
          </div>
        </div>
        <div className="modal-footer">
          <div className="spacer" />
          <button className="btn primary" onClick={close}>{t.settings.close}</button>
        </div>
      </div>
    </div>
  );
}
