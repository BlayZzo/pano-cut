// Teilstück eines Clips herausschneiden – inklusive aller Clip-lokalen Zeiten (360°-Blick, Animation,
// Belichtungskurve, Untertitel, getrackte Objekte), damit Teilen und der Auto-Musik-Schnitt nichts verschieben.
import type { Clip, ObjectTrack } from './types';
import { clipDuration, MIN_CLIP_DURATION, sourceTimeAt } from './timeline';
import { panoViewAt } from './pano';
import { motionKeyAtPublic } from './effects';
import { exposureAt } from './color';
import { reframeAt } from './reframe';

const EPS = 1e-4;

function sliceKeys<T extends { t: number }>(keys: T[], from: number, dur: number, at: (t: number) => Omit<T, 't'>): T[] {
  const inside = keys.filter((k) => k.t > from + EPS && k.t < from + dur - EPS).map((k) => ({ ...k, t: k.t - from }));
  return [{ ...at(from), t: 0 } as T, ...inside, { ...at(from + dur), t: dur } as T];
}

/** Stichproben (Boxen, Masken) auf den Ausschnitt verschieben; die letzte davor wird an den Anfang gesetzt. */
function sliceSamples<T extends { t: number }>(items: T[] | undefined, from: number, dur: number): T[] | undefined {
  if (!items) return items;
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const out: T[] = [];
  let before: T | undefined;
  for (const it of sorted) {
    if (it.t < from - EPS) before = it;
    else if (it.t <= from + dur + EPS) out.push({ ...it, t: Math.max(0, it.t - from) });
  }
  if (before && (out.length === 0 || out[0].t > EPS)) out.unshift({ ...before, t: 0 });
  return out;
}

/** Verschiebt alle Clip-lokalen Zeiten so, dass der neue Clip bei `from` (Sekunden ab altem Clip-Anfang) beginnt und `dur` lang ist. */
export function shiftClipTimes(c: Clip, from: number, dur: number): Clip {
  const out: Clip = { ...c };
  if (c.pano && c.pano.keyframes.length > 1) {
    out.pano = { ...c.pano, keyframes: sliceKeys(c.pano.keyframes, from, dur, (t) => panoViewAt(c.pano!, t)) };
  }
  if (c.reframe && c.reframe.keyframes.length > 1) {
    out.reframe = { ...c.reframe, keyframes: sliceKeys(c.reframe.keyframes, from, dur, (t) => reframeAt(c.reframe!, t)) };
  }
  if (c.motion && c.motion.keyframes.length > 1) {
    out.motion = { ...c.motion, preset: 'custom', keyframes: sliceKeys(c.motion.keyframes, from, dur, (t) => motionKeyAtPublic(c.motion!, t)) };
  }
  if (c.color.exposureCurve && c.color.exposureCurve.length > 1) {
    out.color = { ...c.color, exposureCurve: sliceKeys(c.color.exposureCurve, from, dur, (t) => ({ ev: exposureAt(c.color, t) })) };
  }
  if (c.subtitles) {
    const segs = c.subtitles.segments
      .filter((s) => s.end > from + EPS && s.start < from + dur - EPS)
      .map((s) => ({ ...s, start: Math.max(0, s.start - from), end: Math.min(dur, s.end - from), words: s.words?.map((w) => ({ ...w, start: w.start - from, end: w.end - from })) }));
    out.subtitles = { ...c.subtitles, segments: segs };
  }
  if (c.objects) {
    out.objects = c.objects.map((o): ObjectTrack => ({
      ...o,
      boxes: sliceSamples(o.boxes, from, dur) ?? [],
      masks: sliceSamples(o.masks, from, dur),
      keys: o.keys ? sliceSamples(o.keys, from, dur) : o.keys,
    }));
  }
  return out;
}

/**
 * Teil eines Clips von `from` bis `to` (Sekunden ab Clip-Anfang auf der Timeline) als neuer Clip mit `id`.
 * Der neue Clip liegt an derselben Stelle der Timeline wie das Stück im Original.
 */
