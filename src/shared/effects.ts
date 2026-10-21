// Bausteine: Animationen und Effekte, die per Drag & Drop auf Clips gelegt werden.
import type { Clip, ImageFx, Motion, MotionKeyframe, MotionPreset, UserEffect } from './types';

export const NEUTRAL_FX: ImageFx = { vignette: 0, sharpen: 0, denoise: 0, blur: 0, grain: 0, mirror: false, flip: false };

export interface MotionState { x: number; y: number; scale: number; rotation: number; opacity: number }
export const MOTION_IDENTITY: MotionState = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

function kf(t: number, p: Partial<MotionState> = {}): MotionKeyframe {
  return { t, ...MOTION_IDENTITY, ...p };
}

/** Erzeugt die Keyframes einer Animations-Vorlage für einen Clip der Länge `dur`. */
export function motionPreset(preset: MotionPreset, dur: number, intensity = 1): MotionKeyframe[] {
  const k = Math.max(0, intensity);
  const inD = Math.min(0.6, dur / 3);
  const d = Math.max(0.1, dur);
  switch (preset) {
    case 'kenburns': return [kf(0, { scale: 1, x: -3 * k }), kf(d, { scale: 1 + 0.15 * k, x: 3 * k, y: -2 * k })];
    case 'zoomin': return [kf(0, { scale: 1 }), kf(d, { scale: 1 + 0.3 * k })];
    case 'zoomout': return [kf(0, { scale: 1 + 0.3 * k }), kf(d, { scale: 1 })];
    case 'slidein-left': return [kf(0, { x: -100 * Math.min(1, k) }), kf(inD)];
    case 'slidein-right': return [kf(0, { x: 100 * Math.min(1, k) }), kf(inD)];
    case 'slidein-up': return [kf(0, { y: 100 * Math.min(1, k) }), kf(inD)];
    case 'slidein-down': return [kf(0, { y: -100 * Math.min(1, k) }), kf(inD)];
    case 'slideout-left': return [kf(Math.max(0, d - inD)), kf(d, { x: -100 * Math.min(1, k) })];
    case 'slideout-right': return [kf(Math.max(0, d - inD)), kf(d, { x: 100 * Math.min(1, k) })];
    case 'pop': return [kf(0, { scale: 0.01, opacity: 0 }), kf(inD * 0.6, { scale: 1 + 0.12 * k, opacity: 1 }), kf(inD)];
    case 'fadein': return [kf(0, { opacity: 0 }), kf(inD)];
    case 'fadeout': return [kf(Math.max(0, d - inD)), kf(d, { opacity: 0 })];
    case 'spin': return [kf(0, { rotation: 0 }), kf(d, { rotation: 360 * Math.max(1, Math.round(k)) })];
    case 'pulse':
    case 'shake':
    case 'float':
      return [kf(0), kf(d)];
    case 'dropin': case 'slam': case 'flyin-left': case 'flyin-right': case 'rise':
      return entranceKeyframes(preset, k, d, DEFAULT_BOX).keyframes;
    case 'custom':
    default:
      return [kf(0)];
  }
}

export function createMotion(preset: MotionPreset, dur: number, intensity = 1): Motion {
  // Auftritte sind dicht abgetastet und werden linear verbunden (sonst stockt die Fallbewegung)
  const m: Motion = { preset, intensity, smooth: !ENTRANCES.has(preset), keyframes: motionPreset(preset, dur, intensity) };
  if (preset === 'shake' || preset === 'pulse' || preset === 'float') m.osc = { kind: preset, amp: intensity };
  return m;
}

// ---------- Auftritte: Objekt fällt ins Bild, schlägt auf, fährt herein ----------

export type EntranceStyle = 'dropin' | 'slam' | 'flyin-left' | 'flyin-right' | 'rise';
const ENTRANCES = new Set<MotionPreset>(['dropin', 'slam', 'flyin-left', 'flyin-right', 'rise']);
export function isEntrance(p: MotionPreset): p is EntranceStyle { return ENTRANCES.has(p); }

