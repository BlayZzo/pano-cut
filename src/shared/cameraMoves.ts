// Kamerafahrten für 360°-Clips (als Keyframes der 360°-Ansicht) und Tempo-Rampen.
// Die Keyframes werden dicht gesetzt und linear verbunden, damit Bewegungen > 180° (die Interpolation
// nimmt immer den kürzesten Weg) und weiche Beschleunigungen in Vorschau und Export identisch sind.
import type { Clip, PanoKeyframe, PanoMode, PanoSettings } from './types';
import { panoViewAt, type PanoView } from './pano';
import { clipDuration, makeId } from './timeline';
import { scaleClipTimes, sliceClip } from './clipslice';

export type CameraMove = 'orbit' | 'orbitLeft' | 'whip' | 'lookBack' | 'planetOut' | 'planetIn' | 'zoomPunch' | 'droneRise' | 'roll' | 'sway';

export interface CameraMoveDef { id: CameraMove; name: string; hint: string; duration: number; mode?: PanoMode }

export const CAMERA_MOVES: CameraMoveDef[] = [
  { id: 'orbit', name: 'Rundum-Schwenk →', hint: 'Einmal ganz herum (360°) nach rechts', duration: 4 },
  { id: 'orbitLeft', name: 'Rundum-Schwenk ←', hint: 'Einmal ganz herum nach links', duration: 4 },
  { id: 'whip', name: 'Peitschen-Schwenk 180°', hint: 'Blitzschnelle halbe Drehung – ideal für Schnitte', duration: 1.5 },
  { id: 'lookBack', name: 'Schulterblick', hint: 'Kurz nach hinten schauen und zurück', duration: 3 },
  { id: 'planetOut', name: 'Planet → Normal', hint: 'Aus dem kleinen Planeten in die normale Ansicht fliegen', duration: 3, mode: 'littleplanet' },
  { id: 'planetIn', name: 'Normal → Planet', hint: 'Von der normalen Ansicht in den kleinen Planeten', duration: 3, mode: 'littleplanet' },
  { id: 'zoomPunch', name: 'Zoom-Stoß', hint: 'Kurzer Ruck nach vorne (z. B. auf den Takt)', duration: 0.8 },
  { id: 'droneRise', name: 'Drohnen-Aufstieg', hint: 'Blick senkt sich, das Bild wird weiter – wirkt wie Steigen', duration: 4 },
  { id: 'roll', name: 'Fassrolle', hint: 'Das Bild dreht sich einmal um die eigene Achse', duration: 2 },
  { id: 'sway', name: 'Pendel-Schwenk', hint: 'Sanft links-rechts (wie ein Verfolger-Fahrzeug)', duration: 4 },
];

const ease = (x: number) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };
const easeInOutCubic = (x: number) => { const u = Math.max(0, Math.min(1, x)); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };

/** Bewegung als Funktion der Zeit innerhalb der Fahrt: Abweichung vom Start-Blick. */
function moveAt(move: CameraMove, u: number, s: number, start: PanoView, mode: PanoMode): PanoView {
  const v = { ...start };
  switch (move) {
    case 'orbit': v.yaw = start.yaw + 360 * s * easeInOutCubic(u); break;
    case 'orbitLeft': v.yaw = start.yaw - 360 * s * easeInOutCubic(u); break;
    case 'whip': {
      // Halten – schnell drehen (mittlere 30 %) – halten
      const w = Math.max(0.12, 0.3 / Math.max(0.5, s));
      const k = Math.max(0, Math.min(1, (u - (0.5 - w / 2)) / w));
      v.yaw = start.yaw + 180 * easeInOutCubic(k);
      break;
    }
    case 'lookBack': {
      const k = u < 0.3 ? ease(u / 0.3) : u < 0.7 ? 1 : 1 - ease((u - 0.7) / 0.3);
      v.yaw = start.yaw + 180 * Math.min(1.5, s) * k;
      break;
    }
    case 'planetOut': case 'planetIn': {
      const k = move === 'planetOut' ? easeInOutCubic(u) : 1 - easeInOutCubic(u);
      // Planet: Blick senkrecht nach unten, sehr weites Sichtfeld; normal: Blick geradeaus
      const planetFov = 300, normalFov = mode === 'littleplanet' ? 125 : start.fov;
      v.pitch = -90 + (start.pitch + 90) * k;
      v.fov = planetFov + (normalFov - planetFov) * k;
      v.yaw = start.yaw + 120 * s * (1 - k);
      break;
    }
    case 'zoomPunch': {
      const k = u < 0.2 ? ease(u / 0.2) : 1 - ease((u - 0.2) / 0.8);
      v.fov = start.fov * (1 - 0.35 * Math.min(2, s) * k);
      break;
    }
    case 'droneRise': {
      const k = easeInOutCubic(u);
      v.pitch = Math.max(-89, start.pitch - 55 * Math.min(1.6, s) * k);
      v.fov = start.fov + (mode === 'littleplanet' ? 60 : 25) * s * k;
      break;
    }
    case 'roll': v.roll = start.roll + 360 * s * easeInOutCubic(u); break;
    case 'sway': v.yaw = start.yaw + 25 * s * Math.sin(2 * Math.PI * u); break;
  }
  if (mode !== 'littleplanet') v.fov = Math.max(30, Math.min(150, v.fov));
  else v.fov = Math.max(120, Math.min(320, v.fov));
  return v;
}

