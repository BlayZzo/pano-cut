// Sound-Effekte, komplett selbst erzeugt (keine Downloads, keine Lizenzen): kleine Klangsynthese in reinem TypeScript.
// Jeder Effekt ist eine Funktion (Abtastrate, Zufall, Einstellungen) → Stereo-Samples. Der Hauptprozess schreibt daraus WAV-Dateien.

export type SfxCategory = 'transition' | 'impact' | 'car' | 'ui' | 'mood';

export interface SfxParams {
  length: number;   // 0.5..2 (Faktor auf die Standardlänge)
  pitch: number;    // -12..12 Halbtöne
  intensity: number; // 0.3..1.5 (Stärke/Härte)
  seed: number;
}

export const DEFAULT_SFX_PARAMS: SfxParams = { length: 1, pitch: 0, intensity: 1, seed: 1 };

export interface SfxDef {
  id: string;
  name: string;
  category: SfxCategory;
  icon: string;
  duration: number; // Sekunden bei length = 1
  render: (c: SynthCtx) => void;
}

export const SFX_CATEGORIES: Array<{ id: SfxCategory; name: string }> = [
  { id: 'transition', name: 'Übergänge' },
  { id: 'impact', name: 'Aufprall' },
  { id: 'car', name: 'Auto' },
  { id: 'ui', name: 'Social & Klicks' },
  { id: 'mood', name: 'Stimmung' },
];

// ---------------------------------------------------------------- Synthese-Grundbausteine

export class SynthCtx {
  readonly L: Float32Array;
  readonly R: Float32Array;
  readonly n: number;
  private s: number;
  constructor(readonly sr: number, readonly dur: number, readonly p: SfxParams) {
    this.n = Math.max(1, Math.round(sr * dur));
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
    this.s = (p.seed * 2654435761) >>> 0 || 1;
  }
  /** Zufall 0..1 (reproduzierbar) */
  rnd(): number { this.s ^= this.s << 13; this.s ^= this.s >>> 17; this.s ^= this.s << 5; return ((this.s >>> 0) % 1_000_000) / 1_000_000; }
  noise(): number { return this.rnd() * 2 - 1; }
  /** Tonhöhen-Faktor aus den Einstellungen */
  get pf(): number { return Math.pow(2, this.p.pitch / 12); }
  add(i: number, v: number, pan = 0): void {
    if (i < 0 || i >= this.n) return;
    const a = (pan + 1) * Math.PI / 4;
    this.L[i] += v * Math.cos(a) * Math.SQRT2;
    this.R[i] += v * Math.sin(a) * Math.SQRT2;
  }
}

/** Zustandsvariablen-Filter (Tiefpass/Bandpass/Hochpass), Grenzfrequenz darf sich jedes Sample ändern. */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  constructor(private sr: number) {}
  run(x: number, cutoff: number, q: number): { lp: number; bp: number; hp: number } {
    const f = Math.min(0.49, Math.max(1, cutoff) / this.sr);
    const g = Math.tan(Math.PI * f);
    const k = 1 / Math.max(0.05, q);
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return { lp: v2, bp: v1, hp: x - k * v1 - v2 };
  }
}

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Glocke 0→1→0 (Gipfel bei `peak`, 0..1) */
const bell = (u: number, peak = 0.5, sharp = 2) => (u < peak ? Math.pow(u / peak, sharp) : Math.pow(Math.max(0, (1 - u) / (1 - peak)), sharp));
const expDecay = (t: number, tau: number) => Math.exp(-t / Math.max(1e-4, tau));
const attack = (t: number, a: number) => (t < a ? t / a : 1);

