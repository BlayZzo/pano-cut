// Mehrkamera: Kameras über den Ton synchronisieren und aus einer Schnittliste Clips erzeugen.
import type { Clip, MediaItem, MulticamGroup, Project } from './types';
import { fft } from './beats';
import { clipDuration } from './timeline';

/**
 * Versatz zwischen zwei Ton-Hüllkurven per Kreuzkorrelation (FFT).
 * Ergebnis: lag in Sekunden, so dass b(t) ≈ a(t + lag) – also: Ereignis bei a-Zeit x liegt bei b-Zeit x − lag.
 * confidence 0..1: wie deutlich die beste Stelle gegenüber der zweitbesten heraussticht.
 */
export function correlateEnvelopes(a: ArrayLike<number>, b: ArrayLike<number>, hop: number, maxLagSec = 900): { lag: number; confidence: number } {
  const na = a.length, nb = b.length;
  if (na < 8 || nb < 8) return { lag: 0, confidence: 0 };
  let n = 1;
  while (n < na + nb) n <<= 1;
  const prep = (x: ArrayLike<number>) => {
    // Mittelwert abziehen und weich begrenzen (laute Einzelereignisse sollen nicht alles bestimmen)
    let m = 0; for (let i = 0; i < x.length; i++) m += x[i];
    m /= x.length;
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < x.length; i++) re[i] = Math.tanh((x[i] - m) / 3);
    return { re, im };
  };
  const A = prep(a), B = prep(b);
  fft(A.re, A.im); fft(B.re, B.im);
  // A · conj(B) → Korrelation c[k] = Σ a[i+k]·b[i]
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = A.re[i] * B.re[i] + A.im[i] * B.im[i];
    im[i] = A.im[i] * B.re[i] - A.re[i] * B.im[i];
  }
  // inverse FFT über konjugierte Eingabe
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const corr = (k: number) => re[((k % n) + n) % n] / n;
  const maxLag = Math.min(Math.round(maxLagSec / hop), n / 2 - 1);
  let best = 0, bestV = -Infinity;
  for (let k = -Math.min(maxLag, nb - 1); k <= Math.min(maxLag, na - 1); k++) {
    // Überlappung berücksichtigen (sonst gewinnen große Überlappungen automatisch)
    const overlap = Math.min(na, nb + k) - Math.max(0, k);
    if (overlap < Math.min(na, nb) * 0.15 || overlap < 40) continue;
    const v = corr(k) / Math.sqrt(overlap);
    if (v > bestV) { bestV = v; best = k; }
  }
  // zweitbeste Spitze außerhalb ±1 s
  let second = 0;
  const excl = Math.round(1 / hop);
  for (let k = -Math.min(maxLag, nb - 1); k <= Math.min(maxLag, na - 1); k++) {
    if (Math.abs(k - best) < excl) continue;
    const overlap = Math.min(na, nb + k) - Math.max(0, k);
    if (overlap < Math.min(na, nb) * 0.15 || overlap < 40) continue;
    second = Math.max(second, corr(k) / Math.sqrt(overlap));
  }
  // Parabel-Verfeinerung zwischen den Nachbarn
  const y0 = corr(best - 1), y1 = corr(best), y2 = corr(best + 1);
  const den = y0 - 2 * y1 + y2;
  const frac = Math.abs(den) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  const confidence = bestV > 0 ? Math.max(0, Math.min(1, 1 - second / bestV)) : 0;
  return { lag: (best + frac) * hop, confidence };
}

/** Kamera-Einstellungen als Vorlage: alles Zeitabhängige weglassen. */
export function angleTemplate(c: Clip): Clip {
  const t: Clip = { ...c, transition: undefined, motion: undefined, subtitles: undefined, objects: undefined, cutout: undefined, attach: undefined, link: undefined, mc: undefined, fadeIn: 0, fadeOut: 0, speed: 1, reverse: false };
  if (t.pano && t.pano.keyframes.length > 1) t.pano = { ...t.pano, keyframes: [{ ...t.pano.keyframes[0], t: 0 }] };
  if (t.color.exposureCurve) t.color = { ...t.color, exposureCurve: undefined };
  return t;
}

/** Ist Kamera `i` zur Gruppen-Zeit g verfügbar? */
function available(g: MulticamGroup, i: number, t: number, media: Record<string, MediaItem>): boolean {
  const a = g.angles[i];
  const d = media[a.mediaId]?.info.duration ?? 0;
  return t >= a.shift - 1e-6 && t <= a.shift + d + 1e-6;
}

/** Schnittliste aufräumen: sortiert, erster Schnitt bei 0, keine doppelten Kameras hintereinander. */
export function normalizeCuts(cuts: MulticamGroup['cuts'], duration: number): MulticamGroup['cuts'] {
  const s = [...cuts].filter((c) => c.t < duration - 0.02).sort((a, b) => a.t - b.t);
  const out: MulticamGroup['cuts'] = [];
  for (const c of s) {
    const t = Math.max(0, c.t);
    if (out.length && Math.abs(out[out.length - 1].t - t) < 0.02) { out[out.length - 1] = { t: out[out.length - 1].t, angle: c.angle }; continue; }
    if (out.length && out[out.length - 1].angle === c.angle) continue;
    out.push({ t, angle: c.angle });
  }
  if (out.length === 0 || out[0].t > 0.001) out.unshift({ t: 0, angle: out[0]?.angle ?? 0 });
  // nach dem Einfügen bei 0 erneut doppelte zusammenfassen
  return out.filter((c, i) => i === 0 || c.angle !== out[i - 1].angle);
}

