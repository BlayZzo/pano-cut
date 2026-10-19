// Fernsteuerung (z. B. Elgato Stream Deck): kleiner HTTP-Server, nur auf diesem Rechner erreichbar (127.0.0.1).
import http from 'node:http';
import log from 'electron-log';

export const REMOTE_ACTIONS: Record<string, string> = {
  playpause: 'playPause',
  split: 'split',
  delete: 'delete',
  undo: 'undo',
  redo: 'redo',
  save: 'save',
  export: 'export',
  import: 'import',
  markin: 'markIn',
  markout: 'markOut',
  clearrange: 'clearRange',
  prevframe: 'prevFrame',
  nextframe: 'nextFrame',
  gostart: 'goStart',
  goend: 'goEnd',
  zoomin: 'zoomIn',
  zoomout: 'zoomOut',
  zoomfit: 'zoomFit',
  duplicate: 'duplicate',
  ai: 'ai',
  autoenhance: 'autoEnhance',
  loop: 'toggleLoop',
  // Mehrkamera: Kamera 1–4 live umschalten
  cam1: 'cam:1',
  cam2: 'cam:2',
  cam3: 'cam:3',
  cam4: 'cam:4',
};

let server: http.Server | null = null;

export function startRemote(port: number, onAction: (action: string) => void, getStatus: () => Record<string, unknown>): void {
  stopRemote();
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    // Schutz: Webseiten im Browser dürfen PanoCut nicht fernsteuern. Browser schicken immer einen Origin-Header
    // (bzw. Sec-Fetch-Site); das Stream-Deck-Plugin nicht. Aktionen nur per POST.
    if (req.headers.origin || req.headers['sec-fetch-site']) {
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, error: 'Nicht erlaubt' }));
      return;
    }
    if (url.pathname === '/status') {
      res.end(JSON.stringify({ app: 'PanoCut', ...getStatus(), actions: Object.keys(REMOTE_ACTIONS) }));
      return;
    }
    const m = /^\/action\/([a-z0-9]+)$/.exec(url.pathname);
    if (m && REMOTE_ACTIONS[m[1]] && req.method === 'POST') {
      onAction(REMOTE_ACTIONS[m[1]]);
      res.end(JSON.stringify({ ok: true, action: m[1] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'Unbekannte Aktion' }));
  });
  server.on('error', (err) => log.warn('Fernsteuerung konnte nicht starten', err.message));
  server.listen(port, '127.0.0.1', () => log.info(`Fernsteuerung aktiv auf http://127.0.0.1:${port}`));
}

export function stopRemote(): void {
  if (server) {
    try { server.close(); } catch { /* ignorieren */ }
    server = null;
  }
}
