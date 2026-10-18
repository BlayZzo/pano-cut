import { protocol, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const MEDIA_SCHEME = 'pcmedia';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** Muss vor `app.ready` aufgerufen werden. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  ]);
}

export function toMediaUrl(filePath: string): string {
  // Pfad als URL-Pfad kodieren (Windows-Laufwerksbuchstaben bleiben erhalten)
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${MEDIA_SCHEME}://local/${encoded.replace(/^\//, '')}`;
}

function fromMediaUrl(url: string): string {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (process.platform === 'win32') {
    p = p.replace(/^\//, '');
    if (!/^[a-zA-Z]:/.test(p)) p = '/' + p;
  }
  return path.normalize(p);
}

/**
 * Liefert lokale Dateien an die Oberfläche – mit Unterstützung für Range-Anfragen,
 * damit Videos sofort spulbar sind.
 */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let filePath: string;
    try {
      filePath = fromMediaUrl(request.url);
    } catch {
      return new Response('Ungültige Adresse', { status: 400 });
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return new Response('Nicht gefunden', { status: 404 });
    }
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const size = stat.size;
    const range = request.headers.get('range');
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      // Große Bereiche in Blöcken liefern (Chromium fragt ohnehin nach)
      const stream = fs.createReadStream(filePath, { start, end });
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = String(end - start + 1);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 206, headers });
    }
    headers['Content-Length'] = String(size);
    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
  });
  void net; // (net.fetch wird hier bewusst nicht benutzt – Range-Anfragen brauchen eigene Behandlung)
}
