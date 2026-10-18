// Anbindung an die eigene Cloud per WebDAV (Nextcloud, ownCloud, Synology, Hetzner Storage Box …).
// Keine Drittanbieter-Dienste, keine Abos – nur dein Server.
import { net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudSettings } from '@shared/types';
import type { CloudEntry } from '@shared/ipc';

function authHeader(s: CloudSettings): string {
  return 'Basic ' + Buffer.from(`${s.username}:${s.password}`).toString('base64');
}

function joinUrl(base: string, p: string): string {
  const b = base.replace(/\/+$/, '');
  const rel = p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return rel ? `${b}/${rel}` : b;
}

export async function cloudTest(s: CloudSettings): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await net.fetch(joinUrl(s.url, ''), { method: 'PROPFIND', headers: { Authorization: authHeader(s), Depth: '0' } });
    if (res.status === 207 || res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, message: 'Anmeldung fehlgeschlagen (Benutzername/Passwort prüfen).' };
    if (res.status === 404) {
      // Ordner anlegen
      const mk = await net.fetch(joinUrl(s.url, ''), { method: 'MKCOL', headers: { Authorization: authHeader(s) } });
      if (mk.ok || mk.status === 201) return { ok: true, message: 'Ordner wurde angelegt.' };
      return { ok: false, message: `Ordner nicht gefunden (${res.status}).` };
    }
    return { ok: false, message: `Server antwortet mit ${res.status}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function cloudList(s: CloudSettings, dir: string): Promise<CloudEntry[]> {
  const url = joinUrl(s.url, dir);
  const res = await net.fetch(url, { method: 'PROPFIND', headers: { Authorization: authHeader(s), Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>' });
  if (res.status !== 207) throw new Error(`Liste fehlgeschlagen (${res.status})`);
  const xml = await res.text();
  const entries: CloudEntry[] = [];
  const re = /<d:response>([\s\S]*?)<\/d:response>/gi;
  let m: RegExpExecArray | null;
  const basePath = new URL(url).pathname.replace(/\/+$/, '');
  while ((m = re.exec(xml))) {
    const block = m[1];
    const href = decodeURIComponent(/<d:href>([^<]+)<\/d:href>/i.exec(block)?.[1] ?? '');
    const p = href.replace(/\/+$/, '');
    if (!p || p === basePath) continue;
    const isDir = /<d:collection\s*\/?>/i.test(block);
    const size = Number(/<d:getcontentlength>(\d+)</i.exec(block)?.[1] ?? 0);
    const modified = /<d:getlastmodified>([^<]+)</i.exec(block)?.[1];
    entries.push({ name: path.posix.basename(p), path: p.slice(basePath.length), size, isDir, modified });
  }
  return entries;
}

async function ensureDirs(s: CloudSettings, remoteDir: string): Promise<void> {
  const parts = remoteDir.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    const res = await net.fetch(joinUrl(s.url, cur), { method: 'MKCOL', headers: { Authorization: authHeader(s) } });
    if (!(res.ok || res.status === 201 || res.status === 405)) throw new Error(`Ordner ${cur} konnte nicht angelegt werden (${res.status})`);
  }
}

export async function cloudUpload(s: CloudSettings, localPath: string, remotePath: string, onProgress: (p: { percent: number; message?: string }) => void): Promise<void> {
  const size = fs.statSync(localPath).size;
  await ensureDirs(s, path.posix.dirname(remotePath));
  onProgress({ percent: 0, message: `Hochladen … ${path.basename(localPath)}` });
  // Für Fortschritt die Datei in Blöcken lesen; WebDAV braucht den ganzen Body, daher Buffer (Exporte sind meist < 1 GB)
  const data = fs.readFileSync(localPath);
  const res = await net.fetch(joinUrl(s.url, remotePath), { method: 'PUT', headers: { Authorization: authHeader(s), 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, body: data });
  if (!(res.ok || res.status === 201 || res.status === 204)) throw new Error(`Upload fehlgeschlagen (${res.status})`);
  onProgress({ percent: 100, message: 'Hochgeladen' });
}

export async function cloudDownload(s: CloudSettings, remotePath: string, localPath: string, onProgress: (p: { percent: number; message?: string }) => void): Promise<void> {
  const res = await net.fetch(joinUrl(s.url, remotePath), { headers: { Authorization: authHeader(s) } });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const out = fs.createWriteStream(localPath + '.part');
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()));
    if (total) onProgress({ percent: Math.round((received / total) * 100), message: `Herunterladen … ${path.posix.basename(remotePath)}` });
  }
  await new Promise<void>((res2, rej) => out.end((e?: Error | null) => (e ? rej(e) : res2())));
  fs.renameSync(localPath + '.part', localPath);
  onProgress({ percent: 100 });
}