/** Lage des Objekts im fertigen Bild (0..1), wenn es angekommen ist. */
export interface FrameBox { x: number; y: number; w: number; h: number }
const DEFAULT_BOX: FrameBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Keyframes eines Auftritts. Das Objekt startet ganz außerhalb des Bildes (abhängig von seiner Lage `box`)
 * und kommt bei `impact` (Sekunden) auf. Stärke 0,3..2: schwerer/schneller, höherer Rückprall.
 */
export function entranceKeyframes(style: EntranceStyle, strength: number, dur: number, box: FrameBox): { keyframes: MotionKeyframe[]; impact: number | null } {
  const s = Math.max(0.2, Math.min(2, strength));
  const out: MotionKeyframe[] = [];
  const add = (t: number, p: Partial<MotionState>) => { if (t <= dur + 1e-6) out.push(kf(r2(t * 1000) / 1000, { x: r2(p.x ?? 0), y: r2(p.y ?? 0), scale: Math.round((p.scale ?? 1) * 1000) / 1000, rotation: r2(p.rotation ?? 0), opacity: r2(p.opacity ?? 1) })); };
  let impact: number | null = null;
  if (style === 'dropin') {
    const y0 = -(box.y + box.h) * 100 - 6;          // ganz oberhalb des Bildes
    const tf = Math.min(dur * 0.6, 0.62 / Math.sqrt(s));
    for (let i = 0; i <= 8; i++) { const u = i / 8; add(tf * u, { y: y0 * (1 - u * u) }); }   // Fallen (beschleunigt)
    impact = tf;
    // Rückprall: zwei kleiner werdende Hüpfer
    const h1 = Math.min(14, box.h * 100 * 0.22) * s, t1 = 0.16 + 0.1 * s;
    const h2 = h1 * 0.3, t2 = t1 * 0.55;
    for (let i = 1; i <= 6; i++) { const u = i / 6; add(tf + t1 * u, { y: -h1 * 4 * u * (1 - u), scale: i === 1 ? 1 + 0.03 * s : 1 }); }
    for (let i = 1; i <= 4; i++) { const u = i / 4; add(tf + t1 + t2 * u, { y: -h2 * 4 * u * (1 - u) }); }
  } else if (style === 'slam') {
    const S0 = 1 + 1.6 * (0.5 + 0.5 * s);
    const ts = Math.min(dur * 0.6, 0.42 / Math.pow(s, 0.3));
    for (let i = 0; i <= 8; i++) { const u = i / 8; add(ts * u, { scale: 1 + (S0 - 1) * (1 - u * u), opacity: Math.min(1, u / 0.25) }); }
    impact = ts;
    add(ts + 0.07, { scale: 1 + 0.05 * s }); add(ts + 0.2, { scale: 1 });
  } else if (style === 'flyin-left' || style === 'flyin-right') {
    const sign = style === 'flyin-left' ? -1 : 1;
    const x0 = sign < 0 ? -(box.x + box.w) * 100 - 6 : (1 - box.x) * 100 + 6;
    const tin = Math.min(dur * 0.6, 0.7 / Math.pow(s, 0.35));
    for (let i = 0; i <= 8; i++) { const u = i / 8; add(tin * u, { x: x0 * Math.pow(1 - u, 3), rotation: sign * 4 * s * (1 - u) * u * 4 * 0.25 }); }
    add(tin + 0.12, { x: -sign * 1.6 * s }); add(tin + 0.3, { x: 0 });
    impact = tin;
  } else {
    const y0 = (1 - box.y) * 100 + 6;               // von unten
    const tin = Math.min(dur * 0.6, 0.7 / Math.pow(s, 0.35));
    for (let i = 0; i <= 8; i++) { const u = i / 8; add(tin * u, { y: y0 * Math.pow(1 - u, 3) }); }
    add(tin + 0.12, { y: -1.5 * s }); add(tin + 0.3, { y: 0 });
  }
  return { keyframes: out, impact };
}