/** Einfacher Hall (Schroeder: 4 Kammfilter + 2 Allpässe) – macht Effekte räumlicher. */
export function reverb(c: SynthCtx, mix: number, size = 1): void {
  if (mix <= 0) return;
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.round(d * size * c.sr / 44100));
  const aps = [225, 556].map((d) => Math.round(d * c.sr / 44100));
  for (const ch of [c.L, c.R]) {
    const dry = Float32Array.from(ch);
    const wet = new Float32Array(c.n);
    combs.forEach((d, k) => {
      const buf = new Float32Array(d + (ch === c.R ? 23 * (k + 1) : 0));
      let idx = 0, lp = 0;
      for (let i = 0; i < c.n; i++) {
        const y = buf[idx];
        lp = y * 0.8 + lp * 0.2;
        buf[idx] = dry[i] + lp * 0.84;
        idx = (idx + 1) % buf.length;
        wet[i] += y * 0.25;
      }
    });
    for (const d of aps) {
      const buf = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < c.n; i++) {
        const b = buf[idx];
        const y = -wet[i] + b;
        buf[idx] = wet[i] + b * 0.5;
        idx = (idx + 1) % d;
        wet[i] = y;
      }
    }
    for (let i = 0; i < c.n; i++) ch[i] = dry[i] * (1 - mix * 0.5) + wet[i] * mix;
  }
}

/** Lautstärke angleichen (Spitze bei -1 dBFS) und Anfang/Ende weich ausblenden. */
export function finish(c: SynthCtx): void {
  const peakOf = () => { let p = 1e-6; for (let i = 0; i < c.n; i++) p = Math.max(p, Math.abs(c.L[i]), Math.abs(c.R[i])); return p; };
  const g = 1.1 / peakOf();
  const fade = Math.min(c.n / 4, Math.round(c.sr * 0.01));
  const fin = Math.max(1, Math.round(c.sr * 0.002));
  for (let i = 0; i < c.n; i++) {
    const f = Math.min(1, i / fin, (c.n - 1 - i) / Math.max(1, fade));
    c.L[i] = Math.tanh(c.L[i] * g) * f;
    c.R[i] = Math.tanh(c.R[i] * g) * f;
  }
  // Spitze auf −1 dBFS
  const g2 = 0.89 / peakOf();
  for (let i = 0; i < c.n; i++) { c.L[i] *= g2; c.R[i] *= g2; }
}

// ---------------------------------------------------------------- Effekte

function whoosh(c: SynthCtx, lo: number, hi: number, q: number, sub: boolean): void {
  const f1 = new Svf(c.sr), f2 = new Svf(c.sr);
  let ph = 0;
  for (let i = 0; i < c.n; i++) {
    const u = i / c.n;
    const env = bell(u, 0.55, 1.6);
    const cut = (lo + (hi - lo) * bell(u, 0.55, 1.2)) * c.pf;
    const x = c.noise();
    const v = f1.run(x, cut, q).bp * 0.6 + f2.run(x, cut * 2.1, q * 1.4).bp * 0.25 * c.p.intensity;
    let s = v * env;
    if (sub) { ph += TAU * (45 + 30 * bell(u, 0.55)) * c.pf / c.sr; s += Math.sin(ph) * env * 0.35; }
    c.add(i, s, -0.85 + 1.7 * u);
  }
}

function boom(c: SynthCtx, f0: number, f1: number, tau: number, crack: number): void {
  const lp = new Svf(c.sr);
  let ph = 0;
  for (let i = 0; i < c.n; i++) {
    const t = i / c.sr;
    const f = (f1 + (f0 - f1) * expDecay(t, 0.12)) * c.pf;
    ph += TAU * f / c.sr;
    const body = Math.sin(ph) * expDecay(t, tau) * attack(t, 0.003);
    const n = lp.run(c.noise(), 300 + 4000 * expDecay(t, 0.05), 0.7).lp * expDecay(t, tau * 0.4) * crack;
    const s = Math.tanh((body * 1.4 + n) * (0.8 + c.p.intensity));
    c.add(i, s, 0);
  }
}

