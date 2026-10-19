// Farbbearbeitung: EINE Rechenvorschrift für Vorschau (WebGL-LUT) und Export (FFmpeg lut3d).
// Alle Farbeinstellungen eines Clips werden in eine 3D-Farbtabelle (LUT) „gebacken“.
import type { CameraProfile, ColorGrade } from './types';

export const LUT_SIZE = 33;

export interface LookDef { id: string; name: string; grade: Partial<ColorGrade> }

/** Fertige Looks (wie Filter in Foto-Apps). Sie werden mit „Stärke“ zur eigenen Einstellung gemischt. */
export const LOOKS: LookDef[] = [
  { id: 'warm', name: 'Warm', grade: { temperature: 30, vibrance: 10, highlights: -10 } },
  { id: 'cool', name: 'Kühl', grade: { temperature: -30, tint: -5, contrast: 1.05 } },
  { id: 'cinema', name: 'Kino', grade: { contrast: 1.15, shadows: -10, highlights: -20, saturation: 0.85, temperature: 8, tint: -6, splitShadow: -25, splitHighlight: 25 } },
  { id: 'vintage', name: 'Vintage', grade: { contrast: 0.88, saturation: 0.7, temperature: 22, brightness: 0.03, fade: 35 } },
  { id: 'vivid', name: 'Lebendig', grade: { vibrance: 45, contrast: 1.1, saturation: 1.1 } },
  { id: 'matte', name: 'Matt', grade: { fade: 45, contrast: 0.92, saturation: 0.9 } },
  { id: 'bw', name: 'Schwarzweiß', grade: { saturation: 0, contrast: 1.15 } },
  { id: 'sepia', name: 'Sepia', grade: { saturation: 0, temperature: 45, tint: 5, contrast: 1.05 } },
  { id: 'teal', name: 'Teal & Orange', grade: { splitShadow: -45, splitHighlight: 40, vibrance: 15, contrast: 1.08 } },
  { id: 'drone', name: 'Drohne (Himmel & Grün)', grade: { vibrance: 30, highlights: -25, shadows: 15, contrast: 1.05, dehaze: 25 } },
];

export function lookById(id: string | undefined): LookDef | undefined {
  return id ? LOOKS.find((l) => l.id === id) : undefined;
}

type NumericGrade = Omit<ColorGrade, 'look' | 'lookStrength' | 'lut' | 'lutStrength' | 'profile' | 'exposureCurve'>;

export const NEUTRAL: Required<NumericGrade> = {
  brightness: 0, contrast: 1, saturation: 1, hue: 0,
  exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, gamma: 1, fade: 0, dehaze: 0, splitShadow: 0, splitHighlight: 0,
};

/** Ist die Farbeinstellung neutral (dann kann der LUT-Schritt entfallen)? */
export function isNeutralGrade(g: ColorGrade): boolean {
  if (g.profile) return false;
  if (g.lut && (g.lutStrength ?? 1) > 0) return false;
  if (g.look && (g.lookStrength ?? 1) > 0) return false;
  for (const [k, v] of Object.entries(NEUTRAL)) {
    const cur = (g as unknown as Record<string, number | undefined>)[k];
    if (cur !== undefined && Math.abs(cur - v) > 1e-4) return false;
  }
  return true;
}

/** Eigene Einstellung + Look (mit Stärke) zu einer effektiven Einstellung zusammenführen. */
export function effectiveGrade(g: ColorGrade): Required<NumericGrade> {
  const out = { ...NEUTRAL } as Record<string, number>;
  for (const k of Object.keys(NEUTRAL)) {
    const v = (g as unknown as Record<string, number | undefined>)[k];
    if (v !== undefined) out[k] = v;
  }
  const look = lookById(g.look);
  if (look) {
    const s = Math.max(0, Math.min(1, g.lookStrength ?? 1));
    for (const [k, v] of Object.entries(look.grade)) {
      const neutral = (NEUTRAL as Record<string, number>)[k];
      if (neutral === undefined || typeof v !== 'number') continue;
      // multiplikative Größen multiplizieren, additive addieren
      if (k === 'contrast' || k === 'saturation' || k === 'gamma') out[k] = out[k] * (1 + (v - 1) * s);
      else out[k] = out[k] + (v - neutral) * s;
    }
  }
  return out as Required<NumericGrade>;
}

