import React, { useState } from 'react';
import { PROJECT_PRESETS } from '@shared/presets';
import { useUi } from '../store/ui';
import { createNewProject } from '../actions';
import { t } from '../i18n/de';
import { IconClose } from './Icons';

export function NewProjectDialog(): React.ReactElement {
  const close = () => useUi.getState().openDialog('none');
  const [name, setName] = useState('Mein Video');
  const [presetId, setPresetId] = useState('hd');
  const [fps, setFps] = useState(30);
  const preset = PROJECT_PRESETS.find((p) => p.id === presetId) ?? PROJECT_PRESETS[0];

  const create = () => {
    createNewProject(name.trim() || 'Unbenanntes Projekt', preset.width, preset.height, fps, preset.id === 'pano');
    close();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal">
        <div className="modal-header">
          <span>{t.newProject.title}</span>
          <button className="btn icon ghost" onClick={close}><IconClose /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label>{t.newProject.name}</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
            <label>{t.newProject.size}</label>
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {PROJECT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label>{t.newProject.fps}</label>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="hint">{t.newProject.hint}</div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={close}>{t.newProject.cancel}</button>
          <button className="btn primary" onClick={create}>{t.newProject.create}</button>
        </div>
      </div>
    </div>
  );
}
