// Auto-Musik-Schnitt: verteilt Video-Clips so auf die Schläge der Musik, dass jeder Schnitt auf einem Schlag liegt.
import type { Clip, MotionKeyframe } from './types';
import { cutPoints, type BeatInfo } from './beats';
import { clipDuration, clipEnd } from './timeline';
import { scaleClipTimes, sliceClip } from './clipslice';

export type BeatCutMode = 'beat' | 'beat2' | 'bar' | 'energy';
export type BeatAccent = 'none' | 'zoom' | 'shake' | 'flash';

export interface BeatCutOptions {
  mode: BeatCutMode;
  fill: boolean;          // bis zum Musik-Ende füllen (Clips werden mehrfach mit verschiedenen Stellen benutzt)
  accent: BeatAccent;     // Betonung auf jeder Takt-Eins
  strength: number;       // Stärke der Betonung 0..2
}

export const DEFAULT_BEAT_CUT: BeatCutOptions = { mode: 'beat2', fill: true, accent: 'zoom', strength: 1 };

const MIN_SEGMENT = 0.2;
const MIN_SPEED = 0.25;

/** Quellzeit (Sekunden in der Musikdatei) → Timeline-Zeit für einen Musik-Clip. */
function toTimeline(music: Clip, src: number): number {
  return music.start + (music.reverse ? music.out - src : src - music.in) / music.speed;
}

/** Schnittgrenzen auf der Timeline (inkl. Anfang und Ende der Musik). */
export function beatCutBounds(music: Clip, info: BeatInfo, mode: BeatCutMode): number[] {
  const S = music.start, E = clipEnd(music);
  const cuts = cutPoints(info, music.in, music.out, mode).map((x) => toTimeline(music, x)).sort((a, b) => a - b);
  const bounds = [S];
  for (const c of cuts) {
    if (c - bounds[bounds.length - 1] < MIN_SEGMENT || E - c < MIN_SEGMENT) continue;
    bounds.push(c);
  }
  bounds.push(E);
  return bounds;
}

function accentKeys(kind: BeatAccent, strength: number, dur: number): MotionKeyframe[] | null {
  const s = Math.max(0, Math.min(2, strength));
  if (kind === 'zoom') {
    const len = Math.min(0.4, dur * 0.6);
    return [
      { t: 0, x: 0, y: 0, scale: 1 + 0.12 * s, rotation: 0, opacity: 1 },
      { t: len, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    ];
  }
  if (kind === 'shake') {
    const len = Math.min(0.45, dur * 0.7), steps = 9;
    const out: MotionKeyframe[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps, decay = i === steps ? 0 : Math.exp(-u * 3);
      const ph = i * 2.399;
      out.push({
        t: u * len,
        x: Math.round(Math.sin(ph * 1.7) * 1.6 * s * decay * 100) / 100,
        y: Math.round(Math.cos(ph * 2.3) * 1.2 * s * decay * 100) / 100,
        scale: 1 + (i === steps ? 0 : 0.04 * s),
        rotation: Math.round(Math.sin(ph) * 0.6 * s * decay * 100) / 100,
        opacity: 1,
      });
    }
    return out;
  }
  return null;
}

/**
 * Plant die neuen Clips. `sources` in gewünschter Reihenfolge; `limitless(c)` = Clip ist beliebig lang (Bild, Titel).
 * Ergebnis: neue Clips (noch ohne Spur-Zuordnung geändert) und das Ende des Schnitts.
 */
export function planBeatCut(
  music: Clip, info: BeatInfo, sources: Clip[], opts: BeatCutOptions,
  newId: () => string, limitless: (c: Clip) => boolean,
): { clips: Clip[]; end: number; cuts: number } {
  if (sources.length === 0 || info.beats.length === 0) return { clips: [], end: music.start, cuts: 0 };
  const bounds = beatCutBounds(music, info, opts.mode);
  let segs = bounds.slice(1).map((b, i) => ({ start: bounds[i], dur: b - bounds[i] }));
  if (!opts.fill) segs = segs.slice(0, sources.length);
  const n = sources.length;
  const uses = sources.map((_, j) => segs.filter((_, i) => i % n === j).length);
  const used = sources.map(() => 0);
  const downs = info.downbeats.map((d) => toTimeline(music, d));
  const isDown = (t: number) => downs.some((d) => Math.abs(d - t) < 0.06);
  const out: Clip[] = [];
  segs.forEach((seg, i) => {
    const j = i % n;
    const src = sources[j];
    const u = used[j]++;
    let piece: Clip;
    if (limitless(src)) {
      piece = { ...src, id: newId(), in: src.in, out: src.in + seg.dur * src.speed, start: seg.start, transition: undefined };
    } else {
      const dur = clipDuration(src);
      const k = Math.max(1, uses[j]);
      const win = dur / k;
      if (seg.dur <= dur) {
        const off = Math.max(0, Math.min(dur - seg.dur, u * win + (win - seg.dur) / 2));
        piece = sliceClip(src, off, off + seg.dur, newId());
      } else {
        // Clip ist kürzer als der Abschnitt: etwas langsamer abspielen, damit der nächste Schnitt wieder auf dem Schlag liegt
        const f = Math.max(MIN_SPEED, dur / seg.dur);
        piece = scaleClipTimes(sliceClip(src, 0, dur, newId()), 1 / f);
        piece = { ...piece, speed: src.speed * f };
      }
      piece = { ...piece, start: seg.start };
    }
    piece.transition = undefined;
    piece.fadeIn = 0; piece.fadeOut = 0;
    if (i === 0) piece.fadeIn = src.fadeIn;
    const onDown = opts.mode === 'bar' || isDown(seg.start);
    if (onDown && i > 0 && opts.accent !== 'none') {
      if (opts.accent === 'flash') {
        piece.transition = { type: 'fadewhite', duration: Math.min(0.12 + 0.12 * opts.strength, seg.dur * 0.8) };
      } else if (!piece.motion || piece.motion.keyframes.length === 0) {
        const keys = accentKeys(opts.accent, opts.strength, clipDuration(piece));
        if (keys) piece.motion = { preset: 'custom', intensity: 1, smooth: true, keyframes: keys };
      }
    }
    out.push(piece);
  });
  const end = out.length ? clipEnd(out[out.length - 1]) : music.start;
  return { clips: out, end, cuts: Math.max(0, out.length - 1) };
}
