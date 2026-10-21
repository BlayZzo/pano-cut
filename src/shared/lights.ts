// Langzeitbelichtung nur für Lichter: Helligkeits-Schlüssel (nur helle Stellen ziehen Spuren) und markierte,
// über das Video verfolgte Lichter (Maske aus weichen Kreisen). Gleiche Formeln in Vorschau und Export.
import type { LightTrack } from './types';

export const DEFAULT_TRAIL_THRESHOLD = 0.6;

/** Schwelle (0..255) und Steilheit des Helligkeits-Schlüssels: Kanal × clip((v − T)·S, 0, 1). */
export function lightKeyParams(threshold = DEFAULT_TRAIL_THRESHOLD): { T: number; S: number } {
  const T = Math.round(255 * Math.max(0.2, Math.min(0.95, threshold)));
  return { T, S: 2 / Math.max(8, 255 - T) };
}

export function lightKey(v: number, T: number, S: number): number {
  return v * Math.max(0, Math.min(1, (v - T) * S));
}

/** Kreise aller Lichter zur Quellzeit t (zwischen den Messungen linear; außerhalb der Messung: keiner). */
export function lightsAt(lights: LightTrack[] | undefined, t: number): Array<{ x: number; y: number; r: number }> {
  const out: Array<{ x: number; y: number; r: number }> = [];
  for (const l of lights ?? []) {
    const k = l.keys;
    if (!k.length) continue;
    if (k.length === 1) { if (Math.abs(t - k[0].t) < 0.5) out.push(k[0]); continue; }
    if (t < k[0].t - 0.05 || t > k[k.length - 1].t + 0.05) continue;
    let i = 0;
    while (i < k.length - 2 && t > k[i + 1].t) i++;
    const a = k[i], b = k[i + 1];
    const u = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t)));
    out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, r: a.r + (b.r - a.r) * u });
  }
  return out;
}

/** Maske (0..1) eines Kreises: voll bis 0,6·r, weich bis r. */
export function circleMask(d: number, r: number): number {
  const x = Math.max(0, Math.min(1, (r - d) / Math.max(1e-6, 0.4 * r)));
  return x * x * (3 - 2 * x);
}

/** Graustufen-Maske (w×h, 0..255) für die Kreise zur Zeit t (für den Export-Maskenfilm). */
export function lightMaskFrame(lights: LightTrack[] | undefined, t: number, w: number, h: number, out = new Uint8Array(w * h)): Uint8Array {
  out.fill(0);
  for (const c of lightsAt(lights, t)) {
    const cx = c.x * w, cy = c.y * h, r = c.r * h;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const v = Math.round(255 * circleMask(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), r));
      if (v > out[y * w + x]) out[y * w + x] = v;
    }
  }
  return out;
}

/** Helligkeit (0..255) eines RGBA-Bildes an Pixel i. */
const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Lichter von einem Startbild aus verfolgen: in jedem folgenden Bild im Suchfenster (vorhergesagte Position bei
 * gleicher Geschwindigkeit) den hellsten Fleck suchen, Mittelpunkt = helligkeitsgewichteter Schwerpunkt.
 * `frames` zeitlich sortiert; Startpunkte gelten zur Zeit frames[start].t. Rückwärts wird ebenfalls verfolgt.
 */
export function trackLights(starts: Array<{ id: string; x: number; y: number; r: number }>, frames: Array<{ t: number; img: ImageData }>, start: number): LightTrack[] {
  return starts.map((s) => {
    const forward = follow(s, frames, start, 1);
    const backward = follow(s, frames, start, -1);
    const keys = [...backward.reverse(), { t: frames[start].t, x: s.x, y: s.y, r: s.r }, ...forward];
    return { id: s.id, keys };
  });
}

function follow(s: { x: number; y: number; r: number }, frames: Array<{ t: number; img: ImageData }>, start: number, dir: 1 | -1): Array<{ t: number; x: number; y: number; r: number }> {
  const out: Array<{ t: number; x: number; y: number; r: number }> = [];
  let x = s.x, y = s.y, vx = 0, vy = 0, lost = 0;
  for (let k = start + dir; k >= 0 && k < frames.length; k += dir) {
    const { img } = frames[k];
    const W = img.width, H = img.height, d = img.data;
    const px = (x + vx) * W, py = (y + vy) * H;
    const rad = Math.max(4, s.r * H * 2.5 + Math.hypot(vx * W, vy * H));
    // hellster Wert im Fenster
    let peak = 0;
    const xa = Math.max(0, Math.floor(px - rad)), xb = Math.min(W - 1, Math.ceil(px + rad));
    const ya = Math.max(0, Math.floor(py - rad)), yb = Math.min(H - 1, Math.ceil(py + rad));
    for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) peak = Math.max(peak, luma(d, (yy * W + xx) * 4));
    if (peak < 120) { if (++lost > 3) break; x += vx; y += vy; out.push({ t: frames[k].t, x, y, r: s.r }); continue; }
    const thr = peak * 0.8;
    let sx = 0, sy = 0, sw = 0;
    for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) {
      const v = luma(d, (yy * W + xx) * 4);
      if (v < thr) continue;
      const w = v - thr + 1;
      sx += (xx + 0.5) * w; sy += (yy + 0.5) * w; sw += w;
    }
    const nx = sx / sw / W, ny = sy / sw / H;
    vx = 0.6 * (nx - x) + 0.4 * vx; vy = 0.6 * (ny - y) + 0.4 * vy;
    x = nx; y = ny; lost = 0;
    out.push({ t: frames[k].t, x, y, r: s.r });
  }
  return out;
}
