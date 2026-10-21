// Auto-Musik-Schnitt: verteilt Video-Clips so auf die Schläge der Musik, dass jeder Schnitt auf einem Schlag liegt.
import type { Clip, MotionKeyframe } from './types';
import { cutPoints, type BeatInfo } from './beats';
import { clipDuration, clipEnd } from './timeline';
import { scaleClipTimes, sliceClip } from './clipslice';

export type BeatCutMode = 'beat' | 'beat2' | 'bar' | 'energy' | 'hits' | 'markers';
export type BeatAccent = 'none' | 'zoom' | 'shake' | 'flash';

export interface BeatCutOptions {
  mode: BeatCutMode;
  fill: boolean;          // bis zum Musik-Ende füllen (Clips werden mehrfach mit verschiedenen Stellen benutzt)
  accent: BeatAccent;     // Betonung auf jeder Takt-Eins
  strength: number;       // Stärke der Betonung 0..2
  best?: boolean;         // die bewegtesten Stellen jedes Videos nehmen (statt gleichmäßig verteilt)
  accentOn?: 'down' | 'hits' | 'all';  // wo betont wird: Takt-Eins, Höhepunkte, jeder Schnitt
}

export const DEFAULT_BEAT_CUT: BeatCutOptions = { mode: 'hits', fill: true, accent: 'zoom', strength: 1, best: true, accentOn: 'hits' };

/** Bewegung über die Quellzeit eines Videos (für „beste Stellen“). */
export interface ActivityCurve { times: number[]; values: number[] }

const MIN_SEGMENT = 0.2;
const MIN_SPEED = 0.25;

/** Quellzeit (Sekunden in der Musikdatei) → Timeline-Zeit für einen Musik-Clip. */
function toTimeline(music: Clip, src: number): number {
  return music.start + (music.reverse ? music.out - src : src - music.in) / music.speed;
}

/** Schnittgrenzen auf der Timeline (inkl. Anfang und Ende der Musik). */
export function beatCutBounds(music: Clip, info: BeatInfo, mode: BeatCutMode, markers: number[] = []): number[] {
  const S = music.start, E = clipEnd(music);
  const cuts = (mode === 'markers'
    ? markers.filter((t) => t > S && t < E)
    : cutPoints(info, music.in, music.out, mode).map((x) => toTimeline(music, x))).sort((a, b) => a - b);
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
/** Mittlere Bewegung im Quellbereich [a, b] eines Videos. */
function activityIn(curve: ActivityCurve, a: number, b: number): number {
  let s = 0, n = 0;
  for (let i = 0; i < curve.times.length; i++) if (curve.times[i] >= a && curve.times[i] <= b) { s += curve.values[i]; n++; }
  if (n) return s / n;
  // keine Messung im Bereich: nächster Wert
  let best = 0, d = Infinity;
  for (let i = 0; i < curve.times.length; i++) { const x = Math.abs(curve.times[i] - (a + b) / 2); if (x < d) { d = x; best = curve.values[i]; } }
  return best;
}

/**
 * Beste Startpunkte (Clip-lokal) für `durs` Abschnitte aus einem Clip: möglichst viel Bewegung, ohne Überlappung,
 * (längste Abschnitte zuerst).
 */
export function bestOffsets(src: Clip, curve: ActivityCurve, durs: number[]): number[] {
  const total = clipDuration(src);
  const taken: Array<[number, number]> = [];
  const order = durs.map((d, i) => ({ d, i })).sort((a, b) => b.d - a.d);
  const out = new Array<number>(durs.length).fill(0);
  for (const { d, i } of order) {
    let best = -1, bestOff = Math.max(0, (total - d) / 2);
    const step = Math.max(0.1, d / 4);
    for (let off = 0; off <= total - d + 1e-6; off += step) {
      if (taken.some(([a, b]) => off < b - 1e-6 && off + d > a + 1e-6)) continue;
      const sa = src.in + off * src.speed, sb = src.in + (off + d) * src.speed;
      const v = activityIn(curve, sa, sb);
      if (v > best) { best = v; bestOff = off; }
    }
    taken.push([bestOff, bestOff + d]);
    out[i] = bestOff;
  }
  return out;
}

export function planBeatCut(
  music: Clip, info: BeatInfo, sources: Clip[], opts: BeatCutOptions,
  newId: () => string, limitless: (c: Clip) => boolean,
  extra: { markers?: number[]; activity?: Record<string, ActivityCurve> } = {},
): { clips: Clip[]; end: number; cuts: number } {
  if (sources.length === 0 || (info.beats.length === 0 && opts.mode !== 'markers')) return { clips: [], end: music.start, cuts: 0 };
  const bounds = beatCutBounds(music, info, opts.mode, extra.markers);
  let segs = bounds.slice(1).map((b, i) => ({ start: bounds[i], dur: b - bounds[i] }));
  if (!opts.fill) segs = segs.slice(0, sources.length);
  const n = sources.length;
  const uses = sources.map((_, j) => segs.filter((_, i) => i % n === j).length);
  const used = sources.map(() => 0);
  const downs = info.downbeats.map((d) => toTimeline(music, d));
  const hitsT = (info.hits ?? []).map((d) => toTimeline(music, d));
  const isDown = (t: number) => downs.some((d) => Math.abs(d - t) < 0.06);
  const isHit = (t: number) => hitsT.some((d) => Math.abs(d - t) < 0.06);
  // Beste Stellen: für jede Quelle die Abschnittslängen sammeln und passende Startpunkte suchen
  const bestPlan = new Map<number, number[]>();
  if (opts.best && extra.activity) {
    sources.forEach((src, j) => {
      const curve = extra.activity![src.id];
      if (!curve || limitless(src)) return;
      const durs = segs.filter((_, i) => i % n === j).map((s) => Math.min(s.dur, clipDuration(src)));
      if (durs.reduce((a, b) => a + b, 0) > clipDuration(src) + 1e-6) return; // passt nicht ohne Überlappung → gleichmäßig
      bestPlan.set(j, bestOffsets(src, curve, durs));
    });
  }
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
        const planned = bestPlan.get(j)?.[u];
        const off = planned !== undefined ? planned : Math.max(0, Math.min(dur - seg.dur, u * win + (win - seg.dur) / 2));
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
    const where = opts.accentOn ?? 'down';
    const accentHere = where === 'all' || (where === 'hits' ? isHit(seg.start) || (hitsT.length === 0 && isDown(seg.start)) : opts.mode === 'bar' || isDown(seg.start));
    if (accentHere && i > 0 && opts.accent !== 'none') {
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
