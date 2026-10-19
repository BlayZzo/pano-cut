// Hilfen für die Vorschau: Lage eines Clips im Bild (zum Verschieben/Skalieren) und der Masken-Pinsel.
import type { Clip, MediaItem, ObjectTrack } from '@shared/types';
import { trackBoxAt } from '@shared/ai';

export interface ClipBox {
  cx: number; cy: number;     // Mitte (Canvas-Pixel)
  w: number; h: number;       // sichtbare Bildgröße
  rot: number;                // Grad
  sx: number; sy: number;     // Pixel pro Quellbild-Pixel
  vw: number; vh: number;     // Quellgröße nach Zuschnitt
}

/** Wo liegt ein Clip im Vorschaubild (ohne Animation)? Gleiche Rechnung wie engine.drawClip. */
export function clipBox(clip: Clip, media: MediaItem, W: number, H: number): ClipBox | null {
  let vw = media.info.width, vh = media.info.height;
  if (!vw || !vh) return null;
  if (Math.abs(media.info.rotation % 180) === 90) [vw, vh] = [vh, vw];
  if (media.info.is360 && clip.pano) {
    if (clip.pano.mode === 'equirect') { vw = 2048; vh = 1024; } else { vw = W; vh = H; }
  }
  const cr = clip.crop;
  if (cr && cr.left + cr.right + cr.top + cr.bottom > 0.01) {
    vw *= Math.max(0.05, 1 - (cr.left + cr.right) / 100);
    vh *= Math.max(0.05, 1 - (cr.top + cr.bottom) / 100);
  }
  const t = clip.transform;
  const sc = Math.max(0.01, t.scale);
  let sx: number, sy: number;
  if (clip.fit === 'stretch') { sx = (W * sc) / vw; sy = (H * sc) / vh; }
  else if (clip.fit === 'cover') { const s = Math.max(W / vw, H / vh) * sc; sx = s; sy = s; }
  else { const s = Math.min(W / vw, H / vh) * sc; sx = s; sy = s; }
  const w = clip.fit === 'cover' ? W * sc : vw * sx;
  const h = clip.fit === 'cover' ? H * sc : vh * sy;
  return { cx: W / 2 + (t.x / 100) * W, cy: H / 2 + (t.y / 100) * H, w, h, rot: t.rotation, sx, sy, vw, vh };
}

/** Canvas-Punkt → normierte Position im (ungeschnittenen) Quellbild, unter Berücksichtigung von Drehung/Zuschnitt/Spiegeln. */
export function canvasToSource(box: ClipBox, clip: Clip, px: number, py: number): { u: number; v: number } {
  const a = (-box.rot * Math.PI) / 180;
  const dx = px - box.cx, dy = py - box.cy;
  const x = dx * Math.cos(a) - dy * Math.sin(a);
  const y = dx * Math.sin(a) + dy * Math.cos(a);
  let u = 0.5 + x / (box.vw * box.sx);
  let v = 0.5 + y / (box.vh * box.sy);
  const cr = clip.crop;
  if (cr && cr.left + cr.right + cr.top + cr.bottom > 0.01) {
    u = cr.left / 100 + u * Math.max(0.05, 1 - (cr.left + cr.right) / 100);
    v = cr.top / 100 + v * Math.max(0.05, 1 - (cr.top + cr.bottom) / 100);
  }
  if (clip.fx?.mirror) u = 1 - u;
  if (clip.fx?.flip) v = 1 - v;
  return { u, v };
}

/** Rahmen des ausgewählten Clips zeichnen (k = Anzeige-Pixel pro Canvas-Pixel). */
export function drawSelection(ctx: CanvasRenderingContext2D, box: ClipBox, k: number): void {
  ctx.save();
  ctx.scale(k, k);
  ctx.translate(box.cx, box.cy);
  ctx.rotate((box.rot * Math.PI) / 180);
  ctx.strokeStyle = 'rgba(61,214,193,0.9)';
  ctx.lineWidth = 1.5 / k;
  ctx.setLineDash([6 / k, 4 / k]);
  ctx.strokeRect(-box.w / 2, -box.h / 2, box.w, box.h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(61,214,193,0.95)';
  const hs = 5 / k;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) ctx.fillRect((x * box.w) / 2 - hs, (y * box.h) / 2 - hs, hs * 2, hs * 2);
  ctx.restore();
}

// ---------- Masken-Pinsel ----------

export interface BrushDab { u: number; v: number; r: number }   // u/v relativ zur Objekt-Box, r relativ zur Box-Höhe

/** Graustufen-Maske in ein bearbeitbares Canvas laden. */
export async function loadMaskCanvas(path: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = window.panocut.toMediaUrl(path);
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Maske konnte nicht geladen werden')); });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}

/** Pinseltupfer in eine Maske malen (weiß = Objekt, schwarz = weg). u/v normiert auf das Quellbild. */
export function paintDab(mask: HTMLCanvasElement, u: number, v: number, radiusPx: number, add: boolean): void {
  const ctx = mask.getContext('2d')!;
  const x = u * mask.width, y = v * mask.height;
  const g = ctx.createRadialGradient(x, y, radiusPx * 0.55, x, y, radiusPx);
  const col = add ? '255,255,255' : '0,0,0';
  g.addColorStop(0, `rgba(${col},1)`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
  ctx.fill();
}

/** Strich auf andere Masken übertragen: Position relativ zur Objekt-Box, damit der Strich dem Objekt folgt. */
export function dabToBox(track: ObjectTrack, t: number, u: number, v: number): { bu: number; bv: number; bh: number } | null {
  const b = trackBoxAt(track, t);
  if (!b || b.w <= 0 || b.h <= 0) return null;
  return { bu: (u - b.x) / b.w, bv: (v - b.y) / b.h, bh: b.h };
}

export function boxToSource(track: ObjectTrack, t: number, bu: number, bv: number): { u: number; v: number; bh: number } | null {
  const b = trackBoxAt(track, t);
  if (!b) return null;
  return { u: b.x + bu * b.w, v: b.y + bv * b.h, bh: b.h };
}

export async function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('PNG konnte nicht erzeugt werden');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Rot eingefärbte Maske für die Anzeige beim Pinseln. */
export function tintMask(mask: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = mask.width; c.height = mask.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(mask, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) { const a = d.data[i]; d.data[i] = 255; d.data[i + 1] = 40; d.data[i + 2] = 80; d.data[i + 3] = Math.round(a * 0.45); }
  ctx.putImageData(d, 0, 0);
  return c;
}
