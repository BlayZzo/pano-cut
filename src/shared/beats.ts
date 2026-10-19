// Takterkennung (Beat-Tracking) für den Auto-Musik-Schnitt – reine Rechnung ohne Abhängigkeiten.
// Ablauf: Spektraler Fluss → Tempo per Autokorrelation → Schläge per dynamischer Programmierung (nach D. Ellis, 2007).

export interface BeatInfo {
  bpm: number;
  beats: number[];       // Zeitpunkte der Schläge (Sekunden in der Datei)
  downbeats: number[];   // erster Schlag jedes Takts (4/4 angenommen)
  energy: number[];      // Lautstärke je Schlag 0..1 (für „Schnitte nach Energie“)
}

/** In-place-FFT (Radix 2). re/im Länge = Zweierpotenz. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Mel-Filterbank (Dreiecke) für `bins` FFT-Bins bei Abtastrate `sr`. */
function melBank(bins: number, sr: number, bands: number): { lo: number; hi: number; w: Float32Array }[] {
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const inv = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);
  const top = mel(Math.min(11025, sr / 2));
  const pts = Array.from({ length: bands + 2 }, (_, i) => inv((top * i) / (bands + 1)));
  const binHz = sr / 2 / (bins - 1);
  const out: { lo: number; hi: number; w: Float32Array }[] = [];
  for (let b = 0; b < bands; b++) {
    const f0 = pts[b], f1 = pts[b + 1], f2 = pts[b + 2];
    const lo = Math.max(0, Math.floor(f0 / binHz)), hi = Math.min(bins - 1, Math.ceil(f2 / binHz));
    const w = new Float32Array(hi - lo + 1);
    for (let k = lo; k <= hi; k++) {
      const f = k * binHz;
      w[k - lo] = f <= f1 ? Math.max(0, (f - f0) / Math.max(1e-6, f1 - f0)) : Math.max(0, (f2 - f) / Math.max(1e-6, f2 - f1));
    }
    out.push({ lo, hi, w });
  }
  return out;
}

/**
 * Onset-Stärke wie bei librosa: Mel-Spektrum in dB, positive Änderung gemittelt über die Bänder.
 * Fenster sind zentriert (Bild f ↔ Zeit f·hop). Liefert außerdem die Lautstärke je Bild.
 */
export function onsetEnvelope(samples: Float32Array, sr: number): { env: Float32Array; low: Float32Array; high: Float32Array; rms: Float32Array; hop: number } {
  const N = 2048, H = 512, BANDS = 64;
  const frames = Math.max(0, Math.floor(samples.length / H) + 1);
  const env = new Float32Array(frames);
  const low = new Float32Array(frames);
  const high = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bins = N / 2 + 1;
  const bank = melBank(bins, sr, BANDS);
  // Bässe (Bassdrum, Bass) bis ca. 180 Hz – für die Takt-Eins
  const binHz = sr / N;
  const lowBands = Math.max(2, bank.filter((b) => ((b.lo + b.hi) / 2) * binHz < 180).length);
  // Höhen (Snare, Becken) ab ca. 2 kHz
  const highFrom = Math.min(BANDS - 2, bank.findIndex((b) => ((b.lo + b.hi) / 2) * binHz >= 2000));
  const spec = new Float32Array(frames * BANDS);
  const re = new Float32Array(N), im = new Float32Array(N);
  let maxDb = -Infinity;
  for (let f = 0; f < frames; f++) {
    const c = f * H - N / 2;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const j = c + i;
      const v = j >= 0 && j < samples.length ? samples[j] : 0;
      re[i] = v * win[i]; im[i] = 0; e += v * v;
    }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const { lo, w } = bank[b];
      let p = 0;
      for (let k = 0; k < w.length; k++) { const q = lo + k; p += w[k] * (re[q] * re[q] + im[q] * im[q]); }
      const db = 10 * Math.log10(Math.max(1e-10, p));
      spec[f * BANDS + b] = db;
      if (db > maxDb) maxDb = db;
    }
  }
  const floor = maxDb - 80;
  for (let i = 0; i < spec.length; i++) if (spec[i] < floor) spec[i] = floor;
  for (let f = 1; f < frames; f++) {
    let s = 0;
    let sl = 0, sh = 0;
    for (let b = 0; b < BANDS; b++) {
      const d = spec[f * BANDS + b] - spec[(f - 1) * BANDS + b];
      if (d > 0) { s += d; if (b < lowBands) sl += d; else if (b >= highFrom) sh += d; }
    }
    env[f] = s / BANDS;
    low[f] = sl / lowBands;
    high[f] = sh / (BANDS - highFrom);
  }
  // Gleichanteil entfernen (gleitendes Mittel über ~0,5 s) und auf Standardabweichung normieren
  const w = Math.max(1, Math.round((0.5 * sr) / H));
  const out = new Float32Array(frames);
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    sum += env[i];
    if (i >= w) sum -= env[i - w];
    out[i] = Math.max(0, env[i] - sum / Math.min(i + 1, w));
  }
  let m = 0, q = 0;
  for (const v of out) { m += v; q += v * v; }
  m /= Math.max(1, frames);
  const sd = Math.sqrt(Math.max(1e-12, q / Math.max(1, frames) - m * m));
  for (let i = 0; i < frames; i++) out[i] /= sd;
  for (const arr of [low, high]) {
    let lm = 1e-9;
    for (const v of arr) lm = Math.max(lm, v);
    for (let i = 0; i < frames; i++) arr[i] /= lm;
  }
  return { env: out, low, high, rms, hop: H / sr };
}