/** Zwei Bewegungen addieren (z. B. Auftritt + Erschütterung): Versatz und Drehung addiert, Größe multipliziert. */
export function combineKeyframes(a: MotionKeyframe[], b: MotionKeyframe[]): MotionKeyframe[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const ma: Motion = { preset: 'custom', intensity: 1, smooth: false, keyframes: a };
  const mb: Motion = { preset: 'custom', intensity: 1, smooth: false, keyframes: b };
  const times = Array.from(new Set([...a, ...b].map((k) => Math.round(k.t * 1000) / 1000))).sort((x, y) => x - y);
  return times.map((t) => {
    const p = motionKeyAtPublic(ma, t), q = motionKeyAtPublic(mb, t);
    return { t, x: r2(p.x + q.x), y: r2(p.y + q.y), scale: Math.round(p.scale * q.scale * 1000) / 1000, rotation: r2(p.rotation + q.rotation), opacity: r2(p.opacity * q.opacity) };
  });
}

/** Schwingungsanteil zur Zeit t (dieselben Formeln stehen als FFmpeg-Ausdruck im Export). */
export function oscAt(osc: Motion['osc'], t: number): { x: number; y: number; scale: number; rotation: number } {
  if (!osc || osc.amp <= 0) return { x: 0, y: 0, scale: 1, rotation: 0 };
  const a = osc.amp;
  switch (osc.kind) {
    case 'shake': return {
      x: a * 1.25 * (Math.sin(t * 29) + Math.sin(t * 13.7)),
      y: a * 1.25 * (Math.sin(t * 23.3 + 1) + Math.sin(t * 11.1 + 2)),
      scale: 1,
      rotation: a * 1.5 * Math.sin(t * 19.1),
    };
    case 'pulse': return { x: 0, y: 0, scale: 1 + 0.035 * a * (1 - Math.cos(2 * Math.PI * t)), rotation: 0 };
    case 'float': return { x: 0, y: 2 * a * Math.sin((2 * Math.PI * t) / 1.5), scale: 1, rotation: 0 };
  }
  return { x: 0, y: 0, scale: 1, rotation: 0 };
}

const ease = (u: number) => u * u * (3 - 2 * u);

/** Animationszustand zur Clip-Zeit t. */
export function motionAt(m: Motion | undefined, t: number): MotionState {
  if (!m || m.keyframes.length === 0) return MOTION_IDENTITY;
  const base = motionKeyAt(m, t);
  if (!m.osc) return base;
  const o = oscAt(m.osc, t);
  return { x: base.x + o.x, y: base.y + o.y, scale: base.scale * o.scale, rotation: base.rotation + o.rotation, opacity: base.opacity };
}

function motionKeyAt(m: Motion, t: number): MotionState {
  const k = m.keyframes;
  if (t <= k[0].t) return pick(k[0]);
  if (t >= k[k.length - 1].t) return pick(k[k.length - 1]);
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (t >= a.t && t <= b.t) {
      let u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      if (m.smooth) u = ease(u);
      if (m.curve && k.length > 2) {
        const p0 = k[Math.max(0, i - 1)], p3 = k[Math.min(k.length - 1, i + 2)];
        return {
          x: catmull(p0.x, a.x, b.x, p3.x, u), y: catmull(p0.y, a.y, b.y, p3.y, u), scale: a.scale + (b.scale - a.scale) * u,
          rotation: a.rotation + (b.rotation - a.rotation) * u, opacity: a.opacity + (b.opacity - a.opacity) * u,
        };
      }
      return {
        x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, scale: a.scale + (b.scale - a.scale) * u,
        rotation: a.rotation + (b.rotation - a.rotation) * u, opacity: a.opacity + (b.opacity - a.opacity) * u,
      };
    }
  }
  return pick(k[k.length - 1]);
}

/** Catmull-Rom-Kurve durch p1 → p2 (p0/p3 = Nachbarn) – gleiche Formel im Export (motionExpr.ts). */
export function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

function pick(k: MotionKeyframe): MotionState {
  return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity };
}

// ---------- Bibliothek ----------

