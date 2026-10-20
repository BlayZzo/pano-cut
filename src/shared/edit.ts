// Schnitt-Werkzeuge als reine Funktionen (testbar): Bereiche herausschneiden und Lücke schließen, Stück am Anfang einfügen.
import type { Clip, Project } from './types';
import { clipEnd, makeId } from './timeline';
import { sliceClip } from './clipslice';

export interface TimeRange { start: number; end: number }

/** Bereiche sortieren, überlappende zusammenfassen, zu kurze verwerfen. */
export function mergeRanges(ranges: TimeRange[], minLen = 0.05): TimeRange[] {
  const sorted = ranges.filter((r) => r.end - r.start >= minLen).map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-3) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** Wie viel vor dem Zeitpunkt t insgesamt entfernt wird. */
function removedBefore(ranges: TimeRange[], t: number): number {
  let s = 0;
  for (const r of ranges) {
    if (r.end <= t) s += r.end - r.start;
    else if (r.start < t) s += t - r.start;
  }
  return s;
}

/**
 * Bereiche (Timeline-Zeit) herausschneiden und alles danach nach vorne rücken.
 * Auf den Spuren `cutTracks` werden Clips zerteilt; Clips anderer Spuren (z. B. Musik) bleiben ganz und rücken nur nach,
 * wenn sie später beginnen.
 */
export function rippleCut(project: Project, rangesIn: TimeRange[], cutTracks: Set<string>): Clip[] {
  const ranges = mergeRanges(rangesIn);
  const out: Clip[] = [];
  for (const c of Object.values(project.clips)) {
    const a = c.start, b = clipEnd(c);
    if (!cutTracks.has(c.trackId)) {
      out.push({ ...c, start: Math.max(0, c.start - removedBefore(ranges, c.start)) });
      continue;
    }
    // Teile des Clips außerhalb der Bereiche
    let pieces: TimeRange[] = [{ start: a, end: b }];
    for (const r of ranges) {
      const next: TimeRange[] = [];
      for (const p of pieces) {
        if (r.end <= p.start || r.start >= p.end) { next.push(p); continue; }
        if (r.start > p.start) next.push({ start: p.start, end: r.start });
        if (r.end < p.end) next.push({ start: r.end, end: p.end });
      }
      pieces = next;
    }
    pieces = pieces.filter((p) => p.end - p.start > 0.04);
    pieces.forEach((p, i) => {
      const piece = sliceClip(c, p.start - a, p.end - a, i === 0 ? c.id : makeId('clip'));
      out.push({ ...piece, start: Math.max(0, p.start - removedBefore(ranges, p.start)) });
    });
  }
  return out;
}

/** Den Bereich [from, to] einer Spur (alle Clips darin) als neuen Anfang einfügen; alles andere rückt nach hinten. */
export function insertAtStart(project: Project, trackId: string, from: number, to: number): Clip[] {
  const len = Math.max(0.1, to - from);
  const shifted = Object.values(project.clips).map((c) => ({ ...c, start: c.start + len }));
  const pieces: Clip[] = [];
  for (const c of Object.values(project.clips)) {
    if (c.trackId !== trackId || clipEnd(c) <= from + 1e-3 || c.start >= to - 1e-3) continue;
    const a = Math.max(from, c.start), b = Math.min(to, clipEnd(c));
    const piece = sliceClip(c, a - c.start, b - c.start, makeId('clip'));
    pieces.push({ ...piece, start: a - from, transition: a > from + 1e-3 ? piece.transition : undefined, fadeIn: 0 });
  }
  return [...shifted, ...pieces];
}