/** Weiche (smooth) Keyframes in dichte lineare umrechnen, damit neue Fahrten das Bestehende nicht verändern. */
export function linearizePano(p: PanoSettings, clipDur: number): PanoSettings {
  if (!p.smooth || p.keyframes.length < 2) return { ...p, smooth: false };
  const out: PanoKeyframe[] = [];
  const k = p.keyframes;
  for (let i = 0; i < k.length - 1; i++) {
    const steps = 8;
    for (let j = 0; j < steps; j++) {
      const t = k[i].t + ((k[i + 1].t - k[i].t) * j) / steps;
      out.push({ t, ...panoViewAt(p, t) });
    }
  }
  out.push({ ...k[k.length - 1] });
  return { ...p, smooth: false, keyframes: out.filter((x) => x.t <= clipDur + 1e-6) };
}

/**
 * Kamerafahrt ab Clip-Zeit `start` (Sekunden) mit Dauer `dur` und Stärke `strength` (0,5..2) einsetzen.
 * Vorhandene Keyframes in diesem Bereich werden ersetzt, danach geht es mit dem End-Blick weiter.
 */
export function applyCameraMove(p: PanoSettings, move: CameraMove, start: number, dur: number, strength: number, clipDur: number): PanoSettings {
  const def = CAMERA_MOVES.find((m) => m.id === move)!;
  const mode: PanoMode = def.mode ?? p.mode;
  const base = linearizePano({ ...p, mode }, clipDur);
  const t0 = Math.max(0, Math.min(clipDur - 0.1, start));
  const t1 = Math.min(clipDur, t0 + Math.max(0.2, dur));
  let from = panoViewAt(base, t0);
  // Planet-Fahrten aus der flachen Ansicht: Sichtfeld an die stereografische Ansicht anpassen
  if (def.mode === 'littleplanet' && p.mode !== 'littleplanet') from = { ...from, fov: 125 };
  const modeChanged = mode !== p.mode;
  const after = base.keyframes.filter((k) => k.t > t1 + 1e-3);
  const before = modeChanged ? [] : base.keyframes.filter((k) => k.t < t0 - 1e-3);
  const steps = Math.max(8, Math.ceil((t1 - t0) * 12));
  const keys: PanoKeyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    keys.push({ t: t0 + (t1 - t0) * u, ...moveAt(move, u, strength, from, mode) });
  }
  // Danach: die bisherige Ausrichtung relativ zum neuen End-Blick fortsetzen
  const end = keys[keys.length - 1];
  const endBefore = panoViewAt(base, t1);
  const shifted = after.map((k) => ({
    ...k, yaw: k.yaw + (end.yaw - endBefore.yaw), roll: k.roll + (end.roll - endBefore.roll),
    // Ansicht gewechselt (z. B. flach → Planet): Sichtfeld und Neigung vom Ende der Fahrt übernehmen
    ...(modeChanged ? { fov: end.fov, pitch: end.pitch } : {}),
  }));
  // Vor der Fahrt: bei gewechselter Ansicht den Anfangszustand der Fahrt halten
  if (modeChanged && t0 > 1e-3) before.push({ ...keys[0], t: 0 });
  // Winkel normalisieren (−180..180) – die Interpolation nimmt den kürzesten Weg, die Schritte sind < 180°
  const norm = (a: number) => ((a % 360) + 540) % 360 - 180;
  const all = [...before, ...keys, ...shifted].map((k) => ({ ...k, yaw: norm(k.yaw), roll: norm(k.roll) }));
  return { mode, smooth: false, keyframes: all };
}