export type BlockKind = 'motion' | 'look' | 'fx';

export interface EffectBlock {
  id: string;
  kind: BlockKind;
  name: string;
  group: string;
  icon: string;          // Emoji/Zeichen für die Kachel
  apply: (clip: Clip) => Partial<Clip>;
}

const fx = (clip: Clip, p: Partial<ImageFx>): Partial<Clip> => ({ fx: { ...NEUTRAL_FX, ...(clip.fx ?? {}), ...p } });
const look = (clip: Clip, id: string): Partial<Clip> => ({ color: { ...clip.color, look: id, lookStrength: clip.color.lookStrength ?? 1 } });
const motion = (clip: Clip, preset: MotionPreset, dur: number): Partial<Clip> => ({ motion: createMotion(preset, dur, clip.motion?.intensity ?? 1) });

export const EFFECT_BLOCKS: Array<Omit<EffectBlock, 'apply'> & { apply: (clip: Clip, dur: number) => Partial<Clip> }> = [
  // Animationen
  { id: 'm-kenburns', kind: 'motion', name: 'Ken Burns', group: 'Animation', icon: '🎞', apply: (c, d) => motion(c, 'kenburns', d) },
  { id: 'm-zoomin', kind: 'motion', name: 'Einzoomen', group: 'Animation', icon: '🔍', apply: (c, d) => motion(c, 'zoomin', d) },
  { id: 'm-zoomout', kind: 'motion', name: 'Auszoomen', group: 'Animation', icon: '🔎', apply: (c, d) => motion(c, 'zoomout', d) },
  { id: 'm-slidein-left', kind: 'motion', name: 'Von links', group: 'Animation', icon: '⇢', apply: (c, d) => motion(c, 'slidein-left', d) },
  { id: 'm-slidein-right', kind: 'motion', name: 'Von rechts', group: 'Animation', icon: '⇠', apply: (c, d) => motion(c, 'slidein-right', d) },
  { id: 'm-slidein-up', kind: 'motion', name: 'Von unten', group: 'Animation', icon: '⇡', apply: (c, d) => motion(c, 'slidein-up', d) },
  { id: 'm-slidein-down', kind: 'motion', name: 'Von oben', group: 'Animation', icon: '⇣', apply: (c, d) => motion(c, 'slidein-down', d) },
  { id: 'm-slideout-left', kind: 'motion', name: 'Nach links raus', group: 'Animation', icon: '⇠', apply: (c, d) => motion(c, 'slideout-left', d) },
  { id: 'm-pop', kind: 'motion', name: 'Aufploppen', group: 'Animation', icon: '✨', apply: (c, d) => motion(c, 'pop', d) },
  { id: 'm-pulse', kind: 'motion', name: 'Pulsieren', group: 'Animation', icon: '💓', apply: (c, d) => motion(c, 'pulse', d) },
  { id: 'm-shake', kind: 'motion', name: 'Wackeln', group: 'Animation', icon: '〰', apply: (c, d) => motion(c, 'shake', d) },
  { id: 'm-float', kind: 'motion', name: 'Schweben', group: 'Animation', icon: '🎈', apply: (c, d) => motion(c, 'float', d) },
  { id: 'm-spin', kind: 'motion', name: 'Drehen', group: 'Animation', icon: '⟳', apply: (c, d) => motion(c, 'spin', d) },
  { id: 'm-fadein', kind: 'motion', name: 'Einblenden', group: 'Animation', icon: '◐', apply: (c, d) => motion(c, 'fadein', d) },
  { id: 'm-fadeout', kind: 'motion', name: 'Ausblenden', group: 'Animation', icon: '◑', apply: (c, d) => motion(c, 'fadeout', d) },
  { id: 'm-dropin', kind: 'motion', name: 'Herabfallen', group: 'Animation', icon: '⤓', apply: (c, d) => motion(c, 'dropin', d) },
  { id: 'm-slam', kind: 'motion', name: 'Aufschlagen', group: 'Animation', icon: '💢', apply: (c, d) => motion(c, 'slam', d) },
  { id: 'm-flyin-left', kind: 'motion', name: 'Hereinrasen', group: 'Animation', icon: '🏎', apply: (c, d) => motion(c, 'flyin-left', d) },
  // Looks
  { id: 'l-warm', kind: 'look', name: 'Warm', group: 'Look', icon: '🌅', apply: (c) => look(c, 'warm') },
  { id: 'l-cool', kind: 'look', name: 'Kühl', group: 'Look', icon: '❄', apply: (c) => look(c, 'cool') },
  { id: 'l-cinema', kind: 'look', name: 'Kino', group: 'Look', icon: '🎬', apply: (c) => look(c, 'cinema') },
  { id: 'l-teal', kind: 'look', name: 'Teal & Orange', group: 'Look', icon: '🟧', apply: (c) => look(c, 'teal') },
  { id: 'l-vivid', kind: 'look', name: 'Lebendig', group: 'Look', icon: '🌈', apply: (c) => look(c, 'vivid') },
  { id: 'l-vintage', kind: 'look', name: 'Vintage', group: 'Look', icon: '📼', apply: (c) => look(c, 'vintage') },
  { id: 'l-matte', kind: 'look', name: 'Matt', group: 'Look', icon: '▫', apply: (c) => look(c, 'matte') },
  { id: 'l-bw', kind: 'look', name: 'Schwarzweiß', group: 'Look', icon: '⚫', apply: (c) => look(c, 'bw') },
  { id: 'l-sepia', kind: 'look', name: 'Sepia', group: 'Look', icon: '🟫', apply: (c) => look(c, 'sepia') },
  { id: 'l-drone', kind: 'look', name: 'Drohne', group: 'Look', icon: '🚁', apply: (c) => look(c, 'drone') },
  // Bild-Effekte
  { id: 'f-vignette', kind: 'fx', name: 'Vignette', group: 'Effekt', icon: '◉', apply: (c) => fx(c, { vignette: 0.5 }) },
  { id: 'f-sharpen', kind: 'fx', name: 'Schärfen', group: 'Effekt', icon: '◆', apply: (c) => fx(c, { sharpen: 0.5 }) },
  { id: 'f-denoise', kind: 'fx', name: 'Rauschen entfernen', group: 'Effekt', icon: '▒', apply: (c) => fx(c, { denoise: 0.5 }) },
  { id: 'f-blur', kind: 'fx', name: 'Weichzeichnen', group: 'Effekt', icon: '◌', apply: (c) => fx(c, { blur: 0.4 }) },
  { id: 'f-grain', kind: 'fx', name: 'Filmkorn', group: 'Effekt', icon: '░', apply: (c) => fx(c, { grain: 0.4 }) },
  { id: 'f-mirror', kind: 'fx', name: 'Spiegeln', group: 'Effekt', icon: '⇋', apply: (c) => fx(c, { mirror: !(c.fx?.mirror) }) },
];

