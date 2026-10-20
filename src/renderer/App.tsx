import React, { useEffect, useRef } from 'react';
import { TopBar } from './components/TopBar';
import { MediaLibrary } from './components/MediaLibrary';
import { Preview } from './components/Preview';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { ExportDialog } from './components/ExportDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { NewProjectDialog } from './components/NewProjectDialog';
import { ShortcutsDialog, AboutDialog } from './components/InfoDialogs';
import { Toasts } from './components/Toasts';
import { UpdateBanner } from './components/UpdateBanner';
import { useUi, useView } from './store/ui';
import { Splitter } from './components/Splitter';
import { ToolsDialog, WatchBanner } from './components/ToolsDialog';
import { onDirtyChange, untracked, useProject, isDirty } from './store/project';
import { useKeyboard } from './hooks/useKeyboard';
import {
  deleteSelection, doRedo, doUndo, duplicateSelection, goEnd, goStart, importDialog, importFolderDialog, loadProjectPath, newProjectFlow,
  openProject, saveProject, selectAll, splitAtPlayhead, zoomBy, setRangeIn, setRangeOut, clearRange, stepFrames,
  toggleLoop, toggleAiPanel, autoEnhanceClips,
} from './actions';
import { playPause } from './engine/instance';
import { switchToAngle } from './multicamActions';
import { isEditingText } from './utils/dom';

export function App(): React.ReactElement {
  const dialog = useUi((s) => s.dialog);
  const view = useView();
  const appInfo = useUi((s) => s.appInfo);
  const zoomFitRef = useRef<() => void>(() => {});

  useKeyboard();

  useEffect(() => {
    const api = window.panocut;
    void api.getAppInfo().then((info) => useUi.getState().setAppInfo(info));
    void api.getSettings().then((s) => useUi.getState().setSettings(s));

    const offMedia = api.onMediaUpdate((item) => {
      untracked(() => useProject.getState().updateMedia(item));
    });
    const offExport = api.onExportProgress((p) => useUi.getState().setExportProgress(p));
    const offPrep = api.onPrepQueue((q) => useUi.getState().setPrepQueue(q));
    const offUpdate = api.onUpdateStatus((s) => useUi.getState().setUpdateStatus(s));
    const offDirty = onDirtyChange((d) => useUi.getState().setDirty(d));

    const offMenu = api.onMenuAction((raw) => {
      const [action, arg] = raw.includes(':') ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)] : [raw, undefined];
      const inInput = isEditingText();
      switch (action) {
        case 'newProject': void newProjectFlow(); break;
        case 'openProject': void openProject(); break;
        case 'openRecent': if (arg) void loadProjectPath(arg); break;
        case 'save': void saveProject(false); break;
        case 'saveAs': void saveProject(true); break;
        case 'saveAndQuit': void saveProject(false).then((ok) => { if (ok) window.panocut.quitApp(); }); break;
        case 'import': void importDialog(); break;
        case 'importFolder': void importFolderDialog(); break;
        case 'export': useUi.getState().openDialog('export'); break;
        case 'settings': useUi.getState().openDialog('settings'); break;
        case 'shortcuts': useUi.getState().openDialog('shortcuts'); break;
        case 'about': useUi.getState().openDialog('about'); break;
        case 'checkUpdates': void api.checkForUpdates(); break;
        case 'uninstall': void api.uninstall(); break;
        case 'undo': if (inInput) document.execCommand('undo'); else doUndo(); break;
        case 'redo': if (inInput) document.execCommand('redo'); else doRedo(); break;
        case 'selectAll': if (!inInput) selectAll(); break;
        case 'split': splitAtPlayhead(); break;
        case 'duplicate': duplicateSelection(); break;
        case 'delete': if (!inInput) deleteSelection(); break;
        case 'playPause': playPause(); break;
        case 'goStart': goStart(); break;
        case 'goEnd': goEnd(); break;
        case 'zoomIn': zoomBy(1.3); break;
        case 'zoomOut': zoomBy(1 / 1.3); break;
        case 'zoomFit': zoomFitRef.current(); break;
        case 'markIn': setRangeIn(); break;
        case 'markOut': setRangeOut(); break;
        case 'clearRange': clearRange(); break;
        case 'prevFrame': stepFrames(-1); break;
        case 'nextFrame': stepFrames(1); break;
        case 'toggleLoop': toggleLoop(); break;
        case 'ai': toggleAiPanel(); break;
        case 'autoEnhance': void autoEnhanceClips(); break;
        case 'cam': if (arg) switchToAngle(Number(arg) - 1); break;
      }
    });
    return () => { offMedia(); offExport(); offPrep(); offUpdate(); offDirty(); offMenu(); };
  }, []);

  // Automatisch speichern (alle 60 s, wenn ein Pfad existiert und etwas geändert wurde)
  useEffect(() => {
    const id = setInterval(() => {
      const { settings } = useUi.getState();
      const { path } = useProject.getState();
      if (settings.autosave && path && isDirty()) void saveProject(false);
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const isMac = appInfo?.platform === 'darwin';

  return (
    <div className="app" style={{ '--left-w': `${view.leftWidth}px`, '--right-w': `${view.rightWidth}px`, '--timeline-h': `${view.timelineHeight}px` } as React.CSSProperties}>
      <TopBar mac={isMac} />
      <div className={`upper${view.leftWidth === 0 ? ' no-left' : ''}${view.rightWidth === 0 ? ' no-right' : ''}`}>
        <MediaLibrary />
        <Splitter which="leftWidth" />
        <Preview />
        <Splitter which="rightWidth" />
        <Inspector />
      </div>
      <Splitter which="timelineHeight" />
      <Timeline zoomFitRef={zoomFitRef} />
      <UpdateBanner />
      <Toasts />
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'newProject' && <NewProjectDialog />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      {dialog === 'about' && <AboutDialog />}
      {dialog === 'tools' && <ToolsDialog />}
      <WatchBanner />
    </div>
  );
}