// ---------- Tempo-Rampen ----------

export type SpeedRamp = 'slowMid' | 'fastMid' | 'brake' | 'accelerate' | 'hero';

export const SPEED_RAMPS: Array<{ id: SpeedRamp; name: string }> = [
  { id: 'slowMid', name: 'Schnell → Zeitlupe → Schnell' },
  { id: 'hero', name: 'Hero-Moment (plötzliche Zeitlupe)' },
  { id: 'fastMid', name: 'Zeitlupe → Schnell → Zeitlupe' },
  { id: 'brake', name: 'Ausbremsen (schnell → langsam)' },
  { id: 'accelerate', name: 'Beschleunigen (langsam → schnell)' },
];

/** Relatives Tempo an der Stelle x (0..1) einer Rampe. */
export function rampProfile(r: SpeedRamp, x: number, strength: number): number {
  const s = Math.max(0.1, Math.min(2, strength));
  const bell = (c: number, w: number) => Math.exp(-Math.pow((x - c) / w, 2));
  switch (r) {
    case 'slowMid': return Math.max(0.08, 1 - 0.8 * Math.min(1.15, s) * bell(0.5, 0.2));
    case 'fastMid': return 1 + 2.5 * s * bell(0.5, 0.18);
    case 'brake': return Math.max(0.1, 1 + 1.2 * s * (1 - ease(x)) - 0.8 * Math.min(1.1, s) * ease(x));
    case 'accelerate': return Math.max(0.1, 1 - 0.8 * Math.min(1.1, s) * (1 - ease(x)) + 1.2 * s * ease(x));
    case 'hero': {
      const w = x < 0.35 ? 0 : x < 0.45 ? ease((x - 0.35) / 0.1) : x < 0.75 ? 1 : 1 - ease((x - 0.75) / 0.1);
      return Math.max(0.08, 1 - 0.85 * Math.min(1.1, s) * Math.max(0, Math.min(1, w)));
    }
  }
}

/**
 * Tempo-Rampe: Clip in `pieces` Stücke mit stufenweise wechselndem Tempo teilen. Die Gesamtlänge auf der
 * Timeline und der benutzte Quellbereich bleiben gleich – nachfolgende Clips verschieben sich nicht.
 */
export function speedRampPieces(c: Clip, ramp: SpeedRamp, strength: number, pieces = 16): Clip[] {
  const D = clipDuration(c);
  const n = Math.max(4, Math.min(48, pieces));
  const r = Array.from({ length: n }, (_, i) => rampProfile(ramp, (i + 0.5) / n, strength));
  const sum = r.reduce((a, b) => a + b, 0);
  const srcLen = c.out - c.in;
  const k = (n * srcLen) / (D * sum);   // Grundtempo, damit die Quelle genau aufgebraucht wird
  const out: Clip[] = [];
  let src = 0;      // verbrauchte Quelle (Sekunden ab In- bzw. Out-Punkt)
  for (let i = 0; i < n; i++) {
    const tl = D / n;
    const speed = Math.max(0.05, Math.min(100, k * r[i]));
    const len = tl * speed;
    // Stück aus dem Original herausschneiden (übernimmt Farbe, Effekte, 360°-Blick …) und Tempo setzen
    const fromLocal = src / c.speed, toLocal = (src + len) / c.speed;
    let piece = sliceClip(c, fromLocal, toLocal, i === 0 ? c.id : makeId('clip'));
    const a = c.reverse ? c.out - src - len : c.in + src;
    piece = { ...piece, start: c.start + tl * i, in: a, out: a + len, speed };
    // Clip-lokale Zeiten auf die neue Stücklänge strecken
    const scale = tl / Math.max(1e-6, toLocal - fromLocal);
    piece = scaleClipTimes(piece, scale);
    if (i > 0) { piece.fadeIn = 0; piece.transition = undefined; }
    if (i < n - 1) piece.fadeOut = 0;
    out.push(piece);
    src += len;
  }
  return out;
}