function engine(c: SynthCtx, rpm: (u: number) => number, doppler: boolean): void {
  const f = new Svf(c.sr), nf = new Svf(c.sr);
  let ph = 0;
  for (let i = 0; i < c.n; i++) {
    const u = i / c.n;
    let fr = rpm(u) * c.pf;            // Zündfrequenz in Hz
    let amp = 1, pan = 0;
    if (doppler) {
      const x = (u - 0.5) * 2;          // Auto fährt von links nach rechts vorbei
      const v = -x / Math.sqrt(x * x + 0.04);
      fr *= 1 + 0.12 * v;
      amp = 0.25 + 0.75 / (1 + 12 * x * x);
      pan = clamp(x * 1.2, -1, 1);
    } else {
      amp = attack(u, 0.05) * Math.min(1, (1 - u) / 0.15);
    }
    ph += TAU * fr / c.sr;
    // Obertöne eines Verbrennungsmotors: viele Harmonische mit leichter Unregelmäßigkeit
    let s = 0;
    for (let h = 1; h <= 9; h++) s += Math.sin(ph * h + (h % 3) * 0.7) / Math.pow(h, 0.9);
    s += 0.35 * nf.run(c.noise(), fr * 6, 2).bp;
    s = Math.tanh(s * (0.8 + c.p.intensity * 0.9));
    s = f.run(s, 900 + fr * 18, 0.8).lp;
    c.add(i, s * amp, pan);
  }
}

