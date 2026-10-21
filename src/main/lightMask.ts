// Maskenfilm für „markierte Lichter“ (Leuchtspuren nur dort): weiche Kreise je Bild, in Bild-Koordinaten nach
// Zuschnitt/Spiegeln/Einpassen – dieselbe Rechnung wie die Vorschau (engine temporalFx).
import type { LightTrack } from '@shared/types';
import { lightMaskFrame } from '@shared/lights';
import { pipeFfmpeg } from './ffmpeg';

export const LIGHT_MASK_RATE = 15;

/**
 * `toFrame` bildet Quell-Koordinaten (0..1) auf das eingepasste Bild ab, `rScale` den Radius (relativ zur Höhe).
 * `srcAt(k)` = Quellzeit des k-ten Maskenbilds (Bild k liegt bei k / LIGHT_MASK_RATE s im Clip).
 */
export async function writeLightMask(lights: LightTrack[], toFrame: (x: number, y: number) => [number, number], rScale: number,
  srcAt: (k: number) => number, frames: number, mw: number, mh: number, file: string): Promise<void> {
  const mapped: LightTrack[] = lights.map((l) => ({ id: l.id, keys: l.keys.map((k) => { const [x, y] = toFrame(k.x, k.y); return { t: k.t, x, y, r: k.r * rScale }; }) }));
  const pipe = pipeFfmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${mw}x${mh}`, '-r', String(LIGHT_MASK_RATE), '-i', '-', '-c:v', 'ffv1', file]);
  const buf = new Uint8Array(mw * mh);
  try {
    for (let k = 0; k < frames; k++) await pipe.write(lightMaskFrame(mapped, srcAt(k), mw, mh, buf).slice());
    await pipe.end();
  } catch (e) { pipe.kill(); throw e; }
}
