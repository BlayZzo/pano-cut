// Text-Rendering auf dem Canvas – spiegelt die drawtext/ASS-Darstellung des Exports.
import type { TitleStyle } from '@shared/types';
import { fontDef, titleAnimationAt } from '@shared/pano';

export interface TextDrawOptions {
  localT: number;      // Zeit seit Clip-Anfang
  duration: number;    // Clip-Länge
  animate: boolean;
}

export function drawStyledText(ctx: CanvasRenderingContext2D, style: Omit<TitleStyle, 'text'>, text: string, W: number, H: number, opts: TextDrawOptions): void {
  if (!text) return;
  const anim = opts.animate ? titleAnimationAt(style, opts.localT, opts.duration) : { alpha: 1, dy: 0, chars: null };
  if (anim.alpha <= 0) return;
  let shown = text;
  if (anim.chars !== null) shown = Array.from(text).slice(0, anim.chars).join('');
  if (!shown) return;
  const px = Math.max(4, (style.size / 100) * H);
  const def = fontDef(style.font);
  ctx.save();
  ctx.globalAlpha *= anim.alpha;
  ctx.filter = 'none';
  ctx.font = `${style.bold || def.key === 'sans-bold' ? 'bold ' : ''}${px}px ${def.css}`;
  ctx.textBaseline = 'middle';
  const lines = shown.split('\n');
  const lineH = px * 1.2;
  const blockH = lineH * lines.length;
  const widths = lines.map((l) => ctx.measureText(l).width);
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let x = left;
    if (style.align === 'center') x = left + (blockW - widths[i]) / 2;
    else if (style.align === 'right') x = left + (blockW - widths[i]);
    const y = top + lineH * i + lineH / 2;
    ctx.textAlign = 'left';
    if (style.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = px * 0.08;
      ctx.shadowOffsetX = px * 0.04;
      ctx.shadowOffsetY = px * 0.04;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    if (style.outline) {
      ctx.lineWidth = Math.max(1, px * 0.08) * 2;
      ctx.strokeStyle = '#000';
      ctx.lineJoin = 'round';
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
  }
  ctx.restore();
}

function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}