// ---------- Kamera-Profile (Log → Szenen-Linear) ----------

export const CAMERA_PROFILES: Array<{ id: CameraProfile; name: string }> = [
  { id: 'bmdfilm5', name: 'Blackmagic Film (Gen 5)' },
  { id: 'dlog', name: 'DJI D-Log' },
  { id: 'log', name: 'Flaches Profil / anderes Log' },
];

/** Log-Wert (0..1) → Szenen-linear (0.18 = mittleres Grau). */
function decodeLog(v: number, p: CameraProfile): number {
  if (p === 'bmdfilm5' || p === 'log') {
    // Blackmagic Generation 5 Film (Blackmagic Design, Gen-5-Farbwissenschaft)
    const A = 0.08692876065491224, B = 0.005494072432257808, C = 0.5300133392291939, D = 8.283605932402494, E = 0.09246575342465753;
    const logCut = D * 0.005 + E;
    const x = v < logCut ? (v - E) / D : Math.exp((v - C) / A) - B;
    return p === 'log' ? Math.pow(Math.max(0, x), 0.85) * 0.8 : x;   // „anderes Log“: etwas sanfter
  }
  // DJI D-Log (DJI White Paper)
  return v <= 0.14 ? (v - 0.0929) / 6.025 : (Math.pow(10, (v - 0.584555) / 0.256663) - 0.0108) / 0.9892;
}

/** Filmische Kurve (ACES-Näherung) für Szenen-linear → Anzeige-linear. */
function filmic(x: number): number {
  x = Math.max(0, x) * 0.6;
  return clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
}

