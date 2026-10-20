// ⏱ Zeit & Tempo (Werkzeug-Seite): Zeitraffer-Faktor bestimmen/übertragen und zwei Kamerawinkel zeitlich passend untereinanderlegen.
import type { Clip, MediaItem } from '@shared/types';
import { clipDuration } from '@shared/timeline';
import { alignClip, correlate, estimateTimelapse, snapFactor, timezoneGuess } from '@shared/timesync';
import { useProject } from '../store/project';

const api = () => window.panocut;
const NICE_SEARCH = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 25, 30, 40, 50, 60];

/** Aufnahmezeiten nachlesen (ältere Projekte) und im Medium merken. */
export async function ensureTimes(m: MediaItem): Promise<MediaItem> {
  if (m.info.recordedAt) return m;
  const tm = await api().mediaTimes(m.path);
  const next = { ...m, info: { ...m.info, recordedAt: tm.recordedAt, recordedEnd: tm.recordedEnd } };
  useProject.getState().updateMedia(next);
  return next;
}

/** Schnellste Datei für Analysen (kleine Vorschau-Datei, sonst Original). */
function fileFor(m: MediaItem): string {
  return m.proxy ?? m.companion ?? m.path;
}

/** Bewegungsverlauf als reales Zeitraster (Schritt `step` s) ab realer Sekunde 0 der Datei-Ausschnitts. */
async function realCurve(m: MediaItem, factor: number, fileStart: number, fileDur: number, step: number): Promise<number[]> {
  // dicht genug abtasten, dass ein Wert ≈ `step` reale Sekunden entspricht; lange Abschnitte nur über Schlüsselbilder
  const perFileSec = Math.min(15, Math.max(1, factor / step));
  const dense = fileDur <= 900 ? perFileSec : 0;
  const c = await api().activityCurve(fileFor(m), Math.max(0, fileStart), fileDur, dense);
  const out: number[] = [];
  if (c.times.length < 2) return out;
  const end = (c.times[c.times.length - 1] - fileStart) * factor;
  let j = 0;
  for (let t = 0; t <= end; t += step) {
    const ft = fileStart + t / factor;
    while (j < c.times.length - 2 && c.times[j + 1] < ft) j++;
    const t0 = c.times[j], t1 = c.times[j + 1] ?? t0 + 1;
    const f = Math.max(0, Math.min(1, (ft - t0) / Math.max(1e-6, t1 - t0)));
    out.push(c.values[j] * (1 - f) + (c.values[j + 1] ?? c.values[j]) * f);
  }
  return out;
}

export interface SyncResult { start: number; in: number; speed: number; factorOther: number; offsetSec: number; score: number; usedTimes: boolean }

/**
 * Clip `other` so legen (und im Tempo anpassen), dass er dasselbe Geschehen zur selben Zeit zeigt wie `ref`.
 * factorRef/factorOther = Zeitraffer-Faktoren (1 = normal); 'auto' = suchen.
 */
export async function syncAngles(ref: Clip, refMedia: MediaItem, other: Clip, otherMedia: MediaItem,
  opts: { factorRef: number; factorOther: number | 'auto'; refine: boolean }, onProgress: (p: number) => void): Promise<SyncResult> {
  const a = await ensureTimes(refMedia), b = await ensureTimes(otherMedia);
  const fa = opts.factorRef;
  const haveTimes = !!a.info.recordedAt && !!b.info.recordedAt;
  const step = 0.5;
  const MARGIN = 90;   // Sekunden Unsicherheit der Kamera-Uhren

  // Kandidaten für den Faktor des zweiten Clips
  const est = estimateTimelapse(b.info).factor;
  const candidates = opts.factorOther === 'auto' ? Array.from(new Set([est, ...NICE_SEARCH])) : [opts.factorOther];
  onProgress(5);

  if (haveTimes) {
    const tz = timezoneGuess(a.info.recordedAt!, a.info.duration * fa * 1000, b.info.recordedAt!, b.info.duration * candidates[0] * 1000);
    let best = { factor: candidates[0], lagSec: 0, score: 0 };
    if (opts.refine) {
      // Realer Zeitraum, den der Referenz-Clip auf der Timeline zeigt (+ Rand)
      const refFileIn = ref.in, refFileOut = ref.in + clipDuration(ref) * ref.speed;
      const realA0 = a.info.recordedAt! / 1000 + refFileIn * fa - MARGIN;
      const realA1 = a.info.recordedAt! / 1000 + refFileOut * fa + MARGIN;
      const fileStartA = Math.max(0, refFileIn - MARGIN / fa);
      const RA = a.info.recordedAt! / 1000 + fileStartA * fa;      // reale Zeit des ersten Werts von A
      const curveA = await realCurve(a, fa, fileStartA, (refFileOut - refFileIn) + (2 * MARGIN) / fa, step);
      onProgress(35);
      let i = 0;
      for (const fb of candidates) {
        const B0 = (b.info.recordedAt! - tz) / 1000;
        const fileStart = Math.max(0, (realA0 - B0) / fb);
        const fileEnd = Math.min(b.info.duration, (realA1 - B0) / fb);
        if (fileEnd - fileStart < 1) continue;
        const curveB = await realCurve(b, fb, fileStart, fileEnd - fileStart, step);
        // A[i] ≈ B[i + lag]  ⇒  Uhrenfehler von B gegenüber A:  e = (RB − RA) + lag·step
        const RB = B0 + fileStart * fb;
        const expected = Math.round((RB - RA) / step);
        const r = correlate(curveA, curveB, Math.round(MARGIN / step) + Math.abs(expected));
        const lagSec = (RB - RA) + r.lag * step;
        if (r.score > best.score) best = { factor: fb, lagSec, score: r.score };
        onProgress(35 + (60 * ++i) / candidates.length);
      }
    }
    const offsetMs = tz + best.lagSec * 1000;
    const res = alignClip(ref, a.info, fa, other, b.info, best.factor, offsetMs);
    return { ...res, factorOther: best.factor, offsetSec: offsetMs / 1000, score: best.score, usedTimes: true };
  }

  // Ohne Aufnahmezeiten: nur Bildvergleich über die ganze Länge
  const curveA = await realCurve(a, fa, ref.in, clipDuration(ref) * ref.speed, step);
  onProgress(40);
  let best = { factor: candidates[0], lag: 0, score: -2 };
  let i = 0;
  for (const fb of candidates) {
    const curveB = await realCurve(b, fb, 0, b.info.duration, step);
    const r = correlate(curveA, curveB, Math.max(curveA.length, curveB.length));
    if (r.score > best.score) best = { factor: fb, lag: r.lag, score: r.score };
    onProgress(40 + (55 * ++i) / candidates.length);
  }
  // A[i] (reale Zeit ab ref.in·fa) ≈ B[i + lag] (reale Zeit ab Dateianfang von B)
  const rate = ref.speed * fa;
  const speed = Math.max(0.05, Math.min(100, rate / best.factor));
  const bRealAtRefIn = best.lag * step;                 // reale Sekunde in B, die zu ref.in passt
  let inPt = bRealAtRefIn / best.factor;
  let start = ref.start;
  if (inPt < 0) { start = ref.start + (-inPt * best.factor) / rate; inPt = 0; }
  return { start, in: inPt, speed, factorOther: best.factor, offsetSec: 0, score: best.score, usedTimes: false };
}

export function describeFactor(f: number): string {
  return f <= 1.05 ? '1× (normal)' : `${snapFactor(f)}×`;
}