/** Hat ein Clip eine Animation, die nicht neutral ist? */
export function hasMotion(m: Motion | undefined): boolean {
  if (!m) return false;
  if (m.osc && m.osc.amp > 0) return true;
  return m.keyframes.some((k) => Math.abs(k.x) > 1e-4 || Math.abs(k.y) > 1e-4 || Math.abs(k.scale - 1) > 1e-4 || Math.abs(k.rotation) > 1e-4 || Math.abs(k.opacity - 1) > 1e-4);
}

export function hasOpacityMotion(m: Motion | undefined): boolean {
  return !!m && m.keyframes.some((k) => Math.abs(k.opacity - 1) > 1e-4);
}

export function hasGeometryMotion(m: Motion | undefined): boolean {
  if (!m) return false;
  if (m.osc && m.osc.amp > 0) return true;
  return m.keyframes.some((k) => Math.abs(k.x) > 1e-4 || Math.abs(k.y) > 1e-4 || Math.abs(k.scale - 1) > 1e-4 || Math.abs(k.rotation) > 1e-4);
}

// ---------- Eigene Effekte ----------

/** Aktuelle Einstellungen eines Clips als eigenen Effekt speichern. */
export function userEffectFromClip(clip: Clip, name: string, dur: number, id: string): UserEffect {
  const ue: UserEffect = { id, name, createdAt: Date.now() };
  ue.color = { ...clip.color };
  if (clip.fx) ue.fx = { ...clip.fx };
  if (clip.crop && (clip.crop.left || clip.crop.right || clip.crop.top || clip.crop.bottom)) ue.crop = { ...clip.crop };
  if (hasMotion(clip.motion)) { ue.motion = JSON.parse(JSON.stringify(clip.motion)) as Motion; ue.motionDuration = dur; }
  return ue;
}

