// Animationen als FFmpeg-Ausdrücke (perspective-Filter, Auswertung pro Bild).
// Dieselben Formeln stehen in src/shared/effects.ts (motionAt/oscAt) für die Vorschau.
import type { ColorGrade, Motion, MotionKeyframe, Transform } from '@shared/types';

function f(n: number): string {
  return (Math.round(n * 1e5) / 1e5).toString();
}

/** Stückweise (linear oder weich) interpolierte Funktion als verschachtelter if()-Ausdruck. */
function piecewise(kfs: MotionKeyframe[], key: keyof Omit<MotionKeyframe, 't'>, smooth: boolean, T: string, curve = false): string {
  if (kfs.length === 0) return '0';
  const vals = kfs.map((k) => k[key]);
  if (vals.every((v) => Math.abs(v - vals[0]) < 1e-6)) return f(vals[0]);
  let expr = f(vals[vals.length - 1]);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i], b = kfs[i + 1];
    const span = Math.max(1e-4, b.t - a.t);
    const u = `clip((${T}-${f(a.t)})/${f(span)},0,1)`;
    const e = smooth ? `(${u}*${u}*(3-2*${u}))` : u;
    if (curve && kfs.length > 2) {
      // Catmull-Rom wie effects.catmull: 0.5*(2p1 + (−p0+p2)e + (2p0−5p1+4p2−p3)e² + (−p0+3p1−3p2+p3)e³)
      const p0 = kfs[Math.max(0, i - 1)][key], p1 = a[key], p2 = b[key], p3 = kfs[Math.min(kfs.length - 1, i + 2)][key];
      const c1 = -p0 + p2, c2 = 2 * p0 - 5 * p1 + 4 * p2 - p3, c3 = -p0 + 3 * p1 - 3 * p2 + p3;
      expr = `if(lt(${T},${f(b.t)}),${f(p1)}+0.5*${e}*(${f(c1)}+${e}*(${f(c2)}+${e}*${f(c3)})),${expr})`;
      continue;
    }
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
  // `in` zählt im perspective-Filter ab 1 (erstes Bild = 1) → Bild k liegt bei (in−1)/fps
  const T = `((in-1)/${f(fps)}+${f(offset)})`;
  const kfs = m.keyframes.length ? m.keyframes : [{ t: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }];
  let X = `(${f(base.x)}+${piecewise(kfs, 'x', m.smooth, T, m.curve)})`;
  let Y = `(${f(base.y)}+${piecewise(kfs, 'y', m.smooth, T, m.curve)})`;
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

/** Ecken (x0,y0 … x3,y3) einer Übergangs-Ebene für `perspective=sense=destination` – wie composeLayer in der Vorschau. */
export function dynCorners(l: { x: number; y: number; scale: number; rotation: number }, W: number, H: number, border: number): number[] {
  const cx = W / 2 + border + (l.x / 100) * W;
  const cy = H / 2 + border + (l.y / 100) * H;
  const r = (l.rotation * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const hw = W / 2 + border, hh = H / 2 + border;
  const out: number[] = [];
  for (const [px, py] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
    out.push(cx + l.scale * (px * c - py * s), cy + l.scale * (px * s + py * c));
  }
  return out;
}

/**
 * Werte pro Bild (Index = Bildnummer `in`) als stückweise lineare Funktion. Stützstellen, die sich linear
 * vorhersagen lassen (Abweichung < tol), werden weggelassen, damit der Ausdruck kurz bleibt.
 */
export function framePiecewise(vals: number[], tol: number): string {
  if (vals.length === 0) return '0';
  if (vals.every((v) => Math.abs(v - vals[0]) < tol)) return f(vals[0]);
  const keep = [0];
  let a = 0;
  while (a < vals.length - 1) {
    let b = a + 1;
    // so weit wie möglich gehen, solange alle Zwischenwerte auf der Geraden liegen
    while (b + 1 < vals.length) {
      const nb = b + 1;
      let ok = true;
      for (let k = a + 1; k < nb; k++) {
        const lin = vals[a] + ((vals[nb] - vals[a]) * (k - a)) / (nb - a);
        if (Math.abs(lin - vals[k]) > tol) { ok = false; break; }
      }
      if (!ok) break;
      b = nb;
    }
    keep.push(b);
    a = b;
  }
  let expr = f(vals[keep[keep.length - 1]]);
  for (let i = keep.length - 2; i >= 0; i--) {
    const ka = keep[i], kb = keep[i + 1];
    // `in` beginnt bei 1 → Bildindex = in−1
    expr = `if(lt(in,${kb + 1}),${f(vals[ka])}+(${f(vals[kb] - vals[ka])})*(in-${ka + 1})/${kb - ka},${expr})`;
  }
  return expr;
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
