import React from 'react';
import { useUi } from '../store/ui';
import { t } from '../i18n/de';
import { IconClose } from './Icons';
import logo from '../assets/logo-256.png';

export function ShortcutsDialog(): React.ReactElement {
  const close = () => useUi.getState().openDialog('none');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal">
        <div className="modal-header">
          <span>{t.shortcuts.title}</span>
          <button className="btn icon ghost" onClick={close}><IconClose /></button>
        </div>
        <div className="modal-body">
          <div className="shortcut-table">
            {t.shortcuts.items.map(([k, d]) => (
              <React.Fragment key={k}><kbd>{k}</kbd><span>{d}</span></React.Fragment>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn primary" onClick={close}>{t.shortcuts.close}</button>
        </div>
      </div>
    </div>
  );
}

export function AboutDialog(): React.ReactElement {
  const close = () => useUi.getState().openDialog('none');
  const info = useUi((s) => s.appInfo);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ width: 380 }}>
        <div className="modal-body about">
          <img src={logo} alt="PanoCut" />
          <div style={{ fontSize: 20, fontWeight: 800 }}>PanoCut</div>
          <div className="ver">Version {info?.version ?? ''}</div>
          <p>Videoschnitt für 360°-, Kamera- und Drohnenvideos – alles in einem Programm.</p>
          <p className="hint">Basiert auf Electron und FFmpeg. © 2026 BlayZzo · MIT-Lizenz</p>
          <button className="btn" onClick={() => void window.panocut.openExternal('https://github.com/BlayZzo/pano-cut')}>GitHub</button>
        </div>
        <div className="modal-footer">
          <button className="btn primary" onClick={close}>{t.common.ok}</button>
        </div>
      </div>
    </div>
  );
}
