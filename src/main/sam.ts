// Genaue KI-Masken mit MobileSAM (Apache-2.0, „Segment Anything“ für Mobilgeräte): Objekt anklicken oder umrahmen
// → Maske mit genauer Kante. Läuft lokal mit ONNX Runtime. Für Genauigkeit wird immer ein Ausschnitt um das Objekt
// gerechnet (KI sieht 1024 Pixel), bei 360°-Bildern über die linke/rechte Kante hinweg.
import log from 'electron-log';
import type { AiProgress } from '@shared/types';
import { ensureModel, getSession, ort, resizeRGBA, type Frame, type ModelDef } from './ai';

const RELEASE = 'https://github.com/BlayZzo/pano-cut/releases/download/models-1/';
export const SAM_ENCODER: ModelDef = { file: 'mobile_sam.encoder.onnx', url: RELEASE + 'mobile_sam.encoder.onnx', sizeMB: 28, input: 1024 };
export const SAM_DECODER: ModelDef = { file: 'mobile_sam.decoder.onnx', url: RELEASE + 'mobile_sam.decoder.onnx', sizeMB: 16, input: 1024 };

/** Hinweise in Bildpixeln: Punkte (label 1 = gehört dazu, 0 = gehört nicht dazu) und/oder Rahmen. */
export interface SamPrompt { points: Array<{ x: number; y: number; label: 0 | 1 }>; box?: { x0: number; y0: number; x1: number; y1: number } }

export async function ensureSam(onProgress: (p: AiProgress) => void): Promise<void> {
  await ensureModel(SAM_ENCODER, onProgress);
  await ensureModel(SAM_DECODER, onProgress);
}

