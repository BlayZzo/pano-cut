import React from 'react';
import { PROJECT_PRESETS } from '@shared/presets';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
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

  const patch = async (p: Partial<typeof settings>) => {
    const next = await window.panocut.setSettings(p);
    setSettings(next);
  };

  const presetId = PROJECT_PRESETS.find((p) => p.width === project.width && p.height === project.height)?.id ?? 'custom';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal">
        <div className="modal-header">
          <span>{t.settings.title}</span>
          <button className="btn icon ghost" onClick={close}><IconClose /></button>
        </div>
        <div className="modal-body">
          <div className="panel-header" style={{ padding: '0 0 6px', border: 'none' }}>{t.settings.project}</div>
          <div className="form-grid">
            <label>{t.settings.projectSize}</label>
            <select value={presetId} onChange={(e) => { const p = PROJECT_PRESETS.find((x) => x.id === e.target.value); if (p) updateSettings({ width: p.width, height: p.height }); }}>
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

          <div className="panel-header" style={{ padding: '8px 0 6px', border: 'none' }}>{t.settings.app}</div>
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
            <label />
            <label className="toggle"><input type="checkbox" checked={settings.hardwareAccel} onChange={(e) => void patch({ hardwareAccel: e.target.checked })} /> {t.settings.hardware}</label>
            <label />
            <label className="toggle"><input type="checkbox" checked={settings.autosave} onChange={(e) => void patch({ autosave: e.target.checked })} /> {t.settings.autosave}</label>
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
        </div>
        <div className="modal-footer">
          <button className="btn danger" onClick={() => void window.panocut.uninstall()}>{t.settings.uninstall}</button>
          <div className="spacer" />
          <button className="btn primary" onClick={close}>{t.settings.close}</button>
        </div>
      </div>
    </div>
  );
}
