// ⏱ Zeit & Tempo: Zeitraffer-Faktor erkennen und zwei Kamerawinkel zeitlich passend untereinanderlegen.
// Reale Aufnahmezeit = Startzeit der Datei (Metadaten/Dateiname) + Zeit in der Datei × Zeitraffer-Faktor.
// Feinabgleich über den Bewegungsverlauf beider Clips (Kreuzkorrelation) – funktioniert auch ohne Ton.
import type { Clip, MediaInfo } from './types';

/** Startzeit aus Dateinamen (Insta360 VID_20261017_144739, DJI_20261017084811, PXL_20261017_144739, 20261017_144739). */
export function timeFromName(name: string): number | undefined {
  const m = /(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined;
  return new Date(y, mo - 1, d, h, mi, s).getTime();   // Ortszeit wie die Kamera
}

/** Bekannte „schöne“ Zeitraffer-Faktoren (Kameras bieten meist diese an). */
const NICE = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 25, 30, 40, 50, 60, 75, 80, 90, 100, 120, 150, 180, 200, 240, 300, 600];

export function snapFactor(f: number): number {
  if (!(f > 1.2)) return 1;
  let best = f, bd = Infinity;
  for (const n of NICE) { const d = Math.abs(n - f) / n; if (d < bd) { bd = d; best = n; } }
  return bd < 0.04 ? best : Math.round(f * 10) / 10;
}

/**
 * Zeitraffer-Faktor aus den Zeiten: (Ende − Anfang der Aufnahme) / Länge des Videos.
 * Ende = Änderungszeit der Datei (Kamera schreibt sie beim Stoppen). 1 = normales Tempo.
 */
export function estimateTimelapse(info: MediaInfo): { factor: number; realSeconds?: number; reliable: boolean } {
  if (info.timelapseFactor && info.timelapseFactor > 1.05) return { factor: snapFactor(info.timelapseFactor), realSeconds: info.duration * info.timelapseFactor, reliable: true };
  if (!info.recordedAt || !info.recordedEnd || !(info.duration > 0)) return { factor: 1, reliable: false };
  const real = (info.recordedEnd - info.recordedAt) / 1000;
  if (!(real > 0)) return { factor: 1, reliable: false };
  const f = real / info.duration;
  // Normales Video: Ende ≈ Anfang + Länge (+ ein paar Sekunden zum Speichern)
  if (f < 1.3 || real - info.duration < 5) return { factor: 1, realSeconds: real, reliable: true };
  return { factor: snapFactor(f), realSeconds: real, reliable: f < 2000 };
}

/** Reale Uhrzeit (ms) eines Zeitpunkts t (Timeline-Sekunden) in einem Clip. */
export function realTimeAt(clip: Clip, info: MediaInfo, factor: number, t: number): number {
  const fileT = clip.in + (t - clip.start) * clip.speed;
  return (info.recordedAt ?? 0) + fileT * factor * 1000;
}

/**
 * Clip B so einstellen, dass er dieselbe reale Zeit zeigt wie Clip A (gleiche reale Geschwindigkeit je Timeline-Sekunde).
 * offsetMs korrigiert die Uhren der beiden Kameras (B-Uhr − A-Uhr). Liefert neuen Start, In-Punkt und Tempo für B.
 */
export function alignClip(a: Clip, ia: MediaInfo, fa: number, b: Clip, ib: MediaInfo, fb: number, offsetMs = 0): { start: number; in: number; speed: number } {
  const rate = a.speed * fa;                 // reale Sekunden pro Timeline-Sekunde in A
  const speed = Math.max(0.05, Math.min(100, rate / fb));
  // Reale Zeit (in A-Uhr) am Timeline-Punkt t: Ta(t) = A0 + (a.in + (t − a.start)·a.speed)·fa
  // Für B: Tb(t) = B0 − offset + (in + (t − start)·speed)·fb  → gleich setzen mit start = Timeline-Anfang von B
  const A0 = (ia.recordedAt ?? 0) / 1000, B0 = ((ib.recordedAt ?? 0) - offsetMs) / 1000;
  // Lage von B (bei unverändertem In-Punkt): start = a.start + ((B0 + b.in·fb) − (A0 + a.in·fa)) / rate
  let start = a.start + ((B0 + b.in * fb) - (A0 + a.in * fa)) / rate;
  let inPt = b.in;
  if (start < 0) {                            // läge vor dem Projektanfang → vorne abschneiden
    inPt = b.in + (-start) * speed;
    start = 0;
  }
  return { start, in: inPt, speed };
}

/** Normierte Kreuzkorrelation zweier gleich abgetasteter Kurven: beste Verschiebung (in Schritten) von b gegenüber a. */
export function correlate(a: number[], b: number[], maxLag: number): { lag: number; score: number } {
  const norm = (x: number[]) => {
    const m = x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
    const z = x.map((v) => v - m);
    const n = Math.sqrt(z.reduce((s, v) => s + v * v, 0)) || 1;
    return z.map((v) => v / n);
  };
  const A = norm(a), B = norm(b);
  let best = { lag: 0, score: -2 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0, n = 0;
    for (let i = 0; i < A.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= B.length) continue;
      s += A[i] * B[j]; n++;
    }
    // Wenig Überlappung abwerten
    const score = n > Math.min(A.length, B.length) * 0.3 ? s * Math.sqrt(Math.min(A.length, B.length) / n) : -2;
    if (score > best.score) best = { lag, score };
  }
  return best;
}

/** Kurve (Werte im Abstand hop Sekunden Dateizeit) auf ein reales Zeitraster (step Sekunden) bringen. */
export function resampleReal(values: number[], hopFile: number, factor: number, step: number): number[] {
  const realHop = hopFile * factor;
  const total = values.length * realHop;
  const out: number[] = [];
  for (let t = 0; t < total; t += step) {
    const x = t / realHop;
    const i = Math.floor(x), f = x - i;
    const v0 = values[Math.min(values.length - 1, i)] ?? 0, v1 = values[Math.min(values.length - 1, i + 1)] ?? v0;
    out.push(v0 * (1 - f) + v1 * f);
  }
  return out;
}

/** Ganze Stunden Zeitzonen-Unterschied erkennen (manche Kameras speichern Ortszeit als UTC). */
export function timezoneGuess(aStart: number, aDur: number, bStart: number, bDur: number): number {
  const overlap = (off: number) => Math.min(aStart + aDur, bStart - off + bDur) - Math.max(aStart, bStart - off);
  if (overlap(0) > 0) return 0;
  for (const h of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) if (overlap(h * 3600_000) > 0) return h * 3600_000;
  return 0;
}
