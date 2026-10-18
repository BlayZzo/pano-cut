import { spawn, ChildProcess } from 'node:child_process';
import log from 'electron-log';
import { getFfmpegPath, getFfprobePath } from './paths';

export interface RunOptions {
  onProgress?: (p: { outTime: number; fps?: number; speed?: string }) => void;
  signal?: AbortSignal;
  /** Priorität senken, damit der Rechner flüssig bleibt (Hintergrundarbeit). */
  lowPriority?: boolean;
}

export class FfmpegError extends Error {
  constructor(message: string, public readonly stderr: string, public readonly code: number | null) {
    super(message);
  }
}

const active = new Set<ChildProcess>();

export function killAll(): void {
  for (const p of active) {
    try { p.kill('SIGKILL'); } catch { /* ignorieren */ }
  }
  active.clear();
}

/** Führt ffmpeg aus. Fortschritt wird über `-progress pipe:1` gelesen. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-nostdin', '-y', ...args];
    if (opts.onProgress) fullArgs.push('-progress', 'pipe:1', '-nostats');
    log.debug('ffmpeg', fullArgs.join(' '));
    const child = spawn(getFfmpegPath(), fullArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    if (opts.lowPriority) {
      try { require('node:os').setPriority(child.pid!, 10); } catch { /* nicht überall möglich */ }
    }
    let stderr = '';
    let stdoutBuf = '';
    let current: { outTime: number; fps?: number; speed?: string } = { outTime: 0 };

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1).trim();
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const n = Number(val);
          if (isFinite(n) && n >= 0) current.outTime = n / 1e6;
        } else if (key === 'fps') {
          current.fps = Number(val);
        } else if (key === 'speed') {
          current.speed = val;
        } else if (key === 'progress') {
          opts.onProgress?.({ ...current });
        }
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignorieren */ }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      active.delete(child);
      reject(new FfmpegError(`FFmpeg konnte nicht gestartet werden: ${err.message}`, stderr, null));
    });
    child.on('close', (code) => {
      active.delete(child);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new FfmpegError('Abgebrochen', stderr, code));
      if (code === 0) resolve(stderr);
      else {
        const tail = stderr.trim().split('\n').slice(-6).join('\n');
        reject(new FfmpegError(`FFmpeg-Fehler (Code ${code}):\n${tail}`, stderr, code));
      }
    });
  });
}

export interface ProbeResult {
  format: { duration?: string; size?: string; format_name?: string; tags?: Record<string, string> };
  streams: Array<{
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    duration?: string;
    nb_frames?: string;
    tags?: Record<string, string>;
    side_data_list?: Array<{ rotation?: number; side_data_type?: string }>;
    channels?: number;
    sample_rate?: string;
    pix_fmt?: string;
  }>;
}

export function runFfprobe(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
    const child = spawn(getFfprobePath(), args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`ffprobe konnte nicht gestartet werden: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe-Fehler (${code})`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error('ffprobe-Ausgabe unlesbar')); }
    });
  });
}

export function parseFps(rate?: string): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!d) return n || 0;
  return d === 0 ? 0 : n / d;
}

/** Prüft einmalig, welche Encoder die mitgelieferte FFmpeg-Version kennt. */
let encoderCache: Set<string> | null = null;
export async function availableEncoders(): Promise<Set<string>> {
  if (encoderCache) return encoderCache;
  return new Promise((resolve) => {
    const child = spawn(getFfmpegPath(), ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => {
      const set = new Set<string>();
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*[VAS][.FXBD]{5}\s+(\S+)/);
        if (m) set.add(m[1]);
      }
      encoderCache = set;
      resolve(set);
    });
    child.on('error', () => resolve(new Set()));
  });
}
