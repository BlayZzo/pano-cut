// 🎯 Objekt verfolgen (wie DJI ActiveTrack / Insta360 Deep Track): Rechteck um das Objekt ziehen, das Programm sucht es
// in jedem Bild wieder (Vorlagen-Vergleich mit normierter Korrelation, Vorlage wird langsam nachgeführt).
// 360°: gesucht wird in einer flachen Ansicht rund um das Objekt (WebGL wie die Vorschau) → Blickrichtung folgt.
// Normale Videos: gesucht wird im Quellbild → Objekt-Spur (zum Anheften) und auf Wunsch ein mitlaufender Ausschnitt.
import type { Clip, MediaItem, ObjectTrack, PanoKeyframe, ReframeKeyframe, TrackBox } from '@shared/types';
import { clipDuration, makeId } from '@shared/timeline';
import { panoMatrix } from '@shared/pano';
import { reframeRect } from '@shared/reframe';
import { PanoGL } from '../engine/panogl';
import { engine } from '../engine/instance';

const S = 160;   // Suchfenster (Pixel)

export interface FollowStart {
  /** 360°: Richtung und Winkelgröße des Objekts; normal: Box im Quellbild (0..1) */
  dir?: { yaw: number; pitch: number; size: number };
  box?: { x: number; y: number; w: number; h: number };
  local: number;   // Startzeit im Clip
}

export interface FollowSample { t: number; yaw?: number; pitch?: number; size?: number; box?: { x: number; y: number; w: number; h: number }; score: number }

export interface FollowProgress { percent: number; view: HTMLCanvasElement; box: { x: number; y: number; w: number; h: number }; score: number; lost: boolean }

function gray(data: Uint8ClampedArray, n: number): Float32Array {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  return g;
}

/** Vorlage (tw×th) aus dem Bild (W breit) ab (x0,y0) */
function cut(img: Float32Array, W: number, x0: number, y0: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) out[y * tw + x] = img[(y0 + y) * W + (x0 + x)] ?? 0;
  return out;
}

