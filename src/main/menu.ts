import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '@shared/ipc';

export function buildMenu(win: () => BrowserWindow | null, recent: () => string[], onAction: (action: string, arg?: string) => void): void {
  const send = (action: string, arg?: string) => () => {
    onAction(action, arg);
    win()?.webContents.send(IPC.menuAction, arg ? `${action}:${arg}` : action);
  };
  const isMac = process.platform === 'darwin';

  const recentItems: MenuItemConstructorOptions[] = recent().length
    ? recent().map((p) => ({ label: p.split(/[\\/]/).pop() ?? p, click: send('openRecent', p) }))
    : [{ label: 'Keine Einträge', enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'PanoCut',
      submenu: [
        { label: 'Über PanoCut', click: send('about') },
        { label: 'Nach Updates suchen …', click: send('checkUpdates') },
        { type: 'separator' as const },
        { label: 'Einstellungen …', accelerator: 'Cmd+,', click: send('settings') },
        { type: 'separator' as const },
        { label: 'PanoCut deinstallieren …', click: send('uninstall') },
        { type: 'separator' as const },
        { role: 'hide' as const, label: 'PanoCut ausblenden' },
        { role: 'hideOthers' as const, label: 'Andere ausblenden' },
        { role: 'unhide' as const, label: 'Alle einblenden' },
        { type: 'separator' as const },
        { role: 'quit' as const, label: 'PanoCut beenden' },
      ],
    }] : []),
    {
      label: 'Datei',
      submenu: [
        { label: 'Neues Projekt …', accelerator: 'CmdOrCtrl+N', click: send('newProject') },
        { label: 'Projekt öffnen …', accelerator: 'CmdOrCtrl+O', click: send('openProject') },
        { label: 'Zuletzt verwendet', submenu: recentItems },
        { type: 'separator' },
        { label: 'Speichern', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Speichern unter …', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: 'Medien importieren …', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { label: 'Ordner importieren …', accelerator: 'CmdOrCtrl+Shift+I', click: send('importFolder') },
        { label: 'Exportieren …', accelerator: 'CmdOrCtrl+E', click: send('export') },
        ...(isMac ? [] : [
          { type: 'separator' as const },
          { label: 'Einstellungen …', accelerator: 'Ctrl+,', click: send('settings') },
          { type: 'separator' as const },
          { role: 'quit' as const, label: 'Beenden' },
        ]),
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { label: 'Rückgängig', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Wiederholen', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: send('redo') },
        { type: 'separator' },
        { label: 'Ausschneiden', role: 'cut' },
        { label: 'Kopieren', role: 'copy' },
        { label: 'Einfügen', role: 'paste' },
        { label: 'Alles auswählen', accelerator: 'CmdOrCtrl+A', click: send('selectAll') },
        { type: 'separator' },
        { label: 'Clip an Abspielposition schneiden (auch Taste S)', accelerator: 'CmdOrCtrl+B', click: send('split') },
        { label: 'Clip duplizieren', accelerator: 'CmdOrCtrl+D', click: send('duplicate') },
        { label: 'Clip löschen\t(Entf)', click: send('delete') },
        { type: 'separator' },
        { label: 'Bild automatisch verbessern (natürlich schön)', accelerator: 'CmdOrCtrl+Shift+E', click: send('autoEnhance') },
        { label: 'KI-Info (Objekte erkennen)', accelerator: 'CmdOrCtrl+Shift+K', click: send('ai') },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { label: 'Wiedergabe / Pause\t(Leertaste)', click: send('playPause') },
        { label: 'Zum Anfang\t(Pos1)', click: send('goStart') },
        { label: 'Zum Ende\t(Ende)', click: send('goEnd') },
        { label: 'Wiedergabe wiederholen (Schleife)', accelerator: 'CmdOrCtrl+L', click: send('toggleLoop') },
        { type: 'separator' },
        { label: 'Timeline vergrößern', accelerator: 'CmdOrCtrl+Plus', click: send('zoomIn') },
        { label: 'Timeline verkleinern', accelerator: 'CmdOrCtrl+-', click: send('zoomOut') },
        { label: 'Timeline einpassen', accelerator: 'CmdOrCtrl+0', click: send('zoomFit') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const, label: 'Entwicklerwerkzeuge' }, { role: 'reload' as const, label: 'Neu laden' }]),
      ],
    },
    {
      label: 'Hilfe',
      submenu: [
        { label: 'Nach Updates suchen …', click: send('checkUpdates') },
        { label: 'Tastenkürzel', click: send('shortcuts') },
        { label: 'PanoCut auf GitHub', click: () => { void shell.openExternal('https://github.com/BlayZzo/pano-cut'); } },
        { label: 'Problem melden', click: () => { void shell.openExternal('https://github.com/BlayZzo/pano-cut/issues'); } },
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Über PanoCut', click: send('about') }, { label: 'PanoCut deinstallieren …', click: send('uninstall') }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