/** Ausschnitt (x0, y0, Breite, Höhe) aus einem RGBA-Bild; bei `wrap` wird links/rechts herum gelesen. */
function cropRGBA(f: Frame, x0: number, y0: number, w: number, h: number, wrap: boolean): Frame {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(f.height - 1, y0 + y));
    for (let x = 0; x < w; x++) {
      let sx = x0 + x;
      if (wrap) sx = ((sx % f.width) + f.width) % f.width; else sx = Math.max(0, Math.min(f.width - 1, sx));
      const si = (sy * f.width + sx) * 4, di = (y * w + x) * 4;
      out[di] = f.data[si]; out[di + 1] = f.data[si + 1]; out[di + 2] = f.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

interface Embedding { emb: Float32Array; scale: number; w: number; h: number }
const cache = new Map<string, Embedding>();

async function embed(img: Frame, key?: string): Promise<Embedding> {
  if (key && cache.has(key)) return cache.get(key)!;
  const o = ort();
  const enc = await getSession(await ensureModel(SAM_ENCODER, () => undefined));
  const scale = 1024 / Math.max(img.width, img.height);
  const rw = Math.max(1, Math.round(img.width * scale)), rh = Math.max(1, Math.round(img.height * scale));
  const rgba = resizeRGBA(img, rw, rh);
  const x = new Float32Array(rw * rh * 3);
  for (let i = 0, p = 0; p < rw * rh; i += 4, p++) { x[p * 3] = rgba[i]; x[p * 3 + 1] = rgba[i + 1]; x[p * 3 + 2] = rgba[i + 2]; }
  const out = await enc.run({ input_image: new o.Tensor('float32', x, [rh, rw, 3]) });
  const e: Embedding = { emb: out.image_embeddings.data as Float32Array, scale, w: img.width, h: img.height };
  if (key) { cache.set(key, e); if (cache.size > 6) cache.delete(cache.keys().next().value as string); }
  return e;
}

async function decode(e: Embedding, prompt: SamPrompt): Promise<{ mask: Uint8Array; iou: number }> {
  const o = ort();
  const dec = await getSession(await ensureModel(SAM_DECODER, () => undefined));
  const pts: number[] = [], labels: number[] = [];
  for (const p of prompt.points) { pts.push(p.x * e.scale, p.y * e.scale); labels.push(p.label); }
  if (prompt.box) {
    pts.push(prompt.box.x0 * e.scale, prompt.box.y0 * e.scale, prompt.box.x1 * e.scale, prompt.box.y1 * e.scale);
    labels.push(2, 3);
  } else { pts.push(0, 0); labels.push(-1); }
  const n = labels.length;
  const out = await dec.run({
    image_embeddings: new o.Tensor('float32', e.emb, [1, 256, 64, 64]),
    point_coords: new o.Tensor('float32', Float32Array.from(pts), [1, n, 2]),
    point_labels: new o.Tensor('float32', Float32Array.from(labels), [1, n]),
    mask_input: new o.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new o.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new o.Tensor('float32', new Float32Array([e.h, e.w]), [2]),
  });
  const logits = out.masks.data as Float32Array;
  const mask = new Uint8Array(e.w * e.h);
  // weiche Kante aus den Logits (Übergang über ~2 Einheiten)
  for (let i = 0; i < mask.length; i++) mask[i] = Math.max(0, Math.min(255, Math.round(127.5 + logits[i] * 64)));
  const iou = (out.iou_predictions.data as Float32Array)[0] ?? 0;
  return { mask, iou };
}

/**
 * Maske für ein ganzes Bild (W×H) aus Hinweisen. Rechnet in einem Ausschnitt um die Hinweise (bzw. `region`),
 * damit kleine Objekte genau werden. Ergebnis: Maske in Bildgröße (0..255).
 */
export async function samSegment(img: Frame, prompt: SamPrompt, opts: { wrap?: boolean; region?: { x0: number; y0: number; x1: number; y1: number }; key?: string } = {}): Promise<{ mask: Uint8Array; iou: number }> {
  const W = img.width, H = img.height;
  // Bereich: Rahmen/Region mit 30 % Rand, sonst um die Punkte (mind. 40 % der Bildhöhe)
  let r = opts.region ?? prompt.box ?? null;
  if (!r) {
    const xs = prompt.points.map((p) => p.x), ys = prompt.points.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const half = Math.max(H * 0.2, (Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2);
    r = { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
  }
  const bw = r.x1 - r.x0, bh = r.y1 - r.y0;
  const side = Math.min(opts.wrap ? W : Math.max(W, H), Math.max(256, Math.max(bw, bh) * 1.3));
  let cx0 = Math.round((r.x0 + r.x1) / 2 - side / 2), cy0 = Math.round((r.y0 + r.y1) / 2 - side / 2);
  const cw = Math.round(Math.min(opts.wrap ? side : W, side)), ch = Math.round(Math.min(H, side));
  if (!opts.wrap) cx0 = Math.max(0, Math.min(W - cw, cx0));
  cy0 = Math.max(0, Math.min(H - ch, cy0));
  const whole = !opts.wrap && cw >= W && ch >= H;
  const crop = whole ? img : cropRGBA(img, cx0, cy0, cw, ch, !!opts.wrap);
  const ox = whole ? 0 : cx0, oy = whole ? 0 : cy0;
  const local: SamPrompt = {
    points: prompt.points.map((p) => ({ x: localX(p.x - ox, W, !!opts.wrap), y: p.y - oy, label: p.label })),
    box: prompt.box ? { x0: localX(prompt.box.x0 - ox, W, !!opts.wrap), y0: prompt.box.y0 - oy, x1: localX(prompt.box.x0 - ox, W, !!opts.wrap) + (prompt.box.x1 - prompt.box.x0), y1: prompt.box.y1 - oy } : undefined,
  };
  const e = await embed(crop, opts.key ? `${opts.key}|${ox}|${oy}|${crop.width}x${crop.height}` : undefined);
  const res = await decode(e, local);
  if (whole) return res;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < crop.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < crop.width; x++) {
      let tx = ox + x;
      if (opts.wrap) tx = ((tx % W) + W) % W; else if (tx < 0 || tx >= W) continue;
      const v = res.mask[y * crop.width + x];
      if (v > mask[ty * W + tx]) mask[ty * W + tx] = v;
    }
  }
  return { mask, iou: res.iou };
}

/** x relativ zum Ausschnitt (bei 360° über die Kante hinweg). */
function localX(dx: number, W: number, wrap: boolean): number {
  if (!wrap) return dx;
  return ((dx % W) + W) % W;
}

export function forgetSamCache(): void { cache.clear(); log.debug('SAM-Cache geleert'); }
