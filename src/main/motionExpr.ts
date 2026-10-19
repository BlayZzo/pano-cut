// Animationen als FFmpeg-Ausdrücke (perspective-Filter, Auswertung pro Bild).
// Dieselben Formeln stehen in src/shared/effects.ts (motionAt/oscAt) für die Vorschau.
import type { ColorGrade, Motion, MotionKeyframe, Transform } from '@shared/types';

function f(n: number): string {
  return (Math.round(n * 1e5) / 1e5).toString();
}

/** Stückweise (linear oder weich) interpolierte Funktion als verschachtelter if()-Ausdruck. */
function piecewise(kfs: MotionKeyframe[], key: keyof Omit<MotionKeyframe, 't'>, smooth: boolean, T: string): string {
  if (kfs.length === 0) return '0';
  const vals = kfs.map((k) => k[key]);
  if (vals.every((v) => Math.abs(v - vals[0]) < 1e-6)) return f(vals[0]);
  let expr = f(vals[vals.length - 1]);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i], b = kfs[i + 1];
    const span = Math.max(1e-4, b.t - a.t);
    const u = `clip((${T}-${f(a.t)})/${f(span)},0,1)`;
    const e = smooth ? `(${u}*${u}*(3-2*${u}))` : u;
    expr = `if(lt(${T},${f(b.t)}),${f(a[key])}+(${f(b[key] - a[key])})*${e},${expr})`;
  }
  // vor dem ersten Keyframe: erster Wert
  return `if(lt(${T},${f(kfs[0].t)}),${f(vals[0])},${expr})`;
}

/**
 * Liefert die acht Eckpunkt-Ausdrücke (x0,y0 … x3,y3) für `perspective=sense=destination`.
 * Das Eingangsbild ist eine Fläche in Ausgabegröße (W×H), die um ihre Mitte bewegt wird.
 */
export function perspectiveCorners(m: Motion, base: Transform, W: number, H: number, fps: number, offset: number, border = 0): string[] {
  const T = `(in/${f(fps)}+${f(offset)})`;
  const kfs = m.keyframes.length ? m.keyframes : [{ t: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }];
  let X = `(${f(base.x)}+${piecewise(kfs, 'x', m.smooth, T)})`;
  let Y = `(${f(base.y)}+${piecewise(kfs, 'y', m.smooth, T)})`;
  let S = `(${f(base.scale)}*${piecewise(kfs, 'scale', m.smooth, T)})`;
  let R = `(${f(base.rotation)}+${piecewise(kfs, 'rotation', m.smooth, T)})`;
  const o = m.osc;
  if (o && o.amp > 0) {
    const a = o.amp;
    if (o.kind === 'shake') {
      X = `(${X}+${f(a * 1.25)}*(sin(${T}*29)+sin(${T}*13.7)))`;
      Y = `(${Y}+${f(a * 1.25)}*(sin(${T}*23.3+1)+sin(${T}*11.1+2)))`;
      R = `(${R}+${f(a * 1.5)}*sin(${T}*19.1))`;
    } else if (o.kind === 'pulse') {
      S = `(${S}*(1+${f(0.035 * a)}*(1-cos(2*PI*${T}))))`;
    } else if (o.kind === 'float') {
      Y = `(${Y}+${f(2 * a)}*sin(2*PI*${T}/1.5))`;
    }
  }
  const rad = `(${R}*PI/180)`;
  // Die Fläche hat einen transparenten Rand (`border`), damit außerhalb nichts verschmiert wird
  const cx = `(${f(W / 2 + border)}+${X}/100*${f(W)})`;
  const cy = `(${f(H / 2 + border)}+${Y}/100*${f(H)})`;
  const corner = (px: number, py: number): [string, string] => [
    `${cx}+${S}*(${f(px)}*cos(${rad})-(${f(py)})*sin(${rad}))`,
    `${cy}+${S}*(${f(px)}*sin(${rad})+(${f(py)})*cos(${rad}))`,
  ];
  const hw = W / 2 + border, hh = H / 2 + border;
  return [...corner(-hw, -hh), ...corner(hw, -hh), ...corner(-hw, hh), ...corner(hw, hh)];
}

/** sendcmd-Zeilen für eine Deckkraft-Animation (colorchannelmixer aa). Zeiten relativ zum Kettenanfang. */
export function opacityCommands(m: Motion, baseOpacity: number, id: string, offset: number): string {
  const k = m.keyframes;
  const lines: string[] = [];
  const ease = m.smooth ? 'TI*TI*(3-2*TI)' : 'TI';
  const val = (v: number) => f(Math.max(0, Math.min(1, v * baseOpacity)));
  if (k.length === 0) return '';
  // vor dem ersten Keyframe
  if (k[0].t - offset > 0) lines.push(`0-${f(k[0].t - offset)} [expr] colorchannelmixer@${id} aa '${val(k[0].opacity)}';`);
  for (let i = 0; i < k.length - 1; i++) {
    const t0 = k[i].t - offset, t1 = k[i + 1].t - offset;
    if (t1 <= 0) continue;
    lines.push(`${f(Math.max(0, t0))}-${f(t1)} [expr] colorchannelmixer@${id} aa 'lerp(${val(k[i].opacity)},${val(k[i + 1].opacity)},${ease})';`);
  }
  const last = k[k.length - 1];
  lines.push(`${f(Math.max(0, last.t - offset))}-${f(Math.max(0, last.t - offset) + 100000)} [expr] colorchannelmixer@${id} aa '${val(last.opacity)}';`);
  return lines.join('\n') + '\n';
}

/**
 * sendcmd-Zeilen für die Belichtung über die Zeit (colorchannelmixer rr/gg/bb = Faktor).
 * Zwischen den Kurvenpunkten wird linear interpoliert – wie `exposureGainAt` in der Vorschau.
 */
export function exposureCommands(g: ColorGrade, id: string, offset: number, gainAt: (t: number) => number): string {
  const c = g.exposureCurve ?? [];
  const lines: string[] = [];
  const cmd = (a: number, b: number, v0: number, v1: number) => {
    const e = Math.abs(v1 - v0) < 1e-6 ? f(v0) : `lerp(${f(v0)},${f(v1)},TI)`;
    return `${f(a)}-${f(b)} [expr] colorchannelmixer@${id} rr '${e}', [expr] colorchannelmixer@${id} gg '${e}', [expr] colorchannelmixer@${id} bb '${e}';`;
  };
  if (c.length === 0) return '';
  if (c[0].t - offset > 0) lines.push(cmd(0, c[0].t - offset, gainAt(c[0].t), gainAt(c[0].t)));
  for (let i = 0; i < c.length - 1; i++) {
    const t0 = c[i].t - offset, t1 = c[i + 1].t - offset;
    if (t1 <= 0) continue;
    // Startwert am tatsächlichen Intervallbeginn (falls der Export mitten im Intervall beginnt)
    const a = Math.max(0, t0);
    lines.push(cmd(a, t1, gainAt(a + offset), gainAt(c[i + 1].t)));
  }
  const last = c[c.length - 1];
  const a = Math.max(0, last.t - offset);
  lines.push(cmd(a, a + 100000, gainAt(last.t), gainAt(last.t)));
  return lines.join('\n') + '\n';
}
