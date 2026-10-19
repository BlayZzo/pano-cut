// Bild-Assistent: Clip analysieren (sehr dunkel/hell, schwankend, Farbstich, flau) und automatisch „retten“.
import type { ColorGrade } from './types';
import type { FrameStats } from './color';

export interface Sample { t: number; stats: FrameStats }

export type Finding = 'dark' | 'veryDark' | 'bright' | 'clipped' | 'crushed' | 'varying' | 'flat' | 'castBlue' | 'castOrange' | 'castGreen' | 'castMagenta' | 'noisy' | 'log' | 'ok';

export interface Analysis {
  findings: Finding[];
  mid: number;          // mittlere Helligkeit 0..1
  evRange: number;      // Schwankung der nötigen Belichtung (Blenden)
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Benötigte Belichtung (Blenden), damit die mittlere Helligkeit „normal“ wirkt. */
function neededEv(s: FrameStats): number {
  // Ziel: Median bei ~42 % (sRGB) – in hellen Szenen etwas höher, damit Schnee/Himmel nicht grau werden
  const target = toLin(0.42);
  const cur = toLin(Math.max(0.01, s.p50));
  let ev = Math.log2(target / cur);
  // Wenn nur wenig wirklich hell ist, nicht zu stark aufhellen (Nachtszenen mit Lichtern)
  if (ev > 0 && (s.clipHi ?? 0) > 0.03) ev *= 0.75;
  return clamp(ev, -3, 3.5);
}

export function analyzeClip(samples: Sample[]): Analysis {
  const st = samples.map((x) => x.stats);
  const mid = median(st.map((s) => s.p50));
  const evs = st.map(neededEv);
  const evRange = evs.length ? Math.max(...evs) - Math.min(...evs) : 0;
  const findings: Finding[] = [];
  if (mid < 0.12) findings.push('veryDark'); else if (mid < 0.28) findings.push('dark');
  if (mid > 0.68) findings.push('bright');
  if (avg(st.map((s) => s.clipHi ?? 0)) > 0.02) findings.push('clipped');
  if (avg(st.map((s) => s.clipLo ?? 0)) > 0.12) findings.push('crushed');
  if (evRange > 0.9) findings.push('varying');
  const spread = median(st.map((s) => s.p95 - s.p05));
  const sat = avg(st.map((s) => s.meanSat));
  if (spread < 0.45) findings.push('flat');
  // Log-Material: flau, kaum Schwarz/Weiß, wenig Sättigung
  if (evRange < 0.9 && mid > 0.25 && mid < 0.6 && spread < 0.5 && median(st.map((s) => s.p05)) > 0.1 && median(st.map((s) => s.p95)) < 0.78 && sat < 0.2) findings.push('log');
  const mr = avg(st.map((s) => s.meanR)), mg = avg(st.map((s) => s.meanG)), mb = avg(st.map((s) => s.meanB));
  const a = (mr + mg + mb) / 3 || 0.001;
  const warm = (mr - mb) / a, green = (mg - (mr + mb) / 2) / a;
  if (warm < -0.18) findings.push('castBlue'); else if (warm > 0.3) findings.push('castOrange');
  if (green > 0.12) findings.push('castGreen'); else if (green < -0.12) findings.push('castMagenta');
  if (mid < 0.2) findings.push('noisy');
  if (findings.length === 0) findings.push('ok');
  return { findings, mid, evRange };
}

export interface RescueOptions {
  strength: number;     // 0..1.5
  dynamic: boolean;     // Belichtung über die Zeit angleichen
  denoise: boolean;
  color: boolean;       // Farbstich entfernen
}

export interface RescueResult {
  grade: Partial<ColorGrade>;
  denoise: number;      // 0..1 (0 = aus)
}

/** Berechnet die Rettung: feste Einstellungen + (bei schwankendem Licht) eine Belichtungskurve. */
export function rescueGrade(samples: Sample[], opts: RescueOptions): RescueResult {
  const st = samples.map((x) => x.stats);
  const k = clamp(opts.strength, 0, 1.5);
  const evs = st.map(neededEv);
  // Kurve glätten (gleitender Mittelwert), damit nichts flackert
  const smooth = evs.map((_, i) => avg(evs.slice(Math.max(0, i - 1), i + 2)));
  const evMed = median(smooth);
  const grade: Partial<ColorGrade> = {};
  grade.exposure = r2(clamp(evMed * k, -3, 3.5));
  const range = smooth.length ? Math.max(...smooth) - Math.min(...smooth) : 0;
  if (opts.dynamic && range > 0.35 && samples.length >= 2) {
    grade.exposureCurve = samples.map((s, i) => ({ t: r2(s.t), ev: r2((smooth[i] - evMed) * k) }));
  } else {
    grade.exposureCurve = undefined;
  }
  const clipHi = avg(st.map((s) => s.clipHi ?? 0));
  const p01 = median(st.map((s) => s.p01)), p99 = median(st.map((s) => s.p99));
  const mid = median(st.map((s) => s.p50));
  const spread = median(st.map((s) => s.p95 - s.p05));
  // Lichter zurückholen, Tiefen öffnen
  grade.highlights = Math.round(clamp(-(clipHi > 0.01 || p99 > 0.97 ? 45 : 15) * k - Math.max(0, evMed) * 6 * k, -80, 0));
  grade.shadows = Math.round(clamp((mid < 0.3 ? 30 : 10) * k + Math.max(0, evMed) * 5 * k, 0, 70));
  // Schwarzpunkt: flaue Bilder (angehobenes Schwarz) kräftigen
  grade.blacks = Math.round(clamp(-(Math.max(0, p01 - 0.03)) * 300 * k, -45, 0));
  grade.whites = Math.round(clamp((p99 < 0.8 ? 15 : 0) * k, 0, 25));
  grade.contrast = r2(1 + clamp((0.6 - spread) * 0.3, 0, 0.18) * k);
  grade.vibrance = Math.round(clamp((mid < 0.25 ? 22 : 12) * k, 0, 40));
  grade.dehaze = Math.round(clamp(spread < 0.45 && mid > 0.5 ? 30 * k : 0, 0, 60));
  if (opts.color) {
    const mr = avg(st.map((s) => s.meanR)), mg = avg(st.map((s) => s.meanG)), mb = avg(st.map((s) => s.meanB));
    const a = (mr + mg + mb) / 3 || 0.001;
    grade.temperature = Math.round(clamp(((mb - mr) / a) * 70 * k, -45, 45));
    grade.tint = Math.round(clamp(((mg - (mr + mb) / 2) / a) * 60 * k, -30, 30));
  }
  // Dunkles Material rauscht nach dem Aufhellen → entrauschen
  const denoise = opts.denoise && evMed > 0.8 ? r2(clamp(0.2 + evMed * 0.18, 0, 0.9) * Math.min(1, k)) : 0;
  return { grade, denoise };
}

export const FINDING_TEXT: Record<Finding, string> = {
  veryDark: 'Sehr dunkel', dark: 'Zu dunkel', bright: 'Zu hell', clipped: 'Lichter ausgefressen', crushed: 'Tiefen abgesoffen',
  varying: 'Helligkeit schwankt (z. B. Tunnel)', flat: 'Flau / wenig Kontrast', castBlue: 'Blaustich', castOrange: 'Orangestich',
  castGreen: 'Grünstich', castMagenta: 'Magentastich', noisy: 'Rauschen wahrscheinlich', log: 'Sieht nach Log-Material aus', ok: 'Sieht gut aus',
};
