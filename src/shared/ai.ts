// Gemeinsame KI-Hilfen: COCO-Klassen (deutsch), Track-Interpolation.
import type { ObjectTrack, TrackBox } from './types';

export const COCO_LABELS_DE: Array<{ en: string; de: string; group: 'person' | 'animal' | 'vehicle' | 'object' }> = [
  { en: 'person', de: 'Person', group: 'person' }, { en: 'bicycle', de: 'Fahrrad', group: 'vehicle' }, { en: 'car', de: 'Auto', group: 'vehicle' },
  { en: 'motorcycle', de: 'Motorrad', group: 'vehicle' }, { en: 'airplane', de: 'Flugzeug', group: 'vehicle' }, { en: 'bus', de: 'Bus', group: 'vehicle' },
  { en: 'train', de: 'Zug', group: 'vehicle' }, { en: 'truck', de: 'Lkw', group: 'vehicle' }, { en: 'boat', de: 'Boot', group: 'vehicle' },
  { en: 'traffic light', de: 'Ampel', group: 'object' }, { en: 'fire hydrant', de: 'Hydrant', group: 'object' }, { en: 'stop sign', de: 'Stoppschild', group: 'object' },
  { en: 'parking meter', de: 'Parkuhr', group: 'object' }, { en: 'bench', de: 'Bank', group: 'object' }, { en: 'bird', de: 'Vogel', group: 'animal' },
  { en: 'cat', de: 'Katze', group: 'animal' }, { en: 'dog', de: 'Hund', group: 'animal' }, { en: 'horse', de: 'Pferd', group: 'animal' },
  { en: 'sheep', de: 'Schaf', group: 'animal' }, { en: 'cow', de: 'Kuh', group: 'animal' }, { en: 'elephant', de: 'Elefant', group: 'animal' },
  { en: 'bear', de: 'Bär', group: 'animal' }, { en: 'zebra', de: 'Zebra', group: 'animal' }, { en: 'giraffe', de: 'Giraffe', group: 'animal' },
  { en: 'backpack', de: 'Rucksack', group: 'object' }, { en: 'umbrella', de: 'Schirm', group: 'object' }, { en: 'handbag', de: 'Handtasche', group: 'object' },
  { en: 'tie', de: 'Krawatte', group: 'object' }, { en: 'suitcase', de: 'Koffer', group: 'object' }, { en: 'frisbee', de: 'Frisbee', group: 'object' },
  { en: 'skis', de: 'Ski', group: 'object' }, { en: 'snowboard', de: 'Snowboard', group: 'object' }, { en: 'sports ball', de: 'Ball', group: 'object' },
  { en: 'kite', de: 'Drachen', group: 'object' }, { en: 'baseball bat', de: 'Baseballschläger', group: 'object' }, { en: 'baseball glove', de: 'Baseballhandschuh', group: 'object' },
  { en: 'skateboard', de: 'Skateboard', group: 'object' }, { en: 'surfboard', de: 'Surfbrett', group: 'object' }, { en: 'tennis racket', de: 'Tennisschläger', group: 'object' },
  { en: 'bottle', de: 'Flasche', group: 'object' }, { en: 'wine glass', de: 'Weinglas', group: 'object' }, { en: 'cup', de: 'Tasse', group: 'object' },
  { en: 'fork', de: 'Gabel', group: 'object' }, { en: 'knife', de: 'Messer', group: 'object' }, { en: 'spoon', de: 'Löffel', group: 'object' },
  { en: 'bowl', de: 'Schüssel', group: 'object' }, { en: 'banana', de: 'Banane', group: 'object' }, { en: 'apple', de: 'Apfel', group: 'object' },
  { en: 'sandwich', de: 'Sandwich', group: 'object' }, { en: 'orange', de: 'Orange', group: 'object' }, { en: 'broccoli', de: 'Brokkoli', group: 'object' },
  { en: 'carrot', de: 'Karotte', group: 'object' }, { en: 'hot dog', de: 'Hotdog', group: 'object' }, { en: 'pizza', de: 'Pizza', group: 'object' },
  { en: 'donut', de: 'Donut', group: 'object' }, { en: 'cake', de: 'Kuchen', group: 'object' }, { en: 'chair', de: 'Stuhl', group: 'object' },
  { en: 'couch', de: 'Sofa', group: 'object' }, { en: 'potted plant', de: 'Topfpflanze', group: 'object' }, { en: 'bed', de: 'Bett', group: 'object' },
  { en: 'dining table', de: 'Tisch', group: 'object' }, { en: 'toilet', de: 'Toilette', group: 'object' }, { en: 'tv', de: 'Fernseher', group: 'object' },
  { en: 'laptop', de: 'Laptop', group: 'object' }, { en: 'mouse', de: 'Maus', group: 'object' }, { en: 'remote', de: 'Fernbedienung', group: 'object' },
  { en: 'keyboard', de: 'Tastatur', group: 'object' }, { en: 'cell phone', de: 'Handy', group: 'object' }, { en: 'microwave', de: 'Mikrowelle', group: 'object' },
  { en: 'oven', de: 'Ofen', group: 'object' }, { en: 'toaster', de: 'Toaster', group: 'object' }, { en: 'sink', de: 'Spüle', group: 'object' },
  { en: 'refrigerator', de: 'Kühlschrank', group: 'object' }, { en: 'book', de: 'Buch', group: 'object' }, { en: 'clock', de: 'Uhr', group: 'object' },
  { en: 'vase', de: 'Vase', group: 'object' }, { en: 'scissors', de: 'Schere', group: 'object' }, { en: 'teddy bear', de: 'Teddybär', group: 'object' },
  { en: 'hair drier', de: 'Föhn', group: 'object' }, { en: 'toothbrush', de: 'Zahnbürste', group: 'object' },
];

export const TRACK_COLORS = ['#3dd6c1', '#f5b342', '#ef5b6b', '#a07fd1', '#4a8cc9', '#4fb086', '#e07a3f', '#d94fa0'];

/** Box eines Tracks zur Zeit t (linear interpoliert; außerhalb: nächste Box). */
export function trackBoxAt(track: ObjectTrack, t: number): TrackBox | null {
  const b = track.boxes;
  if (b.length === 0) return null;
  if (t <= b[0].t) return b[0];
  if (t >= b[b.length - 1].t) return b[b.length - 1];
  for (let i = 0; i < b.length - 1; i++) {
    const a = b[i], c = b[i + 1];
    if (t >= a.t && t <= c.t) {
      const u = (t - a.t) / Math.max(1e-6, c.t - a.t);
      return { t, x: a.x + (c.x - a.x) * u, y: a.y + (c.y - a.y) * u, w: a.w + (c.w - a.w) * u, h: a.h + (c.h - a.h) * u };
    }
  }
  return b[b.length - 1];
}

/** Ist der Track zur Zeit t vorhanden (zwischen erster und letzter Box)? */
export function trackActiveAt(track: ObjectTrack, t: number): boolean {
  const b = track.boxes;
  return b.length > 0 && t >= b[0].t - 0.3 && t <= b[b.length - 1].t + 0.3;
}

/** Nächstliegende Maske zur Zeit t. */
export function maskAt(track: ObjectTrack, t: number): { t: number; path: string } | null {
  const m = track.masks;
  if (!m || m.length === 0) return null;
  let best = m[0];
  for (const x of m) if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x;
  return best;
}

export function boxIou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}