/** Tempo (Schlag-Abstand in Hops) per Autokorrelation, bevorzugt um 120 BPM. */
function estimatePeriod(env: Float32Array, hop: number): number {
  const minLag = Math.max(1, Math.round(60 / 190 / hop)), maxLag = Math.round(60 / 60 / hop);
  let best = minLag, bestScore = -Infinity;
  const n = env.length;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (n - lag);
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hop);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    // auch das Doppelte des Abstands soll passen (stabileres Tempo)
    const score = (ac[lag] + 0.5 * (ac[Math.min(maxLag + 1, lag * 2)] ?? 0)) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // Parabel-Verfeinerung
  const a = ac[best - 1] ?? ac[best], b = ac[best], c = ac[best + 1] ?? ac[best];
  const d = a - 2 * b + c;
  const shift = Math.abs(d) > 1e-12 ? 0.5 * (a - c) / d : 0;
  return best + Math.max(-0.5, Math.min(0.5, shift));
}

/** Schläge finden (dynamische Programmierung mit Tempo-Strafe). */
export function trackBeats(env: Float32Array, rms: Float32Array, hop: number, low?: Float32Array, high?: Float32Array): BeatInfo {
  const n = env.length;
  if (n < 10) return { bpm: 0, beats: [], downbeats: [], energy: [] };
  const P = estimatePeriod(env, hop);
  const alpha = 100;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0, bestI = -1;
    const lo = Math.max(0, Math.round(t - 2 * P)), hi = Math.round(t - P / 2);
    for (let i = lo; i <= hi; i++) {
      const pen = Math.log((t - i) / P);
      const v = score[i] - alpha * pen * pen;
      if (bestI < 0 || v > best) { best = v; bestI = i; }
    }
    score[t] = env[t] + (bestI >= 0 ? Math.max(0, best) : 0);
    back[t] = bestI >= 0 && best > 0 ? bestI : -1;
  }
  // Ende: bester Wert in der letzten Periode
  let end = n - 1;
  for (let t = Math.max(0, Math.round(n - P)); t < n; t++) if (score[t] > score[end]) end = t;
  const idx: number[] = [];
  for (let t = end; t >= 0; t = back[t]) { idx.push(t); if (back[t] < 0) break; }
  idx.reverse();
  // Lücken am Anfang mit der Periode auffüllen (Intro ohne Schlagzeug)
  while (idx.length && idx[0] - P > 0) idx.unshift(Math.round(idx[0] - P));
  // Stille am Anfang und Ende weglassen
  let maxRms = 1e-9;
  for (const v of rms) maxRms = Math.max(maxRms, v);
  const silent = (i: number) => {
    let m = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) m = Math.max(m, rms[k]);
    return m < maxRms * 0.02;
  };
  while (idx.length && silent(idx[0])) idx.shift();
  while (idx.length && silent(idx[idx.length - 1])) idx.pop();
  if (idx.length === 0) return { bpm: 0, beats: [], downbeats: [], energy: [] };
  // Die Onset-Spitze liegt systematisch ~15 ms vor dem hörbaren Schlag (Fensterlänge) → leicht korrigieren
  const beats = idx.map((i) => Math.max(0, i * hop + 0.01));
  // Lautstärke je Schlag (relativ)
  const maxR = maxRms;
  const energy = idx.map((i) => {
    let s = 0, c = 0;
    for (let k = i; k < Math.min(n, i + Math.round(P)); k++) { s += rms[k]; c++; }
    return c ? s / c / maxR : 0;
  });
  // Taktanfang: Phase (0..3), auf der die Bässe am stärksten einsetzen (Bassdrum auf 1 und 3, Snare auf 2 und 4)
  const peak = (arr: Float32Array, i: number) => {
    let m = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(arr.length - 1, i + 2); k++) m = Math.max(m, arr[k]);
    return m;
  };
  let phase = 0, bestPhase = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0, c = 0;
    for (let k = p; k < idx.length; k += 4) {
      const l = low ? peak(low, idx[k]) : 0;
      const h = high ? peak(high, idx[k]) : 0;
      s += l - h + 0.3 * energy[k];
      c++;
    }
    s /= Math.max(1, c);
    if (s > bestPhase + 1e-6) { bestPhase = s; phase = p; }
  }
  const downbeats = beats.filter((_, k) => k % 4 === phase);
  return { bpm: Math.round((60 / (P * hop)) * 10) / 10, beats, downbeats, energy };
}

