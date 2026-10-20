// Kamerafahrten: Ausschnitt-Fahrt für normale Videos/Bilder und gemeinsame Beschleunigungskurven (auch für 360°).
// Vorschau (Engine) und Export (FFmpeg-Ausdrücke) nutzen dieselben Formeln.
import type { Clip, MoveEase, PanoSettings, ReframeKeyframe, ReframeSettings } from './types';

/** Beschleunigung 0..1 → 0..1 */
export function ease(kind: MoveEase, u: number): number {
  const x = Math.max(0, Math.min(1, u));
  switch (kind) {
    case 'linear': return x;
    case 'in': return x * x;              // langsam los, schnell an
    case 'out': return 1 - (1 - x) * (1 - x); // schnell los, langsam an
    default: return x * x * (3 - 2 * x);
  }
}

/** Dieselbe Kurve als FFmpeg-Ausdruck (x = Ausdruck für 0..1). */
export function easeExpr(kind: MoveEase, x: string): string {
  const c = `clip(${x},0,1)`;
  switch (kind) {
    case 'linear': return `(${c})`;
    case 'in': return `(${c})*(${c})`;
    case 'out': return `(1-(1-${c})*(1-${c}))`;
    default: return `(${c})*(${c})*(3-2*(${c}))`;
  }
}

export function panoEase(p: PanoSettings): MoveEase {
  return p.ease ?? (p.smooth ? 'smooth' : 'linear');
}

export const REFRAME_ZOOM_MAX = 6;

export function reframeAt(rf: ReframeSettings, t: number): Omit<ReframeKeyframe, 't'> {
  const k = rf.keyframes;
  if (!k.length) return { zoom: 1, x: 0.5, y: 0.5 };
  if (k.length === 1 || t <= k[0].t) return { zoom: k[0].zoom, x: k[0].x, y: k[0].y };
  const last = k[k.length - 1];
  if (t >= last.t) return { zoom: last.zoom, x: last.x, y: last.y };
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (t >= a.t && t <= b.t) {
      const u = ease(rf.ease, (t - a.t) / Math.max(1e-6, b.t - a.t));
      return { zoom: a.zoom + (b.zoom - a.zoom) * u, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return { zoom: last.zoom, x: last.x, y: last.y };
}

/**
 * Sichtbarer Bereich im Quellbild (Anteile 0..1) für Ausgabe-Seitenverhältnis `aspect` (= Breite/Höhe):
 * zuerst der größte Bereich mit diesem Seitenverhältnis, dann um `zoom` verkleinert und nach x/y verschoben.
 */
export function reframeRect(v: Omit<ReframeKeyframe, 't'>, srcW: number, srcH: number, aspect: number): { x: number; y: number; w: number; h: number } {
  const srcAspect = srcW / Math.max(1, srcH);
  let fw = 1, fh = 1;
  if (srcAspect > aspect) fw = aspect / srcAspect; else fh = srcAspect / aspect;
  const z = Math.max(1, Math.min(REFRAME_ZOOM_MAX, v.zoom));
  fw /= z; fh /= z;
  return { x: (1 - fw) * clamp01(v.x), y: (1 - fh) * clamp01(v.y), w: fw, h: fh };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export function hasReframe(c: Clip): boolean {
  return !!c.reframe && c.reframe.keyframes.length > 0;
}

export function upsertReframeKey(rf: ReframeSettings | undefined, k: ReframeKeyframe): ReframeSettings {
  const base: ReframeSettings = rf ?? { keyframes: [], ease: 'smooth' };
  const list = base.keyframes.filter((x) => Math.abs(x.t - k.t) > 1e-3);
  list.push(k);
  list.sort((a, b) => a.t - b.t);
  return { ...base, keyframes: list };
}

/** Fertige Fahrten über die ganze Clip-Länge. */
export const REFRAME_PRESETS: Array<{ id: string; icon: string; name: string; make: (dur: number) => ReframeKeyframe[] }> = [
  { id: 'panLR', icon: '➡️', name: 'Schwenk nach rechts', make: (d) => [{ t: 0, zoom: 1.35, x: 0, y: 0.5 }, { t: d, zoom: 1.35, x: 1, y: 0.5 }] },
  { id: 'panRL', icon: '⬅️', name: 'Schwenk nach links', make: (d) => [{ t: 0, zoom: 1.35, x: 1, y: 0.5 }, { t: d, zoom: 1.35, x: 0, y: 0.5 }] },
  { id: 'tiltDown', icon: '⬇️', name: 'Schwenk nach unten', make: (d) => [{ t: 0, zoom: 1.35, x: 0.5, y: 0 }, { t: d, zoom: 1.35, x: 0.5, y: 1 }] },
  { id: 'zoomIn', icon: '🔍', name: 'Langsam reinzoomen', make: (d) => [{ t: 0, zoom: 1, x: 0.5, y: 0.5 }, { t: d, zoom: 1.6, x: 0.5, y: 0.5 }] },
  { id: 'zoomOut', icon: '🔭', name: 'Langsam rauszoomen', make: (d) => [{ t: 0, zoom: 1.6, x: 0.5, y: 0.5 }, { t: d, zoom: 1, x: 0.5, y: 0.5 }] },
  { id: 'drift', icon: '🌫️', name: 'Sanft treiben', make: (d) => [{ t: 0, zoom: 1.2, x: 0.3, y: 0.4 }, { t: d, zoom: 1.3, x: 0.7, y: 0.6 }] },
  { id: 'kenburns', icon: '🎞️', name: 'Ken Burns (Zoom + Schwenk)', make: (d) => [{ t: 0, zoom: 1.05, x: 0.2, y: 0.5 }, { t: d, zoom: 1.5, x: 0.75, y: 0.4 }] },
];