/** Beste Lage der Vorlage im Bild (normierte Kreuzkorrelation, jeder 2. Bildpunkt), nur im Bereich [x0,x1]×[y0,y1]. */
function match(img: Float32Array, W: number, H: number, tpl: Float32Array, tw: number, th: number, x0 = 0, y0 = 0, x1 = W - tw, y1 = H - th, step = 1): { x: number; y: number; score: number } {
  // Vorlage ausdünnen und mittelwertfrei machen
  const idx: number[] = [], tv: number[] = [];
  for (let j = 0; j < th; j += 2) for (let i = 0; i < tw; i += 2) { idx.push(j * W + i); tv.push(tpl[j * tw + i]); }
  const n = tv.length;
  const mean = tv.reduce((a, b) => a + b, 0) / n;
  let tn = 0;
  const tz = new Float32Array(n);
  for (let k = 0; k < n; k++) { tz[k] = tv[k] - mean; tn += tz[k] * tz[k]; }
  tn = Math.sqrt(tn) || 1;
  const offs = Int32Array.from(idx);
  let best = { x: 0, y: 0, score: -2 };
  for (let y = Math.max(0, y0); y <= Math.min(H - th, y1); y += step) {
    for (let x = Math.max(0, x0); x <= Math.min(W - tw, x1); x += step) {
      const base = y * W + x;
      let s = 0, q = 0, dot = 0;
      for (let k = 0; k < n; k++) { const v = img[base + offs[k]]; s += v; q += v * v; dot += v * tz[k]; }
      const varI = q - (s * s) / n;
      const score = dot / (Math.sqrt(Math.max(1e-6, varI)) * tn);
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

export async function followObject(clip: Clip, media: MediaItem, start: FollowStart, onProgress: (p: FollowProgress) => void, signal: { cancelled: boolean }): Promise<FollowSample[]> {
  const srcInfo = engine.analysisSource(media);
  if (!srcInfo) throw new Error('Für dieses 360°-Video wird zuerst die Vorschau erstellt – bitte kurz warten.');
  if (clip.reverse) throw new Error('Bei rückwärts laufenden Clips geht das Verfolgen nicht.');
  const is360 = !!media.info.is360;
  const v = document.createElement('video');
  v.muted = true; v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.src = srcInfo.src;
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('Video konnte nicht geladen werden')); });
  const dur = clipDuration(clip);
  const localAt = (fileT: number) => (fileT - clip.in) / clip.speed;
  const work = document.createElement('canvas'); work.width = S; work.height = S;
  const wctx = work.getContext('2d', { willReadFrequently: true })!;
  const pgl = is360 ? new PanoGL() : null;

  // Zustand
  let yaw = start.dir?.yaw ?? 0, pitch = start.dir?.pitch ?? 0, size = Math.max(3, start.dir?.size ?? 10);
  let box = start.box ?? { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
  const srcW = v.videoWidth, srcH = v.videoHeight;
  // Ausschnitt rund um das Objekt in ein S×S-Bild zeichnen; liefert, wie Pixel darin auf das Objekt abgebildet werden
  const grab = (): { img: Float32Array; region?: { x: number; y: number; w: number; h: number }; fov?: number } => {
    if (is360 && pgl) {
      const fov = Math.max(12, Math.min(140, size * 3));
      const out = pgl.render(v, S, S, 'flat', { yaw, pitch, roll: 0, fov }, v.currentTime, srcInfo.fisheye ?? undefined);
      if (out) wctx.drawImage(out, 0, 0);
      return { img: gray(wctx.getImageData(0, 0, S, S).data, S * S), fov };
    }
    // normal: quadratischer Bereich (3× Objektgröße) um die Objektmitte, in Quellpixeln
    const side = Math.max(box.w * srcW, box.h * srcH) * 3;
    const cx = (box.x + box.w / 2) * srcW, cy = (box.y + box.h / 2) * srcH;
    const region = { x: cx - side / 2, y: cy - side / 2, w: side, h: side };
    wctx.fillStyle = '#000'; wctx.fillRect(0, 0, S, S);
    wctx.drawImage(v, region.x, region.y, region.w, region.h, 0, 0, S, S);
    return { img: gray(wctx.getImageData(0, 0, S, S).data, S * S), region };
  };
  // Vorlage: mittleres Drittel (360°) bzw. Box-Seitenverhältnis (normal)
  const tplSize = (): { tw: number; th: number } => {
    if (is360) return { tw: Math.round(S / 3), th: Math.round(S / 3) };
    const side = Math.max(box.w * srcW, box.h * srcH);
    return { tw: Math.max(8, Math.round(((box.w * srcW) / side) * (S / 3))), th: Math.max(8, Math.round(((box.h * srcH) / side) * (S / 3))) };
  };

  const startLocal = Math.max(0, Math.min(dur, start.local));
  v.currentTime = clip.in + startLocal * clip.speed;
  await new Promise<void>((r) => { v.onseeked = () => r(); });
  const first = grab();
  const { tw, th } = tplSize();
  const tpl = cut(first.img, S, Math.round((S - tw) / 2), Math.round((S - th) / 2), tw, th);
  const samples: FollowSample[] = [{ t: startLocal, yaw, pitch, size, box: { ...box }, score: 1 }];
  let lostSince = -1;

  const step = (local: number) => {
    const g = grab();
    // grob (jeder 2. Pixel), dann fein um den Treffer
    const coarse = match(g.img, S, S, tpl, tw, th, 0, 0, S - tw, S - th, 2);
    const fine = match(g.img, S, S, tpl, tw, th, coarse.x - 2, coarse.y - 2, coarse.x + 2, coarse.y + 2, 1);
    const m = fine.score >= coarse.score ? fine : coarse;
    const lost = m.score < 0.35;
    if (!lost) {
      const mx = m.x + tw / 2, my = m.y + th / 2;   // Treffer-Mitte im Suchfenster
      if (is360 && g.fov) {
        const k = Math.tan((g.fov * Math.PI) / 360);
        const d = [((mx / S) * 2 - 1) * k, ((my / S) * 2 - 1) * k, 1];
        const R = panoMatrix(yaw, pitch, 0);
        const w = [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
        const n = Math.hypot(w[0], w[1], w[2]);
        yaw = (Math.atan2(w[0], w[2]) * 180) / Math.PI;
        pitch = (-Math.asin(w[1] / n) * 180) / Math.PI;
      } else if (g.region) {
        const cx = g.region.x + (mx / S) * g.region.w, cy = g.region.y + (my / S) * g.region.h;
        box = { ...box, x: cx / srcW - box.w / 2, y: cy / srcH - box.h / 2 };
      }
      // Vorlage langsam nachführen (Licht/Drehung ändern sich), aus dem neu zentrierten Bild
      if (m.score > 0.6) {
        const g2 = grab();
        const fresh = cut(g2.img, S, Math.round((S - tw) / 2), Math.round((S - th) / 2), tw, th);
        for (let i = 0; i < tpl.length; i++) tpl[i] = tpl[i] * 0.9 + fresh[i] * 0.1;
      }
      lostSince = -1;
    } else if (lostSince < 0) lostSince = local;
    samples.push({ t: local, yaw, pitch, size, box: { ...box }, score: m.score });
    // Anzeige: Suchfenster mit Rahmen
    wctx.strokeStyle = lost ? '#ff5252' : '#3dd6c1'; wctx.lineWidth = 2;
    wctx.strokeRect((S - tw) / 2, (S - th) / 2, tw, th);
    onProgress({ percent: Math.min(100, ((local - startLocal) / Math.max(0.01, dur - startLocal)) * 100), view: work, box, score: m.score, lost });
    return lostSince >= 0 && local - lostSince > 2;   // 2 s nicht gefunden → aufhören
  };

  // Video abspielen und jedes gelieferte Bild auswerten (schneller als einzeln springen)
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; v.pause(); resolve(); };
    const vfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number }).requestVideoFrameCallback?.bind(v);
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (done) return;
      const local = localAt(meta.mediaTime);
      if (signal.cancelled || local >= dur - 1e-3 || v.ended) { finish(); return; }
      v.pause();
      const stop = step(local);
      if (stop) { finish(); return; }
      if (vfc) vfc(onFrame);
      void v.play().catch(() => finish());
    };
    v.playbackRate = 1;
    v.onended = finish;
    if (vfc) { vfc(onFrame); void v.play().catch(() => finish()); }
    else {
      // ohne requestVideoFrameCallback: schrittweise springen (10 Bilder/s)
      const loop = async () => {
        for (let t = startLocal + 0.1; t < dur && !signal.cancelled; t += 0.1) {
          v.currentTime = clip.in + t * clip.speed;
          await new Promise<void>((r) => { v.onseeked = () => r(); });
          if (step(t)) break;
        }
        finish();
      };
      void loop();
    }
  });
  v.removeAttribute('src'); v.load();
  return samples;
}

