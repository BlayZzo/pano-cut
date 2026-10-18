// KI-Funktionen (laufen komplett lokal mit ONNX Runtime, kein Abo):
//  - Objekte erkennen (YOLOX, Apache-2.0)
//  - Objekte freistellen / Masken (U²-Net bzw. ISNet, Apache-2.0 / MIT – Modelle aus dem rembg-Projekt)
// Die Modelle werden beim ersten Gebrauch heruntergeladen (kleiner Installer).
import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import type { AiDetectModel, AiProgress, AiSegmentModel, Detection } from '@shared/types';
import { COCO_LABELS_DE } from '@shared/ai';

interface ModelDef { file: string; url: string; sizeMB: number; input: number }

export const DETECT_MODELS: Record<AiDetectModel, ModelDef> = {
  'yolox-nano': { file: 'yolox_nano.onnx', url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx', sizeMB: 4, input: 416 },
  'yolox-tiny': { file: 'yolox_tiny.onnx', url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx', sizeMB: 20, input: 416 },
  'yolox-s': { file: 'yolox_s.onnx', url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx', sizeMB: 36, input: 640 },
};

export const SEGMENT_MODELS: Record<AiSegmentModel, ModelDef & { mean: number[]; std: number[] }> = {
  u2netp: { file: 'u2netp.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx', sizeMB: 5, input: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  'u2net-human': { file: 'u2net_human_seg.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx', sizeMB: 176, input: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  isnet: { file: 'isnet-general-use.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx', sizeMB: 176, input: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1] },
};

type OrtModule = typeof import('onnxruntime-node');
let ortModule: OrtModule | null | undefined;

function ort(): OrtModule {
  if (ortModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ortModule = require('onnxruntime-node') as OrtModule;
    } catch (err) {
      log.warn('onnxruntime-node nicht verfügbar', err);
      ortModule = null;
    }
  }
  if (!ortModule) throw new Error('Das KI-Modul (ONNX Runtime) ist in dieser Installation nicht verfügbar.');
  return ortModule;
}

export function aiAvailable(): boolean {
  try { ort(); return true; } catch { return false; }
}

function modelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function aiModelStatus(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, m] of Object.entries(DETECT_MODELS)) out[k] = fs.existsSync(path.join(modelsDir(), m.file));
  for (const [k, m] of Object.entries(SEGMENT_MODELS)) out[k] = fs.existsSync(path.join(modelsDir(), m.file));
  return out;
}

async function ensureModel(def: ModelDef, onProgress: (p: AiProgress) => void, signal?: AbortSignal): Promise<string> {
  const dest = path.join(modelsDir(), def.file);
  if (fs.existsSync(dest)) return dest;
  onProgress({ phase: 'download', percent: 0, message: `KI-Modell wird geladen (${def.sizeMB} MB) …` });
  const res = await net.fetch(def.url, { signal });
  if (!res.ok || !res.body) throw new Error(`Modell-Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? def.sizeMB * 1048576);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress({ phase: 'download', percent: Math.round((received / total) * 100), message: `KI-Modell wird geladen … ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB` });
    }
    await new Promise<void>((res2, rej) => out.end((e?: Error | null) => (e ? rej(e) : res2())));
    fs.renameSync(tmp, dest);
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return dest;
}

// ---------- Sessions ----------

type Session = import('onnxruntime-node').InferenceSession;
const sessions = new Map<string, Promise<Session>>();

async function getSession(modelPath: string): Promise<Session> {
  let p = sessions.get(modelPath);
  if (!p) {
    p = (async () => {
      const o = ort();
      const providers: string[][] = process.platform === 'darwin' ? [['coreml', 'cpu'], ['cpu']] : [['cpu']];
      let lastErr: unknown;
      for (const ep of providers) {
        try {
          return await o.InferenceSession.create(modelPath, { executionProviders: ep as never, graphOptimizationLevel: 'all' });
        } catch (err) {
          lastErr = err;
          log.warn(`ONNX-Session mit ${ep.join('/')} fehlgeschlagen`, (err as Error).message);
        }
      }
      throw lastErr;
    })();
    sessions.set(modelPath, p);
    p.catch(() => sessions.delete(modelPath));
  }
  return p;
}

export interface Frame {
  data: Uint8Array;  // RGBA
  width: number;
  height: number;
}

/** Bilineare Skalierung eines RGBA-Bildes (einfach, ohne Abhängigkeiten). */
function resizeRGBA(src: Frame, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const sx = src.width / dw, sy = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(src.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(src.height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(src.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(src.width - 1, x0 + 1), wx = fx - x0;
      const i00 = (y0 * src.width + x0) * 4, i01 = (y0 * src.width + x1) * 4, i10 = (y1 * src.width + x0) * 4, i11 = (y1 * src.width + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src.data[i00 + c] * (1 - wx) + src.data[i01 + c] * wx;
        const bot = src.data[i10 + c] * (1 - wx) + src.data[i11 + c] * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return out;
}

// ---------- Erkennung (YOLOX) ----------

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export async function detectObjects(frame: Frame, model: AiDetectModel, onProgress: (p: AiProgress) => void, minScore = 0.3, signal?: AbortSignal): Promise<Detection[]> {
  const def = DETECT_MODELS[model];
  const modelPath = await ensureModel(def, onProgress, signal);
  onProgress({ phase: 'load', percent: 0, message: 'KI-Modell wird gestartet …' });
  const session = await getSession(modelPath);
  const S = def.input;
  // Letterbox: Bild proportional einpassen, Rest mit 114 füllen (wie im YOLOX-Demo)
  const ratio = Math.min(S / frame.width, S / frame.height);
  const rw = Math.max(1, Math.round(frame.width * ratio)), rh = Math.max(1, Math.round(frame.height * ratio));
  const resized = resizeRGBA(frame, rw, rh);
  const input = new Float32Array(3 * S * S).fill(114);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4;
      const o = y * S + x;
      // BGR-Reihenfolge (OpenCV-Konvention des YOLOX-Exports)
      input[o] = resized[i + 2];
      input[S * S + o] = resized[i + 1];
      input[2 * S * S + o] = resized[i];
    }
  }
  const o = ort();
  const tensor = new o.Tensor('float32', input, [1, 3, S, S]);
  const feeds: Record<string, typeof tensor> = { [session.inputNames[0]]: tensor };
  onProgress({ phase: 'run', percent: 0, message: 'Objekte werden erkannt …' });
  const results = await session.run(feeds);
  const out = results[session.outputNames[0]];
  const data = out.data as Float32Array;
  const dims = out.dims as number[];
  const n = dims[1], stride = dims[2];
  // Gitter für die Strides 8/16/32
  const grids: Array<{ gx: number; gy: number; s: number }> = [];
  for (const st of [8, 16, 32]) {
    const g = S / st;
    for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++) grids.push({ gx, gy, s: st });
  }
  const dets: Detection[] = [];
  for (let i = 0; i < n && i < grids.length; i++) {
    const base = i * stride;
    const obj = data[base + 4];
    if (obj < 0.1) continue;
    let best = 0, bestIdx = 0;
    for (let c = 5; c < stride; c++) { if (data[base + c] > best) { best = data[base + c]; bestIdx = c - 5; } }
    const score = obj * best;
    if (score < minScore) continue;
    const g = grids[i];
    const cx = (data[base] + g.gx) * g.s, cy = (data[base + 1] + g.gy) * g.s;
    const w = Math.exp(data[base + 2]) * g.s, h = Math.exp(data[base + 3]) * g.s;
    const x0 = Math.max(0, (cx - w / 2) / ratio), y0 = Math.max(0, (cy - h / 2) / ratio);
    const x1 = Math.min(frame.width, (cx + w / 2) / ratio), y1 = Math.min(frame.height, (cy + h / 2) / ratio);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const label = COCO_LABELS_DE[bestIdx]?.en ?? `class${bestIdx}`;
    dets.push({ label, labelDe: COCO_LABELS_DE[bestIdx]?.de ?? label, score, x: x0 / frame.width, y: y0 / frame.height, w: (x1 - x0) / frame.width, h: (y1 - y0) / frame.height });
  }
  // NMS pro Klasse
  dets.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const d of dets) {
    // gleiche Klasse: normale NMS; verschiedene Klassen nur bei fast identischer Box (z. B. Auto/Lkw)
    if (kept.some((k) => (k.label === d.label && iou(k, d) > 0.45) || iou(k, d) > 0.85)) continue;
    kept.push(d);
    if (kept.length >= 50) break;
  }
  onProgress({ phase: 'done', percent: 100 });
  return kept;
}

// ---------- Freistellen (U²-Net / ISNet) ----------

export interface MaskResult {
  width: number;    // Maskengröße = Bildgröße des Eingangsbildes
  height: number;
  alpha: Uint8Array; // 0..255
}

/**
 * Berechnet eine Alphamaske für das Objekt in `box` (normiert; optional). Das Modell läuft auf einem
 * vergrößerten Ausschnitt um die Box; außerhalb bleibt die Maske 0.
 */
export async function segmentObject(frame: Frame, model: AiSegmentModel, box: { x: number; y: number; w: number; h: number } | null, onProgress: (p: AiProgress) => void, signal?: AbortSignal): Promise<MaskResult> {
  const def = SEGMENT_MODELS[model];
  const modelPath = await ensureModel(def, onProgress, signal);
  onProgress({ phase: 'load', percent: 0, message: 'KI-Modell wird gestartet …' });
  const session = await getSession(modelPath);
  const S = def.input;
  // Ausschnitt (mit Rand) bestimmen
  let cx0 = 0, cy0 = 0, cw = frame.width, ch = frame.height;
  if (box) {
    const mx = box.w * 0.2 * frame.width, my = box.h * 0.2 * frame.height;
    cx0 = Math.max(0, Math.floor(box.x * frame.width - mx));
    cy0 = Math.max(0, Math.floor(box.y * frame.height - my));
    const cx1 = Math.min(frame.width, Math.ceil((box.x + box.w) * frame.width + mx));
    const cy1 = Math.min(frame.height, Math.ceil((box.y + box.h) * frame.height + my));
    cw = Math.max(8, cx1 - cx0);
    ch = Math.max(8, cy1 - cy0);
  }
  // Ausschnitt kopieren
  const crop: Frame = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
  for (let y = 0; y < ch; y++) {
    const srcOff = ((cy0 + y) * frame.width + cx0) * 4;
    crop.data.set(frame.data.subarray(srcOff, srcOff + cw * 4), y * cw * 4);
  }
  const resized = resizeRGBA(crop, S, S);
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    input[i] = (resized[i * 4] / 255 - def.mean[0]) / def.std[0];
    input[S * S + i] = (resized[i * 4 + 1] / 255 - def.mean[1]) / def.std[1];
    input[2 * S * S + i] = (resized[i * 4 + 2] / 255 - def.mean[2]) / def.std[2];
  }
  const o = ort();
  const tensor = new o.Tensor('float32', input, [1, 3, S, S]);
  onProgress({ phase: 'run', percent: 0, message: 'Maske wird berechnet …' });
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const out = results[session.outputNames[0]];
  const pred = out.data as Float32Array;
  const dims = out.dims as number[];
  const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
  // Normalisieren wie rembg: (pred - min) / (max - min)
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < ow * oh; i++) { const v = pred[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = Math.max(1e-6, mx - mn);
  const small: Frame = { width: ow, height: oh, data: new Uint8Array(ow * oh * 4) };
  for (let i = 0; i < ow * oh; i++) {
    const v = Math.round(((pred[i] - mn) / range) * 255);
    small.data[i * 4] = v; small.data[i * 4 + 1] = v; small.data[i * 4 + 2] = v; small.data[i * 4 + 3] = 255;
  }
  const scaled = resizeRGBA(small, cw, ch);
  const alpha = new Uint8Array(frame.width * frame.height);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) alpha[(cy0 + y) * frame.width + cx0 + x] = scaled[(y * cw + x) * 4];
  }
  onProgress({ phase: 'done', percent: 100 });
  return { width: frame.width, height: frame.height, alpha };
}

export function deleteAiModel(file: string): void {
  try { fs.rmSync(path.join(modelsDir(), file), { force: true }); } catch (e) { log.warn(e); }
}