export function sliceClip(c: Clip, from: number, to: number, id: string): Clip {
  const dur = clipDuration(c);
  const a = Math.max(0, Math.min(dur - MIN_CLIP_DURATION, from));
  const b = Math.max(a + MIN_CLIP_DURATION, Math.min(dur, to));
  const sa = sourceTimeAt(c, c.start + a), sb = sourceTimeAt(c, c.start + b);
  let out: Clip = {
    ...c,
    id,
    start: c.start + a,
    in: c.reverse ? sb : sa,
    out: c.reverse ? sa : sb,
  };
  out = shiftClipTimes(out, a, b - a);
  if (a > EPS) { out.fadeIn = 0; out.transition = undefined; }
  if (b < dur - EPS) out.fadeOut = 0;
  return out;
}

/** Alle Clip-lokalen Zeiten mit `k` multiplizieren (z. B. wenn ein Clip langsamer abgespielt wird). */
export function scaleClipTimes(c: Clip, k: number): Clip {
  return retimeClipTimes(c, k, 0);
}

/** Alle Clip-lokalen Zeiten umrechnen: t' = a·t + b (Keyframes, Belichtungskurve, Untertitel, Objekte/Masken). */
export function retimeClipTimes(c: Clip, a: number, b: number): Clip {
  if (Math.abs(a - 1) < 1e-9 && Math.abs(b) < 1e-9) return c;
  const f = (t: number) => a * t + b;
  const keys = <T extends { t: number }>(ks: T[]): T[] => {
    const out = ks.map((x) => ({ ...x, t: f(x.t) }));
    return a < 0 ? out.reverse() : out;   // Richtung umgedreht (Rückwärts) → Reihenfolge wieder aufsteigend
  };
  const out: Clip = { ...c };
  if (c.pano) out.pano = { ...c.pano, keyframes: keys(c.pano.keyframes) };
  if (c.reframe) out.reframe = { ...c.reframe, keyframes: keys(c.reframe.keyframes) };
  if (c.motion) out.motion = { ...c.motion, keyframes: keys(c.motion.keyframes) };
  if (c.color.exposureCurve) out.color = { ...c.color, exposureCurve: keys(c.color.exposureCurve) };
  if (c.subtitles) {
    const seg = (s0: number, s1: number) => (a < 0 ? [f(s1), f(s0)] : [f(s0), f(s1)]);
    out.subtitles = { ...c.subtitles, segments: c.subtitles.segments.map((s) => {
      const [st, en] = seg(s.start, s.end);
      return { ...s, start: st, end: en, words: s.words?.map((w) => { const [ws, we] = seg(w.start, w.end); return { ...w, start: ws, end: we }; }) };
    }) };
  }
  if (c.objects) out.objects = c.objects.map((o) => ({ ...o, boxes: keys(o.boxes), masks: o.masks ? keys(o.masks) : o.masks, keys: o.keys ? keys(o.keys) : o.keys }));
  return out;
}

/**
 * Keyframes kleben am Video, nicht an der Timeline: Nach einer Änderung von In/Out, Tempo oder Rückwärts
 * werden alle Clip-lokalen Zeiten so umgerechnet, dass sie wieder auf dasselbe Bild der Quelle zeigen.
 */
export function anchorClipTimes(old: Clip, next: Clip): Clip {
  if (old.in === next.in && old.out === next.out && old.speed === next.speed && old.reverse === next.reverse) return next;
  // Quellzeit eines alten Clip-Zeitpunkts t: src = in + t·speed (vorwärts) bzw. out − t·speed (rückwärts)
  const sa = old.reverse ? -old.speed : old.speed;
  const sb = old.reverse ? old.out : old.in;
  // Neuer Clip-Zeitpunkt zu src: (src − in')/speed' bzw. (out' − src)/speed'
  const inv = next.reverse ? -1 / next.speed : 1 / next.speed;
  const base = next.reverse ? next.out / next.speed : -next.in / next.speed;
  // t' = inv·(sa·t + sb) + base
  return retimeClipTimes(next, inv * sa, inv * sb + base);
}