/** Schnittpunkte aus den Schlägen: alle n Schläge oder nach Energie (laut → schneller). */
export function cutPoints(info: BeatInfo, start: number, end: number, mode: 'beat' | 'beat2' | 'bar' | 'energy'): number[] {
  const inRange = info.beats.map((t, i) => ({ t, i })).filter((b) => b.t >= start - 1e-3 && b.t <= end + 1e-3);
  if (inRange.length === 0) return [];
  if (mode === 'bar') {
    const set = new Set(info.downbeats.map((x) => x.toFixed(4)));
    const pts = inRange.filter((b) => set.has(b.t.toFixed(4))).map((b) => b.t);
    return pts.length ? pts : inRange.filter((_, k) => k % 4 === 0).map((b) => b.t);
  }
  if (mode === 'beat') return inRange.map((b) => b.t);
  if (mode === 'beat2') return inRange.filter((_, k) => k % 2 === 0).map((b) => b.t);
  // Energie: leise Stellen alle 4, mittlere alle 2, laute jeden Schlag
  const out: number[] = [];
  let k = 0;
  while (k < inRange.length) {
    out.push(inRange[k].t);
    const e = info.energy[inRange[k].i] ?? 0.5;
    k += e > 0.7 ? 1 : e > 0.45 ? 2 : 4;
  }
  return out;
}

/** Tempo verdoppeln (Zwischenschläge einfügen) oder halbieren (jeden zweiten Schlag). */
export function changeTempo(info: BeatInfo, factor: 2 | 0.5): BeatInfo {
  if (info.beats.length < 2) return info;
  if (factor === 0.5) {
    // Hälfte behalten, die mehr Taktanfänge enthält
    const db = new Set(info.downbeats.map((x) => x.toFixed(4)));
    const even = info.beats.filter((_, i) => i % 2 === 0), odd = info.beats.filter((_, i) => i % 2 === 1);
    const pick = odd.filter((b) => db.has(b.toFixed(4))).length > even.filter((b) => db.has(b.toFixed(4))).length ? 1 : 0;
    const beats = info.beats.filter((_, i) => i % 2 === pick);
    const energy = info.energy.filter((_, i) => i % 2 === pick);
    const downbeats = beats.filter((_, k) => k % 4 === 0);
    return { bpm: Math.round(info.bpm * 5) / 10, beats, downbeats, energy };
  }
  const beats: number[] = [], energy: number[] = [];
  for (let i = 0; i < info.beats.length; i++) {
    beats.push(info.beats[i]); energy.push(info.energy[i] ?? 0.5);
    if (i + 1 < info.beats.length) { beats.push((info.beats[i] + info.beats[i + 1]) / 2); energy.push(info.energy[i] ?? 0.5); }
  }
  const db = new Set(info.downbeats.map((x) => x.toFixed(4)));
  const first = Math.max(0, beats.findIndex((b) => db.has(b.toFixed(4))));
  const downbeats = beats.filter((_, k) => k >= first && (k - first) % 8 === 0);
  return { bpm: Math.round(info.bpm * 20) / 10, beats, downbeats, energy };
}

/** Taktmarken eines Clips in Timeline-Zeit (berücksichtigt In/Out, Tempo, Rückwärts). */
export function beatsOnTimeline(info: BeatInfo, clip: { start: number; in: number; out: number; speed: number; reverse: boolean }, which: 'beats' | 'downbeats' = 'beats'): number[] {
  const src = which === 'beats' ? info.beats : info.downbeats;
  const out: number[] = [];
  for (const b of src) {
    if (b < clip.in - 1e-6 || b > clip.out + 1e-6) continue;
    const local = clip.reverse ? (clip.out - b) / clip.speed : (b - clip.in) / clip.speed;
    out.push(clip.start + local);
  }
  return clip.reverse ? out.reverse() : out;
}