/** Kamera zur Gruppen-Zeit t (aus der Schnittliste). */
export function angleAt(g: MulticamGroup, t: number): number {
  let a = g.cuts[0]?.angle ?? 0;
  for (const c of g.cuts) { if (c.t <= t + 1e-6) a = c.angle; else break; }
  return a;
}

/**
 * Kamera ab Zeit t umschalten. Live (während der Wiedergabe): neuer Schnitt bei t.
 * Angehalten: das ganze Stück unter dem Abspielkopf bekommt die neue Kamera.
 */
export function switchAngle(g: MulticamGroup, t: number, angle: number, live: boolean): MulticamGroup['cuts'] {
  const cuts = [...g.cuts];
  if (live) return normalizeCuts([...cuts.filter((c) => Math.abs(c.t - t) > 0.02), { t, angle }], g.duration);
  let idx = 0;
  for (let i = 0; i < cuts.length; i++) if (cuts[i].t <= t + 1e-6) idx = i;
  cuts[idx] = { ...cuts[idx], angle };
  return normalizeCuts(cuts, g.duration);
}

/** Clips der Gruppe erzeugen: Bildstücke auf der Videospur, Ton der gewählten Kamera auf der Tonspur. */
export function buildMulticamClips(g: MulticamGroup, project: Project): Clip[] {
  const media = project.media;
  const out: Clip[] = [];
  const bounds = g.cuts.map((c) => c.t).concat([g.duration]);
  // 1) Abschnitte mit tatsächlich verfügbarer Kamera bestimmen
  const parts: Array<{ s0: number; s1: number; ang: number }> = [];
  for (let i = 0; i < g.cuts.length; i++) {
    const want = g.cuts[i].angle;
    const a = bounds[i], b = bounds[i + 1];
    if (b - a < 0.02) continue;
    // Abschnitt teilen, wo eine Kamera beginnt/endet (die gewünschte läuft dort evtl. noch nicht)
    const pts = new Set<number>([a, b]);
    for (const an of g.angles) {
      const d = media[an.mediaId]?.info.duration ?? 0;
      for (const x of [an.shift, an.shift + d]) if (x > a + 0.02 && x < b - 0.02) pts.add(x);
    }
    const ps = [...pts].sort((x, y) => x - y);
    for (let k = 0; k < ps.length - 1; k++) {
      const s0 = ps[k], s1 = ps[k + 1];
      const mid = (s0 + s1) / 2;
      let ang = available(g, want, mid, media) ? want : -1;
      if (ang < 0) ang = g.angles.findIndex((_, j) => available(g, j, mid, media));
      if (ang < 0) continue;
      const last = parts[parts.length - 1];
      // gleiche Kamera direkt hintereinander → ein Stück
      if (last && last.ang === ang && Math.abs(last.s1 - s0) < 1e-6) last.s1 = s1;
      else parts.push({ s0, s1, ang });
    }
  }
  // 2) Clips daraus bauen
  for (const { s0, s1, ang } of parts) {
    const an = g.angles[ang];
    out.push({
      ...an.template,
      id: `mcp_${g.id}_${Math.round(s0 * 1000)}_${ang}`,
      trackId: g.trackId,
      mediaId: an.mediaId,
      name: `${an.name}`,
      start: g.start + s0,
      in: s0 - an.shift,
      out: s1 - an.shift,
      muted: true,
      mc: { groupId: g.id, angle: ang },
    });
  }
  // Ton
  const au = g.angles[g.audioAngle];
  if (au && media[au.mediaId]?.info.hasAudio) {
    const d = media[au.mediaId].info.duration;
    const s0 = Math.max(0, au.shift), s1 = Math.min(g.duration, au.shift + d);
    if (s1 - s0 > 0.05) {
      out.push({
        ...au.template,
        id: `mca_${g.id}`,
        trackId: g.audioTrackId,
        mediaId: au.mediaId,
        name: `Ton: ${au.name}`,
        start: g.start + s0,
        in: s0 - au.shift,
        out: s1 - au.shift,
        muted: false,
        volume: au.template.volume || 1,
        mc: { groupId: g.id, angle: -1 },
      });
    }
  }
  return out;
}

/**
 * Automatisch zwischen den Kameras wechseln: auf Taktschläge (falls vorhanden) oder alle paar Sekunden.
 * Wählt jeweils eine andere verfügbare Kamera (deterministisch, damit es wiederholbar ist).
 */
export function autoSwitchCuts(g: MulticamGroup, project: Project, times: number[]): MulticamGroup['cuts'] {
  const media = project.media;
  const pts = times.length ? times : Array.from({ length: Math.floor(g.duration / 3.5) }, (_, i) => (i + 1) * 3.5);
  const cuts: MulticamGroup['cuts'] = [];
  let cur = g.cuts[0]?.angle ?? 0;
  cuts.push({ t: 0, angle: cur });
  let k = 0;
  for (const t of pts) {
    if (t <= 0.3 || t >= g.duration - 0.3) continue;
    const cand = g.angles.map((_, i) => i).filter((i) => i !== cur && available(g, i, t + 0.1, media));
    if (cand.length === 0) continue;
    // abwechselnd, mit leichtem „Zufall“ aus der Position
    cur = cand[(k++ * 7 + Math.floor(t * 13)) % cand.length];
    cuts.push({ t, angle: cur });
  }
  return normalizeCuts(cuts, g.duration);
}

/** Länge eines Clips auf der Gruppenzeitachse (für das Erstellen). */
export function clipSpan(c: Clip): number { return clipDuration(c); }
