import { spawn, ChildProcess } from 'node:child_process';
import log from 'electron-log';
import { getFfmpegPath } from './paths';

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

export interface ProbeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';
  codec_name?: string;
  width?: number;
  height?: number;
  fps?: number;
  rotation?: number;
  channels?: number;
  sample_rate?: number;
  pix_fmt?: string;
  attachedPic?: boolean;
}

export interface ProbeResult {
  format: { duration?: number; format_name?: string; bitrate?: number };
  streams: ProbeStream[];
}

function parseDuration(s: string): number {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Liest Dateiinformationen über `ffmpeg -i` (wir liefern kein ffprobe mit – spart ~40 MB pro Installer).
 * Die Ausgabe von ffmpeg ist seit Jahren stabil formatiert.
 */
export function probeFile(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`FFmpeg konnte nicht gestartet werden: ${e.message}`)));
    child.on('close', () => {
      const result: ProbeResult = { format: {}, streams: [] };
      const lines = err.split(/\r?\n/);
      let sawInput = false;
      let current: ProbeStream | null = null;
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (/^Input #0,/.test(line)) {
          sawInput = true;
          const m = /^Input #0, ([^,]+(?:,[^,]+)*?), from/.exec(line);
          if (m) result.format.format_name = m[1];
          continue;
        }
        if (!sawInput) continue;
        if (/^\s*Duration:/.test(line)) {
          const d = /Duration: ([^,]+)/.exec(line);
          if (d && !d[1].includes('N/A')) result.format.duration = parseDuration(d[1]);
          const b = /bitrate: (\d+) kb\/s/.exec(line);
          if (b) result.format.bitrate = Number(b[1]) * 1000;
          continue;
        }
        const sm = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Subtitle|Data|Attachment): (.*)$/.exec(line);
        if (sm) {
          const rest = sm[3];
          const codec = /^([A-Za-z0-9_]+)/.exec(rest)?.[1];
          current = { index: Number(sm[1]), codec_type: sm[2].toLowerCase() as ProbeStream['codec_type'], codec_name: codec };
          if (current.codec_type === 'video') {
            const dim = /, (\d{2,5})x(\d{2,5})(?:[ ,\[]|$)/.exec(rest);
            if (dim) { current.width = Number(dim[1]); current.height = Number(dim[2]); }
            const fps = /([\d.]+) fps/.exec(rest) ?? /([\d.]+) tbr/.exec(rest);
            if (fps) current.fps = Number(fps[1]);
            const pix = /, (yuv[a-z0-9]+|rgb[a-z0-9]*|gray[a-z0-9]*|bgr[a-z0-9]*|gbr[a-z0-9]*|pal8|monob)/.exec(rest);
            if (pix) current.pix_fmt = pix[1];
            if (rest.includes('(attached pic)')) current.attachedPic = true;
          } else if (current.codec_type === 'audio') {
            const sr = /(\d+) Hz/.exec(rest);
            if (sr) current.sample_rate = Number(sr[1]);
            if (/\bmono\b/.test(rest)) current.channels = 1;
            else if (/\bstereo\b/.test(rest)) current.channels = 2;
            else { const ch = /(\d+) channels/.exec(rest); if (ch) current.channels = Number(ch[1]); }
          }
          result.streams.push(current);
          continue;
        }
        if (current && /rotation of (-?[\d.]+) degrees/.test(line)) {
          current.rotation = Number(/rotation of (-?[\d.]+) degrees/.exec(line)![1]);
        }
        if (/^\s*Output #|^At least one output/.test(line)) break;
      }
      if (!sawInput) {
        const tail = err.trim().split('\n').slice(-3).join('\n');
        return reject(new Error(tail || 'Datei konnte nicht gelesen werden'));
      }
      resolve(result);
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

/** Liste der verfügbaren Filter der mitgelieferten FFmpeg-Version. */
let filterCache: Set<string> | null = null;
export async function availableFilters(): Promise<Set<string>> {
  if (filterCache) return filterCache;
  return new Promise((resolve) => {
    const child = spawn(getFfmpegPath(), ['-hide_banner', '-filters'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => {
      const set = new Set<string>();
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*[TSC.]{3}\s+([a-zA-Z0-9_]+)\s+[A-Z|N]+->/);
        if (m) set.add(m[1]);
      }
      filterCache = set;
      resolve(set);
    });
    child.on('error', () => resolve(new Set()));
  });
}
