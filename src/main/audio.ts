// Ton-Analysen: Takterkennung für den Auto-Musik-Schnitt, Hüllkurven für die Mehrkamera-Synchronisierung.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import log from 'electron-log';
import type { BeatInfo } from '@shared/beats';
import { runFfmpeg } from './ffmpeg';
import { fileExists, mediaCacheDir } from './paths';
import { ANALYSIS_RATE, runAudioTask, type AudioTask, type AudioTaskResult } from './audioTasks';

const BEATS_VERSION = 1;

/** Dekodiert den Ton (Mono, 22,05 kHz, 32-Bit-Float) in eine temporäre Datei. */
async function decodePcm(file: string, start?: number, duration?: number): Promise<string> {
  const out = path.join(os.tmpdir(), `panocut_pcm_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.f32`);
  const args: string[] = [];
  if (start !== undefined && start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', file);
  if (duration !== undefined) args.push('-t', duration.toFixed(3));
  args.push('-vn', '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', out);
  await runFfmpeg(args, { lowPriority: true });
  return out;
}

function runTask(task: AudioTask): Promise<AudioTaskResult> {
  const workerFile = path.join(__dirname, 'audioWorker.js');
  if (!fileExists(workerFile)) return Promise.resolve(runAudioTask(task));
  return new Promise((resolve, reject) => {
    const w = new Worker(workerFile, { workerData: task });
    let done = false;
    w.once('message', (m: { ok: boolean; result?: AudioTaskResult; error?: string }) => {
      done = true;
      if (m.ok && m.result) resolve(m.result);
      else reject(new Error(m.error ?? 'Ton-Analyse fehlgeschlagen'));
      void w.terminate();
    });
    w.once('error', (e) => { if (!done) reject(e); });
    w.once('exit', (code) => { if (!done) reject(new Error(`Ton-Analyse beendet (Code ${code})`)); });
  });
}

/** Erkennt Tempo und Schläge einer Ton- oder Videodatei (Ergebnis wird im Medien-Cache gemerkt). */
export async function analyzeBeats(file: string): Promise<BeatInfo> {
  const cache = path.join(mediaCacheDir(file), `beats-v${BEATS_VERSION}.json`);
  if (fileExists(cache)) {
    try { return JSON.parse(fs.readFileSync(cache, 'utf8')) as BeatInfo; } catch { /* neu berechnen */ }
  }
  const pcm = await decodePcm(file);
  try {
    const t0 = Date.now();
    const info = (await runTask({ kind: 'beats', pcmFile: pcm })) as BeatInfo;
    log.info(`Takt erkannt: ${info.bpm} BPM, ${info.beats.length} Schläge (${Date.now() - t0} ms)`, path.basename(file));
    try { fs.writeFileSync(cache, JSON.stringify(info)); } catch { /* Cache optional */ }
    return info;
  } finally {
    fs.rm(pcm, { force: true }, () => undefined);
  }
}

/** Onset-Hüllkurve eines Ausschnitts (für die Synchronisierung mehrerer Kameras über den Ton). */
export async function audioEnvelope(file: string, start = 0, duration?: number): Promise<{ env: number[]; hop: number }> {
  const pcm = await decodePcm(file, start, duration);
  try {
    return (await runTask({ kind: 'envelope', pcmFile: pcm })) as { env: number[]; hop: number };
  } finally {
    fs.rm(pcm, { force: true }, () => undefined);
  }
}
