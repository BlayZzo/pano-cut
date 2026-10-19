// Rechenteil der Ton-Analysen – läuft im Worker-Thread (oder direkt, falls kein Worker verfügbar ist).
import fs from 'node:fs';
import { onsetEnvelope, trackBeats, type BeatInfo } from '@shared/beats';

export const ANALYSIS_RATE = 22050;

export type AudioTask =
  | { kind: 'beats'; pcmFile: string }
  | { kind: 'envelope'; pcmFile: string };

export type AudioTaskResult = BeatInfo | { env: number[]; hop: number };

export function readPcm(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  const copy = new Uint8Array(buf.length - (buf.length % 4));
  copy.set(buf.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

export function runAudioTask(task: AudioTask): AudioTaskResult {
  const samples = readPcm(task.pcmFile);
  const { env, low, high, rms, hop } = onsetEnvelope(samples, ANALYSIS_RATE);
  if (task.kind === 'beats') return trackBeats(env, rms, hop, low, high);
  return { env: Array.from(env), hop };
}
