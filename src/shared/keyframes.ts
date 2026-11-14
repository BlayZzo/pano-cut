// Keyframes aller Arten einheitlich ansprechen: anzeigen, auswählen, verschieben, löschen.
// Alle Zeiten sind Clip-lokal (Sekunden ab Clip-Anfang auf der Timeline).
import type { Clip } from './types';
import { clipDuration } from './timeline';

export type KeyframeKind = 'pano' | 'reframe' | 'motion';

export interface KeyRef {
  clipId: string;
  kind: KeyframeKind;
  t: number;
}

const EPS = 1e-4;

/** Eindeutiger Schlüssel einer Markierung (Zeit auf Millisekunden gerundet). */
export function keyId(clipId: string, kind: KeyframeKind, t: number): string {
  return `${clipId}|${kind}|${Math.round(t * 1000)}`;
}

export function parseKeyId(id: string): KeyRef | null {
  const [clipId, kind, ms] = id.split('|');
  if (!clipId || !kind || ms === undefined) return null;
  return { clipId, kind: kind as KeyframeKind, t: Number(ms) / 1000 };
}

function list(clip: Clip, kind: KeyframeKind): Array<{ t: number }> | undefined {
  if (kind === 'pano') return clip.pano?.keyframes;
  if (kind === 'reframe') return clip.reframe?.keyframes;
  return clip.motion?.keyframes;
}

/**
 * Sichtbare Keyframes eines Clips. Eine einzelne Markierung ist nur eine feste Einstellung (keine Fahrt)
 * und wird bei 360°/Ausschnitt nicht angezeigt; Animationen zeigen jede Markierung.
 */
export function clipKeyframes(clip: Clip): KeyRef[] {
  const out: KeyRef[] = [];
  const kinds: KeyframeKind[] = ['pano', 'reframe', 'motion'];
  for (const kind of kinds) {
    const ks = list(clip, kind);
    if (!ks || ks.length === 0) continue;
    if (kind !== 'motion' && ks.length < 2) continue;
    for (const k of ks) out.push({ clipId: clip.id, kind, t: k.t });
  }
  return out;
}

/** Findet die Markierung zu einer Auswahl (Toleranz 1 ms). */
function matches(k: { t: number }, ref: KeyRef): boolean {
  return Math.abs(k.t - ref.t) < 0.0015;
}

/** Wie weit sich die Auswahl verschieben lässt, ohne den Clip zu verlassen oder auf eine andere Markierung zu treffen. */
export function clampKeyShift(clip: Clip, refs: KeyRef[], dt: number, minGap: number): number {
  const dur = clipDuration(clip);
  let lo = -Infinity, hi = Infinity;
  for (const kind of ['pano', 'reframe', 'motion'] as KeyframeKind[]) {
    const ks = list(clip, kind);
    if (!ks) continue;
    const sel = refs.filter((r) => r.kind === kind);
    if (sel.length === 0) continue;
    const moving = ks.filter((k) => sel.some((r) => matches(k, r)));
    const fixed = ks.filter((k) => !sel.some((r) => matches(k, r)));
    for (const k of moving) {
      lo = Math.max(lo, -k.t);
      hi = Math.min(hi, Math.max(0, dur - k.t));   // liegt sie hinter dem Clip-Ende (nach Kürzen), darf sie zurück
      // Nicht über feste Nachbarn hinweg (Reihenfolge bleibt, sonst springt die Fahrt)
      for (const f of fixed) {
        if (f.t < k.t) lo = Math.max(lo, f.t - k.t + minGap);
        else hi = Math.min(hi, f.t - k.t - minGap);
      }
    }
  }
  if (lo > hi) return 0;
  return Math.min(hi, Math.max(lo, dt));
}

/** Verschiebt die ausgewählten Markierungen eines Clips um dt (vorher mit clampKeyShift begrenzen). */
export function shiftKeyframes(clip: Clip, refs: KeyRef[], dt: number): Partial<Clip> {
  const patch: Partial<Clip> = {};
  const move = <T extends { t: number }>(ks: T[], kind: KeyframeKind): T[] => {
    const sel = refs.filter((r) => r.kind === kind);
    return ks.map((k) => (sel.some((r) => matches(k, r)) ? { ...k, t: Math.max(0, k.t + dt) } : k)).sort((a, b) => a.t - b.t);
  };
  if (clip.pano && refs.some((r) => r.kind === 'pano')) patch.pano = { ...clip.pano, keyframes: move(clip.pano.keyframes, 'pano') };
  if (clip.reframe && refs.some((r) => r.kind === 'reframe')) patch.reframe = { ...clip.reframe, keyframes: move(clip.reframe.keyframes, 'reframe') };
  if (clip.motion && refs.some((r) => r.kind === 'motion')) patch.motion = { ...clip.motion, preset: 'custom', keyframes: move(clip.motion.keyframes, 'motion') };
  return patch;
}

/**
 * Löscht die ausgewählten Markierungen. 360°-Ansicht und Ausschnitt behalten immer mindestens eine
 * (sonst gäbe es keine Blickrichtung mehr) – es bleibt die Markierung, die am nächsten am Anfang liegt.
 */
export function deleteKeyframes(clip: Clip, refs: KeyRef[]): Partial<Clip> {
  const patch: Partial<Clip> = {};
  const keep = <T extends { t: number }>(ks: T[], kind: KeyframeKind, min: number): T[] => {
    const sel = refs.filter((r) => r.kind === kind);
    const rest = ks.filter((k) => !sel.some((r) => matches(k, r)));
    if (rest.length >= min) return rest;
    // Alles ausgewählt: die erste behalten, auf den Clip-Anfang gelegt
    return ks.length ? [{ ...ks[0], t: 0 }] : rest;
  };
  if (clip.pano && refs.some((r) => r.kind === 'pano')) patch.pano = { ...clip.pano, keyframes: keep(clip.pano.keyframes, 'pano', 1) };
  if (clip.reframe && refs.some((r) => r.kind === 'reframe')) patch.reframe = { ...clip.reframe, keyframes: keep(clip.reframe.keyframes, 'reframe', 1) };
  if (clip.motion && refs.some((r) => r.kind === 'motion')) patch.motion = { ...clip.motion, preset: 'custom', keyframes: keep(clip.motion.keyframes, 'motion', 0) };
  return patch;
}

/** Auswahl auf die genauen Zeiten der Markierungen im Clip abbilden (Schlüssel sind auf ms gerundet). */
export function exactRefs(clip: Clip, refs: KeyRef[]): KeyRef[] {
  return refs.map((r) => {
    const k = list(clip, r.kind)?.find((x) => matches(x, r));
    return k ? { ...r, t: k.t } : r;
  });
}

/** Gruppiert Auswahl-Schlüssel nach Clip. */
export function groupByClip(ids: string[]): Map<string, KeyRef[]> {
  const m = new Map<string, KeyRef[]>();
  for (const id of ids) {
    const r = parseKeyId(id);
    if (!r) continue;
    if (!m.has(r.clipId)) m.set(r.clipId, []);
    m.get(r.clipId)!.push(r);
  }
  return m;
}

export const KEYFRAME_EPS = EPS;