/** Weiche Schulter, damit hochgezogene Belichtung die Lichter nicht hart abschneidet. */
function shoulder(x: number, k: number): number {
  if (x <= k) return x;
  return k + (1 - k) * Math.tanh((x - k) / (1 - k));
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Eine Farbe (sRGB 0..1) durch die Einstellungen schicken. */
export function gradePixel(r: number, g: number, b: number, e: ReturnType<typeof effectiveGrade>, profile?: CameraProfile): [number, number, number] {
  // 1) Linear: Kamera-Profil, Belichtung und Weißabgleich
  let lr: number, lg: number, lb: number;
  if (profile) { lr = decodeLog(r, profile); lg = decodeLog(g, profile); lb = decodeLog(b, profile); }
  else { lr = toLin(r); lg = toLin(g); lb = toLin(b); }
  const exp = Math.pow(2, e.exposure);
  const t = e.temperature / 100, ti = e.tint / 100;
  lr *= exp * (1 + 0.35 * t) * (1 + 0.1 * ti);
  lg *= exp * (1 - 0.25 * ti);
  lb *= exp * (1 - 0.35 * t) * (1 + 0.1 * ti);
  if (profile) {
    // Log-Material: filmische Kurve + etwas mehr Sättigung (weiter Farbraum der Kamera)
    lr = filmic(lr); lg = filmic(lg); lb = filmic(lb);
    const l = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    lr = l + (lr - l) * 1.18; lg = l + (lg - l) * 1.18; lb = l + (lb - l) * 1.18;
  } else if (e.exposure > 0.01) {
    const k = 1 - 0.25 * Math.min(1, e.exposure);
    lr = shoulder(lr, k); lg = shoulder(lg, k); lb = shoulder(lb, k);
  }
  r = clamp01(toSrgb(lr)); g = clamp01(toSrgb(lg)); b = clamp01(toSrgb(lb));

  // 2) Tonwerte: Schwarz/Weiß-Punkt, Tiefen/Lichter, Mitteltöne (Gamma), Dunst, Kontrast, Helligkeit
  const tone = (c: number, l: number) => {
    // Weiß/Schwarz-Punkt
    const bp = -e.blacks / 400, wp = 1 - e.whites / 400;
    c = (c - bp) / Math.max(0.05, wp - bp);
    // Tiefen und Lichter (abhängig von der Helligkeit des Pixels)
    const sh = e.shadows / 100, hi = e.highlights / 100;
    c += sh * 0.35 * (1 - smooth(0, 0.55, l)) * (sh > 0 ? (1 - c) : c);
    c += hi * 0.35 * smooth(0.45, 1, l) * (hi > 0 ? (1 - c) : c);
    // Mitteltöne
    if (Math.abs(e.gamma - 1) > 1e-4) c = Math.pow(clamp01(c), 1 / e.gamma);
    // Dunst entfernen (lokaler Kontrast vereinfacht: Schwarzpunkt anheben + Kontrast)
    if (e.dehaze) { const d = e.dehaze / 100; c = (c - 0.08 * d) / (1 - 0.08 * d); c = (c - 0.5) * (1 + 0.25 * d) + 0.5; }
    // Kontrast und Helligkeit (wie bisher)
    c = (c - 0.5) * e.contrast + 0.5 + e.brightness;
    // Verblassen (Schwarz anheben)
    if (e.fade) { const f = e.fade / 100 * 0.18; c = f + c * (1 - f * 0.6); }
    return c;
  };
  const l0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = tone(r, l0); g = tone(g, l0); b = tone(b, l0);

  // 3) Split-Toning (Tiefen/Lichter einfärben: negativ = blau/grün, positiv = orange)
  if (e.splitShadow || e.splitHighlight) {
    const l = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const ws = (1 - smooth(0, 0.5, l)) * e.splitShadow / 100 * 0.12;
    const wh = smooth(0.5, 1, l) * e.splitHighlight / 100 * 0.12;
    const w = ws + wh;
    r += w; g += w * 0.25; b -= w;
  }

  // 4) Farbton, Sättigung, Dynamik
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (Math.abs(e.hue) > 1e-4) {
    const a = (e.hue * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    // Drehung um die Graue-Achse (YIQ)
    const yv = 0.299 * r + 0.587 * g + 0.114 * b;
    const iv = 0.596 * r - 0.274 * g - 0.322 * b;
    const qv = 0.211 * r - 0.523 * g + 0.312 * b;
    const i2 = iv * cs - qv * sn, q2 = iv * sn + qv * cs;
    r = yv + 0.956 * i2 + 0.621 * q2; g = yv - 0.272 * i2 - 0.647 * q2; b = yv - 1.106 * i2 + 1.703 * q2;
  }
  let sat = e.saturation;
  if (e.vibrance) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const curSat = mx > 1e-4 ? (mx - mn) / mx : 0;
    sat *= 1 + (e.vibrance / 100) * (1 - curSat) * 0.8;
  }
  const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = l2 + (r - l2) * sat; g = l2 + (g - l2) * sat; b = l2 + (b - l2) * sat;
  void lum;
  return [clamp01(r), clamp01(g), clamp01(b)];
}

// ---------- 3D-LUT ----------

export interface Lut3D { size: number; data: Float32Array } // RGB, r läuft am schnellsten (wie .cube)

/** .cube-Datei (Adobe/Resolve-Format) einlesen. */
export function parseCube(text: string): Lut3D {
  let size = 0;
  const vals: number[] = [];
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') { size = parseInt(parts[1], 10); continue; }
    if (parts[0] === 'DOMAIN_MIN') { dmin = parts.slice(1, 4).map(Number); continue; }
    if (parts[0] === 'DOMAIN_MAX') { dmax = parts.slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]+$/.test(parts[0])) continue; // TITLE, LUT_1D_SIZE …
    if (parts.length >= 3) for (let i = 0; i < 3; i++) vals.push(Number(parts[i]));
  }
  if (!size || vals.length < size * size * size * 3) throw new Error('Ungültige .cube-Datei (nur 3D-LUTs werden unterstützt).');
  const data = new Float32Array(size * size * size * 3);
  for (let i = 0; i < data.length; i++) {
    const c = i % 3;
    data[i] = (vals[i] - dmin[c]) / Math.max(1e-6, dmax[c] - dmin[c]);
  }
  return { size, data };
}

