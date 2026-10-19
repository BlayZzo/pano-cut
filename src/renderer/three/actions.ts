// 3D-Modelle ins Video bringen: rendern (Video mit Transparenz), einfügen, neu rendern, Licht an die Szene anpassen.
import type { Clip, MediaItem, Model3DSpec } from '@shared/types';
import { clipAt, clipDuration, createClip } from '@shared/timeline';
import { frameStats } from '@shared/color';
import { lightFromScene } from '@shared/model3d';
import { beginTransaction, endTransaction, untracked, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { engine } from '../engine/instance';
import { t } from '../i18n/de';
import { ModelStage } from './model3d';

type Progress = (percent: number, message: string) => void;

let stage: Promise<ModelStage> | null = null;
/** Eine gemeinsame 3D-Bühne (WebGL-Kontexte sind begrenzt). */
export function sharedStage(): Promise<ModelStage> {
  if (!stage) stage = ModelStage.create();
  return stage;
}

let cancelFlag = false;
export function cancelModelRender(): void { cancelFlag = true; }

/** Modell Bild für Bild rendern und als Video mit Transparenz speichern. */
export async function renderModel(spec: Model3DSpec, mediaId: string | undefined, onProgress: Progress): Promise<MediaItem> {
  cancelFlag = false;
  const st = await sharedStage();
  await st.load(spec);
  const api = window.panocut;
  const projectId = useProject.getState().project.id;
  const frames = Math.max(1, Math.round(spec.duration * spec.fps));
  const job = await api.vfxBegin({ projectId, model: spec, fps: spec.fps, role: 'effect', width: spec.width, height: spec.height, mediaId, name: spec.name });
  try {
    let lastYield = performance.now();
    // Lage des Modells im Bild (für Auftritte/Aufprall): Hülle der deckenden Pixel einiger Bilder
    const W = spec.width, H = spec.height;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < frames; i++) {
      if (cancelFlag) throw new Error('Abgebrochen');
      st.draw(spec, i / spec.fps, W, H);
      const px = st.readPixels(W, H);
      if (i % 10 === 0 || i === frames - 1) {
        for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
          if (px[(y * W + x) * 4 + 3] < 200) continue;   // Schatten (halbdurchsichtig) zählt nicht
          const yy = H - 1 - y;                           // WebGL-Zeilen laufen von unten nach oben
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
        }
      }
      await api.vfxFrame(job, px);
      if (i % 3 === 0) onProgress(Math.round(((i + 1) / frames) * 97), `Bild ${i + 1} von ${frames} …`);
      if (performance.now() - lastYield > 40) { await new Promise((r) => setTimeout(r, 0)); lastYield = performance.now(); }
    }
    onProgress(98, 'Video wird gespeichert …');
    const media = await api.vfxEnd(job);
    if (x1 > x0 && y1 > y0) media.bbox = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
    onProgress(100, 'Fertig');
    return media;
  } catch (e) {
    await api.vfxCancel(job).catch(() => {});
    throw e;
  }
}

/** Oberster Medien-Clip zur Zeit `time` (die Szene, in die das Modell kommt). */
function sceneAt(time: number): Clip | null {
  const p = useProject.getState().project;
  for (const tr of p.tracks.filter((x) => x.kind === 'video' && !x.hidden)) {
    const c = clipAt(p, tr.id, time);
    if (!c || c.kind === 'title' || c.link) continue;
    const m = p.media[c.mediaId];
    if (!m || m.type === 'audio' || m.vfx || m.model3d || m.hasAlpha) continue;
    return c;
  }
  return null;
}

/** Licht des Modells aus dem Videobild am Abspielkopf schätzen (Richtung, Farbe, Stärke, Schatten). */
export async function lightFromVideo(): Promise<Partial<Model3DSpec> | null> {
  const time = useUi.getState().playhead;
  const scene = sceneAt(time + 0.01);
  if (!scene) return null;
  const media = useProject.getState().project.media[scene.mediaId]!;
  const img = await engine.grabFrame(scene, media, time - scene.start, 320);
  if (!img) return null;
  // Helligkeitsverlauf: rechte gegen linke Hälfte, obere gegen untere
  let l = 0, r = 0, top = 0, bottom = 0;
  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4;
    const v = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (x < w / 2) l += v; else r += v;
    if (y < h / 2) top += v; else bottom += v;
  }
  const n = (w * h) / 8;
  const dx = (r - l) / n, dy = (top - bottom) / n;
  return lightFromScene(frameStats(img.data), { dx, dy });
}

/** Gerendertes Modell als neuen Clip über das Video am Abspielkopf legen. */
export function insertModelClip(media: MediaItem): string {
  untracked(() => useProject.getState().addMedia([media]));
  const at = useUi.getState().playhead;
  beginTransaction();
  const st = useProject.getState();
  const top = st.project.tracks.find((tr) => tr.kind === 'video')?.id ?? null;
  const track = st.addVideoTrackAbove(top, `3D: ${media.name}`);
  const c = createClip(media, track, at);
  c.name = media.name;
  c.fit = 'contain';
  c.transform = { x: 0, y: 8, scale: 0.7, rotation: 0 };
  // Bodenschatten ist im Video enthalten – zusätzlicher Ebenen-Schatten nicht nötig
  useProject.getState().insertClips([c]);
  endTransaction();
  useUi.getState().select([c.id]);
  useUi.getState().toast(t.model3d.inserted, 'success');
  return c.id;
}

/** Bestehendes Modell mit neuen Einstellungen neu rendern (Clips behalten Lage und Länge, wo möglich). */
export async function rerenderModel(mediaId: string, spec: Model3DSpec, onProgress: Progress): Promise<void> {
  const p = useProject.getState().project;
  const old = p.media[mediaId];
  if (!old?.model3d) return;
  const media = await renderModel(spec, mediaId, onProgress);
  untracked(() => useProject.getState().updateMedia(media));
  const oldDur = old.info.duration, newDur = media.info.duration;
  beginTransaction();
  for (const c of Object.values(useProject.getState().project.clips)) {
    if (c.mediaId !== mediaId) continue;
    const out = Math.abs(c.out - oldDur) < 0.05 || c.out > newDur ? newDur : c.out;
    if (Math.abs(out - c.out) > 1e-4) useProject.getState().updateClip(c.id, { out });
  }
  endTransaction();
  engine.render(useUi.getState().playhead);
}

export function modelClipDuration(c: Clip): number { return clipDuration(c); }