/** Eigenen Effekt auf einen Clip anwenden (Animationen werden auf die Clip-Länge umgerechnet). */
export function applyUserEffect(clip: Clip, ue: UserEffect, dur: number): Partial<Clip> {
  const p: Partial<Clip> = {};
  if (ue.color) p.color = { ...ue.color };
  if (ue.fx) p.fx = { ...NEUTRAL_FX, ...ue.fx };
  if (ue.crop) p.crop = { ...ue.crop };
  if (ue.motion) {
    const m = ue.motion;
    if (m.preset !== 'custom') {
      p.motion = { ...createMotion(m.preset, dur, m.intensity), smooth: m.smooth };
    } else {
      const k = ue.motionDuration && ue.motionDuration > 0 ? dur / ue.motionDuration : 1;
      p.motion = { ...m, keyframes: m.keyframes.map((x) => ({ ...x, t: x.t * k })) };
    }
  }
  return p;
}

/** Animations-Vorlagen für die Auswahl im Inspektor. */
export const MOTION_PRESETS: Array<{ id: MotionPreset; name: string }> = [
  { id: 'kenburns', name: 'Ken Burns (langsam zoomen)' },
  { id: 'zoomin', name: 'Einzoomen' },
  { id: 'zoomout', name: 'Auszoomen' },
  { id: 'slidein-left', name: 'Von links hereinschieben' },
  { id: 'slidein-right', name: 'Von rechts hereinschieben' },
  { id: 'slidein-up', name: 'Von unten hereinschieben' },
  { id: 'slidein-down', name: 'Von oben hereinschieben' },
  { id: 'slideout-left', name: 'Nach links hinausschieben' },
  { id: 'slideout-right', name: 'Nach rechts hinausschieben' },
  { id: 'pop', name: 'Aufploppen' },
  { id: 'pulse', name: 'Pulsieren' },
  { id: 'shake', name: 'Wackeln' },
  { id: 'float', name: 'Schweben' },
  { id: 'spin', name: 'Drehen' },
  { id: 'fadein', name: 'Einblenden' },
  { id: 'fadeout', name: 'Ausblenden' },
  { id: 'dropin', name: 'Herabfallen (mit Aufprall)' },
  { id: 'slam', name: 'Aufschlagen (aus der Kamera)' },
  { id: 'flyin-left', name: 'Von links hereinrasen' },
  { id: 'flyin-right', name: 'Von rechts hereinrasen' },
  { id: 'rise', name: 'Von unten auftauchen' },
  { id: 'custom', name: 'Eigene Keyframes' },
];

/** Keyframe am Zeitpunkt t einfügen (Werte = aktueller Zustand), sortiert. */
export function insertKeyframe(m: Motion, t: number): Motion {
  const st = motionKeyAtPublic(m, t);
  const others = m.keyframes.filter((k) => Math.abs(k.t - t) > 1e-3);
  const kfs = [...others, { t, ...st }].sort((a, b) => a.t - b.t);
  return { ...m, preset: 'custom', keyframes: kfs };
}

/** Keyframe-Zustand ohne Schwingung (für das Teilen von Clips). */
export function motionKeyAtPublic(m: Motion, t: number): MotionState {
  if (m.keyframes.length === 0) return { ...MOTION_IDENTITY };
  return motionKeyAt(m, t);
}
