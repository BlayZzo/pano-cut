import path from 'node:path';
import fs from 'node:fs';
import { runFfmpeg } from './ffmpeg';

/**
 * Dreht ein Video stückweise um (speicherschonend): Die Datei wird in kurze Segmente
 * geteilt, jedes Segment einzeln rückwärts gerendert und die Segmente in umgekehrter
 * Reihenfolge wieder zusammengesetzt. FFmpegs `reverse` würde sonst den ganzen Clip
 * in den Arbeitsspeicher laden.
 */
export interface ReverseOptions {
  start?: number;         // Quell-Startpunkt (Sekunden)
  duration?: number;      // Länge (Sekunden)
  videoFilter?: string;   // optionaler Filter vor dem Umkehren (z. B. Skalierung)
  complexInputs?: string[]; // Eingangs-Labels, wenn der Filter mehrere Streams braucht (360°-Stitching)
  fps?: number;
  hasAudio: boolean;
  width: number;          // ungefähre Bildgröße zur Wahl der Segmentlänge
  height: number;
  crf?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export async function reverseVideo(input: string, output: string, opts: ReverseOptions): Promise<void> {
  const workDir = output + '.parts';
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
    const bytesPerFrame = Math.max(1, opts.width * opts.height * 1.5);
    const segSec = Math.max(1.5, Math.min(10, 500e6 / (bytesPerFrame * fps)));
    const crf = opts.crf ?? 18;

    // 1) In Segmente zerlegen (neu kodiert, damit die Schnittpunkte exakt sind)
    const splitArgs: string[] = [];
    if (opts.start !== undefined) splitArgs.push('-ss', opts.start.toFixed(4));
    if (opts.duration !== undefined) splitArgs.push('-t', opts.duration.toFixed(4));
    splitArgs.push('-i', input);
    const vf = [opts.videoFilter, `fps=${fps}`].filter(Boolean).join(',');
    if (opts.complexInputs && opts.complexInputs.length > 1) {
      splitArgs.push('-filter_complex', `${opts.complexInputs.join('')}${vf}[v]`, '-map', '[v]');
    } else {
      splitArgs.push('-map', '0:v:0', '-vf', vf);
    }
    if (opts.hasAudio) splitArgs.push('-map', '0:a:0?');
    splitArgs.push(
      '-c:v', 'libx264', '-preset', 'faster', '-crf', String(crf), '-pix_fmt', 'yuv420p',
      '-force_key_frames', `expr:gte(t,n_forced*${segSec.toFixed(3)})`,
      '-c:a', 'pcm_s16le',
      '-f', 'segment', '-segment_time', segSec.toFixed(3), '-reset_timestamps', '1',
      path.join(workDir, 'seg_%04d.mov'),
    );
    await runFfmpeg(splitArgs, { signal: opts.signal, lowPriority: true });

    const segments = fs.readdirSync(workDir).filter((f) => f.startsWith('seg_') && f.endsWith('.mov')).sort();
    if (segments.length === 0) throw new Error('Keine Segmente erzeugt');

    // 2) Jedes Segment umkehren
    const reversed: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = path.join(workDir, segments[i]);
      const out = path.join(workDir, `rev_${segments[i]}`);
      const args = ['-i', seg, '-vf', 'reverse'];
      if (opts.hasAudio) args.push('-af', 'areverse');
      args.push('-c:v', 'libx264', '-preset', 'faster', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', out);
      await runFfmpeg(args, { signal: opts.signal, lowPriority: true });
      reversed.push(out);
      opts.onProgress?.((i + 1) / (segments.length + 1));
      fs.rmSync(seg, { force: true });
    }

    // 3) In umgekehrter Reihenfolge zusammensetzen
    const listPath = path.join(workDir, 'list.txt');
    fs.writeFileSync(listPath, reversed.reverse().map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const concatArgs = ['-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'copy'];
    if (opts.hasAudio) concatArgs.push('-c:a', 'aac', '-b:a', '192k');
    concatArgs.push('-movflags', '+faststart', output);
    await runFfmpeg(concatArgs, { signal: opts.signal });
    opts.onProgress?.(1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