/** Gleitender Mittelwert über ±w Sekunden (für ruhige Kamerafahrten). Gierwinkel werden vorher fortlaufend gemacht. */
function smooth<T extends FollowSample>(s: T[], key: 'yaw' | 'pitch', w: number): number[] {
  const vals = s.map((x) => x[key] ?? 0);
  if (key === 'yaw') for (let i = 1; i < vals.length; i++) vals[i] = vals[i - 1] + ((((vals[i] - vals[i - 1]) % 360) + 540) % 360 - 180);
  return vals.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = i; j >= 0 && s[i].t - s[j].t <= w; j--) { sum += vals[j]; n++; }
    for (let j = i + 1; j < s.length && s[j].t - s[i].t <= w; j++) { sum += vals[j]; n++; }
    return sum / n;
  });
}

/** 360°: Blick folgt dem Objekt → Keyframes (alle `every` Sekunden). */
export function samplesToPano(s: FollowSample[], fov: number, followPitch: boolean, basePitch: number, smoothSec = 0.35, every = 0.2): PanoKeyframe[] {
  if (!s.length) return [];
  const ys = smooth(s, 'yaw', smoothSec), ps = smooth(s, 'pitch', smoothSec);
  const out: PanoKeyframe[] = [];
  let next = s[0].t;
  for (let i = 0; i < s.length; i++) {
    if (s[i].t + 1e-6 < next && i !== s.length - 1) continue;
    const yaw = ((ys[i] + 540) % 360) - 180;
    out.push({ t: s[i].t, yaw, pitch: followPitch ? Math.max(-85, Math.min(85, ps[i])) : basePitch, roll: 0, fov });
    next = s[i].t + every;
  }
  return out;
}

/** Normal: Objekt-Spur (zum Anheften von Titeln/Effekten). */
export function samplesToTrack(s: FollowSample[]): ObjectTrack {
  const boxes: TrackBox[] = s.filter((x) => x.box).map((x) => ({ t: x.t, ...x.box! }));
  return { id: makeId('trk'), label: 'tracked', labelDe: 'Verfolgt', color: '#3dd6c1', boxes };
}

/** Normal: Ausschnitt folgt dem Objekt (gleicher Zoom). */
export function samplesToReframe(s: FollowSample[], zoom: number, srcW: number, srcH: number, aspect: number, smoothSec = 0.35, every = 0.2): ReframeKeyframe[] {
  const r = reframeRect({ zoom, x: 0, y: 0 }, srcW, srcH, aspect);
  const pos = s.map((x) => ({ t: x.t, cx: x.box ? x.box.x + x.box.w / 2 : 0.5, cy: x.box ? x.box.y + x.box.h / 2 : 0.5 }));
  const avg = (i: number, k: 'cx' | 'cy') => {
    let sum = 0, n = 0;
    for (const p of pos) if (Math.abs(p.t - pos[i].t) <= smoothSec) { sum += p[k]; n++; }
    return sum / n;
  };
  const out: ReframeKeyframe[] = [];
  let next = pos[0]?.t ?? 0;
  for (let i = 0; i < pos.length; i++) {
    if (pos[i].t + 1e-6 < next && i !== pos.length - 1) continue;
    const x = r.w < 1 ? (avg(i, 'cx') - r.w / 2) / (1 - r.w) : 0.5;
    const y = r.h < 1 ? (avg(i, 'cy') - r.h / 2) / (1 - r.h) : 0.5;
    out.push({ t: pos[i].t, zoom, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
    next = pos[i].t + every;
  }
  return out;
}