export const SFX: SfxDef[] = [
  // Übergänge
  { id: 'whoosh', name: 'Whoosh', category: 'transition', icon: '💨', duration: 0.9, render: (c) => whoosh(c, 350, 3200, 1.4, false) },
  { id: 'whoosh-long', name: 'Whoosh lang', category: 'transition', icon: '🌬️', duration: 1.7, render: (c) => { whoosh(c, 250, 2400, 1.1, false); reverb(c, 0.25); } },
  { id: 'swoosh-deep', name: 'Tiefer Swoosh', category: 'transition', icon: '🌀', duration: 1.1, render: (c) => whoosh(c, 120, 900, 0.9, true) },
  { id: 'riser', name: 'Riser (Spannung steigt)', category: 'transition', icon: '📈', duration: 3, render: (c) => {
    const f = new Svf(c.sr);
    let a = 0, b = 0;
    for (let i = 0; i < c.n; i++) {
      const u = i / c.n;
      const cut = 200 * Math.pow(30, u) * c.pf;
      const env = Math.pow(u, 1.6) * Math.min(1, (1 - u) / 0.03);
      const fr = 110 * Math.pow(4, u) * c.pf;
      a += TAU * fr / c.sr; b += TAU * fr * 1.007 / c.sr;
      const saw = ((a / TAU) % 1) * 2 - 1 + ((b / TAU) % 1) * 2 - 1;
      c.add(i, (f.run(c.noise(), cut, 2).bp * 0.8 + saw * 0.18 * c.p.intensity) * env, Math.sin(u * 9) * 0.4);
    }
    reverb(c, 0.3);
  } },
  { id: 'suck', name: 'Sog (rückwärts)', category: 'transition', icon: '⏪', duration: 1.2, render: (c) => {
    boom(c, 160, 50, 0.35, 1.2); reverb(c, 0.4, 1.2);
    c.L.reverse(); c.R.reverse();
  } },
  // Aufprall
  { id: 'boom', name: 'Boom (Bass-Einschlag)', category: 'impact', icon: '💥', duration: 1.8, render: (c) => { boom(c, 150, 38, 0.55, 0.8); reverb(c, 0.2, 1.3); } },
  { id: 'hit', name: 'Schlag (Punch)', category: 'impact', icon: '👊', duration: 0.45, render: (c) => boom(c, 220, 70, 0.09, 1.4) },
  { id: 'crack', name: 'Knall', category: 'impact', icon: '🧨', duration: 2.2, render: (c) => {
    const lp = new Svf(c.sr);
    for (let i = 0; i < c.n; i++) {
      const t = i / c.sr;
      const burst = c.noise() * expDecay(t, 0.025) * 1.5;
      const rumble = lp.run(c.noise(), 180 * c.pf, 0.6).lp * expDecay(t, 0.7) * 3 * attack(t, 0.01);
      c.add(i, Math.tanh((burst + rumble) * c.p.intensity * 1.3), 0);
    }
    reverb(c, 0.35, 1.4);
  } },
  { id: 'metal', name: 'Metall-Klirren', category: 'impact', icon: '🔩', duration: 1.6, render: (c) => {
    const partials = [523, 1187, 2001, 3299, 4570];
    for (let i = 0; i < c.n; i++) {
      const t = i / c.sr;
      let s = 0;
      partials.forEach((p, k) => { s += Math.sin(TAU * p * c.pf * t) * expDecay(t, 0.6 / (1 + k * 0.6)) / (1 + k * 0.4); });
      s += c.noise() * expDecay(t, 0.01) * c.p.intensity;
      c.add(i, s * attack(t, 0.001), 0.2);
    }
    reverb(c, 0.25);
  } },
  // Auto
  { id: 'rev', name: 'Motor aufheulen', category: 'car', icon: '🏎️', duration: 2.6, render: (c) => engine(c, (u) => 32 + 95 * bell(u, 0.45, 1.3), false) },
  { id: 'passby', name: 'Vorbeifahrt', category: 'car', icon: '🚗', duration: 3, render: (c) => { engine(c, () => 78, true); reverb(c, 0.12); } },
  { id: 'idle', name: 'Motor im Leerlauf', category: 'car', icon: '🔧', duration: 4, render: (c) => engine(c, (u) => 14 + Math.sin(u * 40) * 0.6, false) },
  { id: 'squeal', name: 'Reifen quietschen', category: 'car', icon: '🛞', duration: 1.6, render: (c) => {
    const f = new Svf(c.sr);
    let ph = 0;
    for (let i = 0; i < c.n; i++) {
      const u = i / c.n, t = i / c.sr;
      const fr = (2100 + 260 * Math.sin(TAU * 7 * t) + 180 * c.noise() * 0.2) * c.pf;
      ph += TAU * fr / c.sr;
      const env = attack(u, 0.08) * Math.min(1, (1 - u) / 0.25);
      c.add(i, (Math.sin(ph) * 0.5 + f.run(c.noise(), fr, 6).bp * 1.2) * env * c.p.intensity, 0.3 - u * 0.6);
    }
  } },
  { id: 'blowoff', name: 'Turbo-Abblasen', category: 'car', icon: '🌪️', duration: 0.8, render: (c) => {
    const f = new Svf(c.sr), w = new Svf(c.sr);
    for (let i = 0; i < c.n; i++) {
      const t = i / c.sr;
      const pssh = f.run(c.noise(), 5500 * c.pf, 0.7).hp * expDecay(t, 0.18) * attack(t, 0.01);
      const whistle = w.run(c.noise(), (4200 - 2500 * (1 - expDecay(t, 0.2))) * c.pf, 12).bp * expDecay(t, 0.12) * 2;
      c.add(i, (pssh + whistle) * c.p.intensity, 0);
    }
  } },
  // Social & Klicks
  { id: 'click', name: 'Klick', category: 'ui', icon: '🖱️', duration: 0.08, render: (c) => {
    const f = new Svf(c.sr);
    for (let i = 0; i < c.n; i++) { const t = i / c.sr; c.add(i, f.run(c.noise(), 3500 * c.pf, 1.5).bp * expDecay(t, 0.004), 0); }
  } },
  { id: 'pop', name: 'Pop', category: 'ui', icon: '🫧', duration: 0.18, render: (c) => {
    let ph = 0;
    for (let i = 0; i < c.n; i++) { const t = i / c.sr; ph += TAU * (380 + 1400 * (1 - expDecay(t, 0.03))) * c.pf / c.sr; c.add(i, Math.sin(ph) * expDecay(t, 0.04) * attack(t, 0.002), 0); }
  } },
  { id: 'ding', name: 'Ding', category: 'ui', icon: '🔔', duration: 1.4, render: (c) => {
    const parts = [[1046, 1], [2093 * 1.003, 0.5], [3140, 0.3], [4186 * 1.01, 0.15]];
    for (let i = 0; i < c.n; i++) { const t = i / c.sr; let s = 0; for (const [f, a] of parts) s += Math.sin(TAU * f * c.pf * t) * a * expDecay(t, 0.5 / (1 + f / 3000)); c.add(i, s * attack(t, 0.002), 0); }
    reverb(c, 0.2);
  } },
  { id: 'shutter', name: 'Kamera-Auslöser', category: 'ui', icon: '📸', duration: 0.35, render: (c) => {
    const f = new Svf(c.sr);
    for (let i = 0; i < c.n; i++) {
      const t = i / c.sr;
      const k = expDecay(t, 0.006) + expDecay(Math.max(0, t - 0.11), 0.01) * (t > 0.11 ? 0.8 : 0);
      c.add(i, f.run(c.noise(), 2500 * c.pf, 1).bp * k * 2 + c.noise() * 0.05 * expDecay(t, 0.08), 0);
    }
  } },
  { id: 'typing', name: 'Tippen', category: 'ui', icon: '⌨️', duration: 1.6, render: (c) => {
    let next = 0;
    const f = new Svf(c.sr);
    let last = -1;
    for (let i = 0; i < c.n; i++) {
      if (i >= next) { last = i; next = i + Math.round(c.sr * (0.07 + c.rnd() * 0.12)); }
      const t = (i - last) / c.sr;
      c.add(i, f.run(c.noise(), (2800 + c.rnd() * 400) * c.pf, 2).bp * expDecay(t, 0.006) * 2, 0);
    }
  } },
  // Stimmung
  { id: 'drone', name: 'Spannung (Drone)', category: 'mood', icon: '🎻', duration: 6, render: (c) => {
    for (let i = 0; i < c.n; i++) {
      const u = i / c.n, t = i / c.sr;
      const env = bell(u, 0.5, 0.6);
      const lfo = 0.7 + 0.3 * Math.sin(TAU * 0.35 * t);
      const s = (Math.sin(TAU * 55 * c.pf * t) + 0.6 * Math.sin(TAU * 82.4 * c.pf * t + 1) + 0.25 * Math.sin(TAU * 110.6 * c.pf * t)) * lfo;
      c.add(i, s * env * c.p.intensity, Math.sin(TAU * 0.1 * t) * 0.5);
    }
    reverb(c, 0.4, 1.5);
  } },
  { id: 'heartbeat', name: 'Herzschlag', category: 'mood', icon: '💓', duration: 4, render: (c) => {
    const period = 0.85;
    for (let i = 0; i < c.n; i++) {
      const t = i / c.sr;
      const tb = t % period;
      const a = tb < 0.15 ? expDecay(tb, 0.05) : tb > 0.22 && tb < 0.45 ? expDecay(tb - 0.22, 0.06) * 0.7 : 0;
      c.add(i, Math.sin(TAU * 52 * c.pf * t) * a * attack(tb % 0.22, 0.004) * c.p.intensity, 0);
    }
  } },
  { id: 'wind', name: 'Wind', category: 'mood', icon: '🍃', duration: 6, render: (c) => {
    const f = new Svf(c.sr);
    for (let i = 0; i < c.n; i++) {
      const u = i / c.n, t = i / c.sr;
      const cut = Math.max(180, 520 + 260 * Math.sin(TAU * 0.23 * t) + 160 * Math.sin(TAU * 0.61 * t + 1)) * c.pf;
      const env = Math.min(1, u / 0.15, (1 - u) / 0.15);
      c.add(i, f.run(c.noise(), cut, 1.8).bp * env * c.p.intensity, Math.sin(TAU * 0.13 * t) * 0.6);
    }
  } },
];

export function sfxDef(id: string): SfxDef | undefined {
  return SFX.find((s) => s.id === id);
}

/** Effekt berechnen: Stereo-Samples (−1..1). */
export function renderSfx(id: string, params: Partial<SfxParams> = {}, sr = 48000): { L: Float32Array; R: Float32Array; sr: number } {
  const def = sfxDef(id);
  if (!def) throw new Error(`Unbekannter Sound: ${id}`);
  const p: SfxParams = { ...DEFAULT_SFX_PARAMS, ...params };
  const c = new SynthCtx(sr, def.duration * clamp(p.length, 0.3, 3), p);
  def.render(c);
  finish(c);
  return { L: c.L, R: c.R, sr };
}

/** 16-Bit-WAV (Stereo) als Bytes. */
export function encodeWav(L: Float32Array, R: Float32Array, sr: number): Uint8Array {
  const n = L.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(o, Math.round(clamp(L[i], -1, 1) * 32767), true); o += 2;
    v.setInt16(o, Math.round(clamp(R[i], -1, 1) * 32767), true); o += 2;
  }
  return new Uint8Array(buf);
}
