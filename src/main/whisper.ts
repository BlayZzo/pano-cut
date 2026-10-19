// Automatische Untertitel mit whisper.cpp (läuft komplett lokal, kein Abo).
// Das Programm (whisper-cli) wird mit PanoCut mitgeliefert; das Sprachmodell wird beim ersten
// Gebrauch heruntergeladen (so bleibt der Installer klein).
import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import type { SubtitleSegment, SubWord, WhisperModel, WhisperProgress } from '@shared/types';
import { groupWords } from '@shared/subtitles';
import { makeId } from '@shared/timeline';
import { runFfmpeg } from './ffmpeg';

export const MODELS: Record<WhisperModel, { file: string; sizeMB: number; name: string }> = {
  base: { file: 'ggml-base.bin', sizeMB: 142, name: 'Schnell (base, 142 MB)' },
  small: { file: 'ggml-small.bin', sizeMB: 466, name: 'Genauer (small, 466 MB)' },
};

const MODEL_URL = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

function modelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function modelPath(model: WhisperModel): string {
  return path.join(modelsDir(), MODELS[model].file);
}

export function whisperBinary(): string | null {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const osName = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const candidates = [
    process.env.PANOCUT_WHISPER,
    path.join(process.resourcesPath ?? '', 'whisper', exe),
    path.join(app.getAppPath(), 'resources', 'whisper', `${osName}-${process.arch}`, exe),
    path.join(app.getAppPath(), '..', 'resources', 'whisper', `${osName}-${process.arch}`, exe),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

export function whisperStatus(): { available: boolean; models: Record<WhisperModel, boolean> } {
  return {
    available: !!whisperBinary(),
    models: { base: fs.existsSync(modelPath('base')), small: fs.existsSync(modelPath('small')) },
  };
}

export async function downloadModel(model: WhisperModel, onProgress: (p: WhisperProgress) => void, signal?: AbortSignal): Promise<void> {
  const dest = modelPath(model);
  if (fs.existsSync(dest)) return;
  const url = MODEL_URL(MODELS[model].file);
  onProgress({ phase: 'download', percent: 0, message: `Sprachmodell wird geladen (${MODELS[model].sizeMB} MB) …` });
  const res = await net.fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? MODELS[model].sizeMB * 1024 * 1024);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress({ phase: 'download', percent: Math.round((received / total) * 100), message: `Sprachmodell wird geladen … ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB` });
    }
    await new Promise<void>((res2, rej) => out.end((e?: Error | null) => (e ? rej(e) : res2())));
    fs.renameSync(tmp, dest);
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export interface TranscribeRequest {
  mediaPath: string;
  start: number;       // Quell-Startpunkt (Sekunden)
  duration: number;
  language: string;    // 'de', 'en', 'auto', …
  model: WhisperModel;
  maxChars: number;    // Zeichen pro Untertitel-Segment (Social-Media-Stil: kurz)
  translate?: boolean; // direkt ins Englische übersetzen (whisper kann nur → Englisch)
}

/** Transkribiert einen Abschnitt und liefert Segmente relativ zum Abschnittsanfang (Quellzeit). */
export async function transcribe(req: TranscribeRequest, onProgress: (p: WhisperProgress) => void, signal?: AbortSignal): Promise<{ segments: SubtitleSegment[]; language: string }> {
  const bin = whisperBinary();
  if (!bin) throw new Error('Das Untertitel-Modul (whisper-cli) ist in dieser Installation nicht enthalten.');
  await downloadModel(req.model, onProgress, signal);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'panocut-whisper-'));
  try {
    const wav = path.join(work, 'audio.wav');
    onProgress({ phase: 'extract', percent: 0, message: 'Ton wird vorbereitet …' });
    await runFfmpeg(['-ss', req.start.toFixed(3), '-t', req.duration.toFixed(3), '-i', req.mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal });
    onProgress({ phase: 'transcribe', percent: 0, message: 'Sprache wird erkannt …' });
    const outBase = path.join(work, 'out');
    const args = ['-m', modelPath(req.model), '-f', wav, '-oj', '-of', outBase, '-pp', '-t', String(Math.max(2, Math.min(8, os.cpus().length - 1))), '-ml', '1', '-sow'];   // Wort für Wort (mit Zeiten) – Zeilen bilden wir selbst
    if (req.language && req.language !== 'auto') args.push('-l', req.language);
    else args.push('-l', 'auto');
    if (req.translate) args.push('-tr');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        err += s;
        const m = /progress\s*=\s*(\d+)%/.exec(s);
        if (m) onProgress({ phase: 'transcribe', percent: Number(m[1]), message: 'Sprache wird erkannt …' });
      });
      child.stdout.on('data', (d: Buffer) => { err += d.toString(); });
      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => reject(new Error(`whisper konnte nicht gestartet werden: ${e.message}`)));
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return reject(new Error('Abgebrochen'));
        if (code !== 0) return reject(new Error(`Spracherkennung fehlgeschlagen (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`));
        resolve();
      });
    });
    const json = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8')) as { result?: { language?: string }; transcription?: Array<{ offsets: { from: number; to: number }; text: string }> };
    const words: SubWord[] = [];
    let skip = false;
    for (const t of json.transcription ?? []) {
      const text = t.text.trim();
      if (!text) continue;
      // Geräusch-Markierungen wie [Musik] oder (Applaus) überspringen (können über mehrere Wörter gehen)
      if (/^[[(]/.test(text)) skip = true;
      const wasSkip = skip;
      if (/[\])]$/.test(text)) skip = false;
      if (wasSkip) continue;
      words.push({ start: t.offsets.from / 1000, end: Math.max(t.offsets.from / 1000 + 0.05, t.offsets.to / 1000), text });
    }
    // Satzzeichen, die whisper als eigenes „Wort“ liefert, an das vorige Wort hängen
    const merged: SubWord[] = [];
    for (const w of words) {
      if (merged.length && /^[.,!?;:…»«"')\]]+$/.test(w.text)) { const p = merged[merged.length - 1]; merged[merged.length - 1] = { ...p, text: p.text + w.text, end: w.end }; }
      else merged.push(w);
    }
    const segs = groupWords(merged, Math.max(10, req.maxChars), () => makeId('sub'));
    onProgress({ phase: 'done', percent: 100, message: `${segs.length} Untertitel erkannt` });
    return { segments: segs, language: json.result?.language ?? (req.language !== 'auto' ? req.language : '') };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function deleteModel(model: WhisperModel): void {
  try { fs.rmSync(modelPath(model), { force: true }); } catch (e) { log.warn(e); }
}
