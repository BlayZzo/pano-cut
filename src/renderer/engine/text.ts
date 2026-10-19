// Text-Rendering auf dem Canvas – spiegelt die drawtext/ASS-Darstellung des Exports.
import type { TitleStyle } from '@shared/types';
import { fontDef, titleAnimationAt } from '@shared/pano';

export interface TextDrawOptions {
  localT: number;      // Zeit seit Clip-Anfang
  duration: number;    // Clip-Länge
  animate: boolean;
}

export function drawStyledText(ctx: CanvasRenderingContext2D, style: Omit<TitleStyle, 'text'>, text: string, W: number, H: number, opts: TextDrawOptions, second?: { text: string; color: string }): void {
  if (!text) return;
  const anim = opts.animate ? titleAnimationAt(style, opts.localT, opts.duration) : { alpha: 1, dy: 0, chars: null };
  if (anim.alpha <= 0) return;
  let shown = text;
  if (anim.chars !== null) shown = Array.from(text).slice(0, anim.chars).join('');
  if (!shown) return;
  const px = Math.max(4, (style.size / 100) * H);
  const def = fontDef(style.font);
  const weight = style.bold || def.key === 'sans-bold' ? 'bold ' : '';
  ctx.save();
  ctx.globalAlpha *= anim.alpha;
  ctx.filter = 'none';
  ctx.textBaseline = 'middle';
  // Zeilen: Haupttext, optional die Übersetzung darunter (kleiner, eigene Farbe – wie \N{\c…\fs…} im Export)
  const lines: Array<{ text: string; px: number; color: string }> = shown.split('\n').map((l) => ({ text: l, px, color: style.color }));
  if (second && second.text.trim()) for (const l of second.text.split('\n')) lines.push({ text: l, px: Math.round(px * 0.8), color: second.color });
  const widths = lines.map((l) => { ctx.font = `${weight}${l.px}px ${def.css}`; return ctx.measureText(l.text).width; });
  const heights = lines.map((l) => l.px * 1.2);
  const blockH = heights.reduce((a, b) => a + b, 0);
  const blockW = Math.max(...widths, 1);
  const cx = (style.x / 100) * W;
  const cy = (style.y / 100) * H + (anim.dy / 100) * H;
  let left: number;
  if (style.align === 'left') left = cx;
  else if (style.align === 'right') left = cx - blockW;
  else left = cx - blockW / 2;
  const top = cy - blockH / 2;
  const pad = px * 0.35;
  if (style.background) {
    ctx.fillStyle = hexWithAlpha(style.background, style.backgroundOpacity);
    ctx.fillRect(left - pad, top - pad, blockW + pad * 2, blockH + pad * 2);
  }
  let y0 = top;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    ctx.font = `${weight}${line.px}px ${def.css}`;
    let x = left;
    if (style.align === 'center') x = left + (blockW - widths[i]) / 2;
    else if (style.align === 'right') x = left + (blockW - widths[i]);
    const y = y0 + heights[i] / 2;
    y0 += heights[i];
    ctx.textAlign = 'left';
    if (style.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = line.px * 0.08;
      ctx.shadowOffsetX = line.px * 0.04;
      ctx.shadowOffsetY = line.px * 0.04;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    if (style.outline) {
      ctx.lineWidth = Math.max(1, line.px * 0.08) * 2;
      ctx.strokeStyle = '#000';
      ctx.lineJoin = 'round';
      ctx.strokeText(line.text, x, y);
    }
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, x, y);
  }
  ctx.restore();
}

function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

/** Untertitel mit hervorgehobenem Wort zeichnen (Spiegel der ASS-Ausgabe im Export: \c-Farbwechsel je Wort). */
export function drawSubtitleView(ctx: CanvasRenderingContext2D, style: Omit<TitleStyle, 'text'>, view: { lines: Array<Array<{ text: string; active: boolean }>>; second?: string }, W: number, H: number, highlight: string | undefined, secondColor: string): void {
  const px = Math.max(4, (style.size / 100) * H);
  const def = fontDef(style.font);
  const weight = style.bold || def.key === 'sans-bold' ? 'bold ' : '';
  ctx.save();
  ctx.filter = 'none';
  ctx.textBaseline = 'middle';
  const rows: Array<{ runs: Array<{ text: string; color: string }>; px: number }> = view.lines.map((ln) => ({
    px,
    runs: ln.map((r, i) => ({ text: (i ? ' ' : '') + r.text, color: r.active && highlight ? highlight : style.color })),
  }));
  if (view.second) rows.push({ px: Math.round(px * 0.8), runs: [{ text: view.second, color: secondColor }] });
  const widths = rows.map((r) => { ctx.font = `${weight}${r.px}px ${def.css}`; return r.runs.reduce((s, x) => s + ctx.measureText(x.text).width, 0); });
  const heights = rows.map((r) => r.px * 1.2);
  const blockH = heights.reduce((a, b) => a + b, 0);
  const blockW = Math.max(...widths, 1);
  const cx = (style.x / 100) * W, cy = (style.y / 100) * H;
  const left = style.align === 'left' ? cx : style.align === 'right' ? cx - blockW : cx - blockW / 2;
  const top = cy - blockH / 2;
  const pad = px * 0.35;
  if (style.background) {
    ctx.fillStyle = hexWithAlpha(style.background, style.backgroundOpacity);
    ctx.fillRect(left - pad, top - pad, blockW + pad * 2, blockH + pad * 2);
  }
  let y0 = top;
  rows.forEach((row, i) => {
    ctx.font = `${weight}${row.px}px ${def.css}`;
    let x = style.align === 'center' ? left + (blockW - widths[i]) / 2 : style.align === 'right' ? left + blockW - widths[i] : left;
    const y = y0 + heights[i] / 2;
    y0 += heights[i];
    ctx.textAlign = 'left';
    for (const run of row.runs) {
      if (style.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = row.px * 0.08; ctx.shadowOffsetX = row.px * 0.04; ctx.shadowOffsetY = row.px * 0.04; }
      else { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
      if (style.outline) { ctx.lineWidth = Math.max(1, row.px * 0.08) * 2; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round'; ctx.strokeText(run.text, x, y); }
      ctx.fillStyle = run.color;
      ctx.fillText(run.text, x, y);
      x += ctx.measureText(run.text).width;
    }
  });
  ctx.restore();
}