/** Trilineare Abfrage einer LUT. */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size - 1;
  const fr = clamp01(r) * n, fg = clamp01(g) * n, fb = clamp01(b) * n;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(n, r0 + 1), g1 = Math.min(n, g0 + 1), b1 = Math.min(n, b0 + 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const S = lut.size;
  const at = (ri: number, gi: number, bi: number, c: number) => lut.data[((bi * S + gi) * S + ri) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
    const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
    const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
    const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
    out[c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
  }
  return out;
}

/** Alle Farbeinstellungen eines Clips zu einer LUT backen (optional mit eigener .cube-LUT). */
export function bakeGradeLut(g: ColorGrade, userLut?: Lut3D | null, size = LUT_SIZE): Lut3D {
  const e = effectiveGrade(g);
  const data = new Float32Array(size * size * size * 3);
  const us = Math.max(0, Math.min(1, g.lutStrength ?? 1));
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        let [r, gg, b] = gradePixel(ri / (size - 1), gi / (size - 1), bi / (size - 1), e, g.profile);
        if (userLut && us > 0) {
          const [ur, ug, ub] = sampleLut(userLut, r, gg, b);
          r = r + (ur - r) * us; gg = gg + (ug - gg) * us; b = b + (ub - b) * us;
        }
        data[i++] = r; data[i++] = gg; data[i++] = b;
      }
    }
  }
  return { size, data };
}

export function lutToCube(lut: Lut3D, title = 'PanoCut'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${lut.size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** Schlüssel, der sich ändert, sobald sich etwas an der Farbe ändert (für Caches). */
export function gradeKey(g: ColorGrade): string {
  return JSON.stringify([effectiveGrade(g), g.lut ?? '', g.lutStrength ?? 1, g.profile ?? '']);
}

// ---------- Belichtung über die Zeit ----------
// Die LUT wird mit der höchsten Belichtung der Kurve gebacken; davor dunkelt ein zeitabhängiger Faktor (≤ 1) ab.
// So wird vor der LUT nie etwas abgeschnitten. Faktor auf Gamma-Werten: 2^(Δev/2.2) ≈ lineare Belichtung.

export function hasExposureCurve(g: ColorGrade): boolean {
  const c = g.exposureCurve;
  if (!c || c.length < 2) return false;
  const evs = c.map((k) => k.ev);
  return Math.max(...evs) - Math.min(...evs) > 0.05;
}

export function exposureCurvePeak(g: ColorGrade): number {
  return hasExposureCurve(g) ? Math.max(...g.exposureCurve!.map((k) => k.ev)) : 0;
}

/** Farbeinstellung für die LUT (inkl. Spitze der Belichtungskurve). */
export function gradeForLut(g: ColorGrade): ColorGrade {
  const peak = exposureCurvePeak(g);
  if (!peak && !g.exposureCurve) return g;
  return { ...g, exposure: (g.exposure ?? 0) + peak, exposureCurve: undefined };
}

/** Belichtungs-Offset der Kurve zur Clip-Zeit t (lineare Interpolation, außerhalb festgehalten). */
export function exposureAt(g: ColorGrade, t: number): number {
  const c = g.exposureCurve;
  if (!c || c.length === 0) return 0;
  if (t <= c[0].t) return c[0].ev;
  for (let i = 0; i < c.length - 1; i++) {
    if (t <= c[i + 1].t) { const u = (t - c[i].t) / Math.max(1e-6, c[i + 1].t - c[i].t); return c[i].ev + (c[i + 1].ev - c[i].ev) * u; }
  }
  return c[c.length - 1].ev;
}

/** Faktor vor der LUT zur Clip-Zeit t (≤ 1). Zwischen den Punkten wird der Faktor linear interpoliert (wie im Export). */
export function exposureGainAt(g: ColorGrade, t: number): number {
  if (!hasExposureCurve(g)) return 1;
  const c = g.exposureCurve!;
  const peak = exposureCurvePeak(g);
  const gain = (ev: number) => Math.pow(2, (ev - peak) / 2.2);
  if (t <= c[0].t) return gain(c[0].ev);
  for (let i = 0; i < c.length - 1; i++) {
    if (t <= c[i + 1].t) { const u = (t - c[i].t) / Math.max(1e-6, c[i + 1].t - c[i].t); return gain(c[i].ev) + (gain(c[i + 1].ev) - gain(c[i].ev)) * u; }
  }
  return gain(c[c.length - 1].ev);
}

// ---------- Automatisch verbessern ----------

export interface FrameStats {
  p01: number; p05: number; p50: number; p95: number; p99: number; // Helligkeits-Perzentile 0..1
  meanR: number; meanG: number; meanB: number;                       // Mittelwerte (Graue-Welt)
  meanSat: number;                                                   // mittlere Sättigung 0..1
  clipHi?: number;                                                   // Anteil fast weißer Pixel
  clipLo?: number;                                                   // Anteil fast schwarzer Pixel
  hist?: Uint32Array;                                                // Helligkeits-Histogramm (256)
}

export function frameStats(rgba: Uint8ClampedArray | Uint8Array): FrameStats {
  const hist = new Uint32Array(256);
  let sr = 0, sg = 0, sb = 0, ss = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4 * 3) { // jedes dritte Pixel reicht
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[l]++;
    sr += r; sg += g; sb += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    ss += mx > 0 ? (mx - mn) / mx : 0;
    n++;
  }
  const pct = (p: number) => { let acc = 0; const target = n * p; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; } return 1; };
  let hi = 0, lo = 0;
  for (let i = 250; i < 256; i++) hi += hist[i];
  for (let i = 0; i < 6; i++) lo += hist[i];
  return { p01: pct(0.01), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), meanR: sr / n / 255, meanG: sg / n / 255, meanB: sb / n / 255, meanSat: ss / n, clipHi: hi / n, clipLo: lo / n, hist };
}

