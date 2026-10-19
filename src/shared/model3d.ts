// 3D-Modelle: Formate, Standardwerte, Bewegungen und Licht aus der Szene – gemeinsame Rechnung (ohne three.js).
import type { Model3DAnimation, Model3DFormat, Model3DSpec } from './types';
import type { FrameStats } from './color';

export const MODEL_EXTENSIONS: Model3DFormat[] = ['glb', 'gltf', 'obj', 'fbx', 'stl'];

export function modelFormat(path: string): Model3DFormat | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return (MODEL_EXTENSIONS as string[]).includes(ext) ? (ext as Model3DFormat) : null;
}

export const MODEL_ANIMATIONS: Array<{ id: Model3DAnimation; name: string }> = [
  { id: 'turntable', name: 'Drehteller (dreht sich)' },
  { id: 'swing', name: 'Hin und her schwenken' },
  { id: 'float', name: 'Schweben' },
  { id: 'spinin', name: 'Hereindrehen' },
  { id: 'flyby', name: 'Vorbeifliegen (Kamerafahrt)' },
  { id: 'embedded', name: 'Eigene Animation der Datei' },
  { id: 'none', name: 'Stillstehend' },
];

export function defaultModelSpec(file: string, projectW: number, projectH: number, fps: number): Model3DSpec {
  const name = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '3D-Objekt';
  // quadratnahe Render-Fläche, höchstens 960 Pixel hoch
  const h = Math.round(Math.min(960, Math.max(480, projectH * 0.8)) / 2) * 2;
  return {
    file, format: modelFormat(file) ?? 'glb', name,
    duration: 5, fps: Math.min(60, Math.max(24, fps)), width: Math.round((h * 4) / 3 / 2) * 2, height: h,
    animation: 'turntable', speed: 1, yaw: 30, pitch: 12, roll: 0,
    lightYaw: -40, lightPitch: 50, lightColor: '#fff4e6', lightStrength: 2.2, ambient: 0.8, exposure: 0,
    shadow: 0.55, metal: 0.2, clipIndex: 0,
  };
}

/** Lage des Modells zur Zeit t (Sekunden): Drehung (Grad), Höhe/Versatz (in Modell-Einheiten, Modell ist 2 groß), Größe. */
export interface ModelPose { yaw: number; pitch: number; roll: number; x: number; y: number; z: number; scale: number; camOrbit: number }

const easeOut = (u: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, u)), 3);

export function modelPose(s: Model3DSpec, t: number): ModelPose {
  const T = Math.max(0.1, s.duration);
  const u = t / T;
  const p: ModelPose = { yaw: s.yaw, pitch: 0, roll: s.roll, x: 0, y: 0, z: 0, scale: 1, camOrbit: 0 };
  switch (s.animation) {
    case 'turntable': p.yaw = s.yaw + 360 * s.speed * u; break;   // ganze Umdrehungen → nahtlos wiederholbar
    case 'swing': p.yaw = s.yaw + 30 * Math.sin(2 * Math.PI * u * Math.max(1, Math.round(s.speed))); break;
    case 'float': p.y = 0.12 * Math.sin(2 * Math.PI * u * Math.max(1, Math.round(s.speed))); p.yaw = s.yaw + 8 * Math.sin(2 * Math.PI * u); break;
    case 'spinin': {
      const k = easeOut(t / Math.min(T, 1.2 / Math.max(0.3, s.speed)));
      p.scale = Math.max(0.001, k);
      p.yaw = s.yaw - 540 * (1 - k);
      p.y = 0.6 * (1 - k);
      break;
    }
    case 'flyby': p.camOrbit = -40 + 80 * u * s.speed; break;
    default: break;
  }
  return p;
}

/** Hauptlicht aus der Szene schätzen: Richtung aus dem Helligkeitsverlauf, Farbe/Stärke aus den Mittelwerten. */
export function lightFromScene(stats: FrameStats, gradient: { dx: number; dy: number }): Partial<Model3DSpec> {
  const mean = (stats.meanR + stats.meanG + stats.meanB) / 3;
  // Richtung: hellere Seite = Lichtquelle (dx > 0 → rechts heller)
  const lightYaw = Math.round(Math.max(-80, Math.min(80, gradient.dx * 160)));
  const lightPitch = Math.round(Math.max(20, Math.min(75, 45 + gradient.dy * 60)));
  // Farbe: Verhältnis der Kanäle (warm/kalt), sanft
  const norm = Math.max(1e-3, Math.max(stats.meanR, stats.meanG, stats.meanB));
  const ch = (v: number) => Math.round(255 * (0.75 + 0.25 * (v / norm))).toString(16).padStart(2, '0');
  const lightColor = `#${ch(stats.meanR)}${ch(stats.meanG)}${ch(stats.meanB)}`;
  // Dunkle Szene → weniger Licht, hartes Licht → kräftigerer Schatten
  const contrast = stats.p95 - stats.p05;
  return {
    lightYaw, lightPitch, lightColor,
    lightStrength: Math.round((0.8 + 2.4 * Math.min(1, mean * 1.6)) * 100) / 100,
    ambient: Math.round((0.35 + 0.9 * mean) * 100) / 100,
    exposure: Math.round(Math.max(-1.5, Math.min(0.8, Math.log2(Math.max(0.05, stats.p50) / 0.42))) * 100) / 100,
    shadow: Math.round(Math.max(0.2, Math.min(0.85, 0.25 + contrast * 0.8)) * 100) / 100,
  };
}