/** Aus Bildstatistiken eine natürliche Verbesserung ableiten (sanft, keine Effekthascherei). */
export function autoEnhance(stats: FrameStats[]): Partial<ColorGrade> {
  if (stats.length === 0) return {};
  const avg = (k: 'p01' | 'p05' | 'p50' | 'p95' | 'p99' | 'meanR' | 'meanG' | 'meanB' | 'meanSat') => stats.reduce((a, s) => a + s[k], 0) / stats.length;
  const p01 = avg('p01'), p50 = avg('p50'), p99 = avg('p99');
  const mr = avg('meanR'), mg = avg('meanG'), mb = avg('meanB'), sat = avg('meanSat');
  const out: Partial<ColorGrade> = {};
  // Belichtung: Mittelwert Richtung 0.45 ziehen (max. ±1 Blende)
  const targetMid = 0.45;
  const exp = Math.log2(Math.max(0.05, toLin(targetMid)) / Math.max(0.01, toLin(Math.max(0.02, p50))));
  out.exposure = round2(Math.max(-1, Math.min(1, exp * 0.6)));
  // Schwarz- und Weißpunkt spreizen, wenn das Bild flau ist
  out.blacks = Math.round(Math.max(-30, Math.min(30, (0.02 - p01) * -400 * 0.6)));
  out.whites = Math.round(Math.max(-30, Math.min(30, (p99 - 0.97) * -400 * 0.6)));
  // Lichter zurückholen, Tiefen aufhellen, wenn es dort eng wird
  out.highlights = p99 > 0.97 ? -25 : 0;
  out.shadows = p01 < 0.02 && p50 < 0.35 ? 20 : 0;
  // Weißabgleich (Graue-Welt, nur teilweise)
  const avgRGB = (mr + mg + mb) / 3;
  const warmCold = (mb - mr) / Math.max(0.05, avgRGB); // >0 = zu blau
  out.temperature = Math.round(Math.max(-35, Math.min(35, warmCold * 60)));
  const magentaGreen = (mg - (mr + mb) / 2) / Math.max(0.05, avgRGB); // >0 = zu grün
  out.tint = Math.round(Math.max(-25, Math.min(25, magentaGreen * 50)));
  // Dynamik bei flauen Farben
  out.vibrance = sat < 0.25 ? 25 : sat < 0.4 ? 12 : 0;
  out.contrast = round2(1 + Math.max(0, Math.min(0.12, (0.85 - (p99 - p01)) * 0.25)));
  return out;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
