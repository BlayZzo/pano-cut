// Effekte erzeugen, neu rendern, an die Szene anpassen – und Objekte vor andere Ebenen holen.
import type { Clip, MediaItem, VfxSpec } from '@shared/types';
import { clipAt, clipDuration, createClip, makeId } from '@shared/timeline';
import { frameStats } from '@shared/color';
import { defaultVfx, matchToScene, shakeKeyframes, vfxKind } from '@shared/vfx';
import { combineKeyframes, entranceKeyframes, type EntranceStyle, type FrameBox } from '@shared/effects';
import { trackBoxAt } from '@shared/ai';
import { beginTransaction, endTransaction, untracked, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { engine } from '../engine/instance';
import { t } from '../i18n/de';
import { LIGHT_SCALE, renderVfx } from './render';

export interface GenerateOptions {
  matchScene: boolean;
  light: boolean;
  shake: boolean;
}

type Progress = (percent: number, message: string) => void;

/** Oberster Medien-Clip unter einer Spur zu einer Zeit (die „Szene“ hinter einem Effekt). */
function sceneClipBelow(trackId: string | null, time: number): Clip | null {
  const p = useProject.getState().project;
  const tracks = p.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden);
  const start = trackId ? tracks.findIndex((tr) => tr.id === trackId) + 1 : 0;
  for (const tr of tracks.slice(Math.max(0, start))) {
    const c = clipAt(p, tr.id, time);
    if (!c || c.kind === 'title' || c.link) continue;
    const m = p.media[c.mediaId];
    if (!m || m.type === 'audio' || m.vfx) continue;
    return c;
  }
  return null;
}

/** Erzeugt die beschriebenen Effekte und legt sie (mit Lichtschein) über das Video am Abspielkopf. */
export async function generateEffects(specs: VfxSpec[], opts: GenerateOptions, onProgress: Progress): Promise<string[]> {
  const created: string[] = [];
  const at = useUi.getState().playhead;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const def = vfxKind(spec.kind);
    const projectId = useProject.getState().project.id;
    const res = await renderVfx(projectId, spec, {
      withLight: opts.light,
      onProgress: (p, msg) => onProgress(Math.round(((i + p / 100) / specs.length) * 100), `${def.name}: ${msg}`),
    });
    untracked(() => useProject.getState().addMedia(res.light ? [res.effect, res.light] : [res.effect]));
    const scene = sceneClipBelow(null, at + 0.01);
    beginTransaction();
    const st = useProject.getState();
    const topVideo = st.project.tracks.find((tr) => tr.kind === 'video')?.id ?? null;
    const lightTrack = res.light ? st.addVideoTrackAbove(topVideo, `Licht: ${def.name}`) : null;
    const fxTrack = useProject.getState().addVideoTrackAbove(lightTrack ?? topVideo, `Effekt: ${def.name}`);
    const clips: Clip[] = [];
    const dur = res.effect.info.duration;
    // Ganzbild-Effekte (Schnee, Regen …) laufen nahtlos weiter bis zum Ende der Szene
    let reps = 1;
    let lastOut = dur;
    if (def.fullFrame && spec.loop && scene) {
      const remain = Math.min(120, scene.start + clipDuration(scene) - at);
      if (remain > dur) { reps = Math.ceil(remain / dur - 1e-3); lastOut = remain - (reps - 1) * dur; }
    }
    for (let r = 0; r < reps; r++) {
      const c = createClip(res.effect, fxTrack, at + r * dur);
      c.name = res.effect.name;
      if (r === reps - 1) c.out = Math.max(0.1, Math.min(dur, lastOut));
      if (def.fullFrame) { c.fit = 'cover'; }
      else { c.fit = 'contain'; c.transform = { x: 0, y: def.y, scale: Math.max(0.15, Math.min(2.5, def.scale * spec.size)), rotation: 0 }; }
      clips.push(c);
    }
    const main = clips[0];
    if (res.light) {
      const l = createClip(res.light, lightTrack!, at);
      l.name = res.light.name;
      l.blend = 'screen';
      l.opacity = 0.85;
      l.link = { clipId: main.id, mode: 'light', scale: LIGHT_SCALE };
      clips.push(l);
    }
    useProject.getState().insertClips(clips);
    endTransaction();
    useUi.getState().select([main.id]);
    created.push(main.id);
    if (opts.matchScene) await matchEffectToScene(main.id, { shake: opts.shake && spec.kind === 'explosion' }).catch(() => {});
  }
  return created;
}

/** Effekt mit geänderten Einstellungen neu rendern (Clips behalten Position, Mischmodus usw.). */
export async function rerenderEffect(mediaId: string, spec: VfxSpec, onProgress: Progress): Promise<void> {
  const p = useProject.getState().project;
  const effectMedia = p.media[mediaId];
  if (!effectMedia?.vfx) return;
  const effectClips = Object.values(p.clips).filter((c) => c.mediaId === mediaId);
  const lightClips = Object.values(p.clips).filter((c) => c.link?.mode === 'light' && effectClips.some((e) => e.id === c.link!.clipId));
  const lightMediaId = lightClips[0]?.mediaId;
  const res = await renderVfx(p.id, spec, { mediaId, lightMediaId, withLight: !!lightMediaId, onProgress });
  const oldDur = effectMedia.info.duration;
  untracked(() => {
    useProject.getState().updateMedia(res.effect);
    if (res.light) useProject.getState().updateMedia(res.light);
  });
  // Clip-Längen an die neue Dauer anpassen (wer bis zum Ende lief, läuft wieder bis zum Ende)
  const newDur = res.effect.info.duration;
  beginTransaction();
  const st = useProject.getState();
  for (const c of [...effectClips, ...lightClips]) {
    const cur = st.project.clips[c.id];
    if (!cur) continue;
    const out = Math.abs(cur.out - oldDur) < 0.05 || cur.out > newDur ? newDur : cur.out;
    if (Math.abs(out - cur.out) > 1e-4) useProject.getState().updateClip(c.id, { out });
  }
  endTransaction();
  engine.render(useUi.getState().playhead);
}

/** Region eines Bildes (normierte Mitte/Halbgröße) auswerten. */
function regionStats(img: ImageData, cx: number, cy: number, half: number) {
  const x0 = Math.max(0, Math.floor((cx - half) * img.width)), x1 = Math.min(img.width, Math.ceil((cx + half) * img.width));
  const y0 = Math.max(0, Math.floor((cy - half) * img.height)), y1 = Math.min(img.height, Math.ceil((cy + half) * img.height));
  if (x1 - x0 < 4 || y1 - y0 < 4) return frameStats(img.data);
  const out = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) out.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1) * 4), (y - y0) * (x1 - x0) * 4);
  return frameStats(out);
}

/** Effekt an die Szene anpassen: Farbe/Helligkeit, Lichtschein-Stärke, Schatten – optional Erschütterung. */
export async function matchEffectToScene(clipId: string, opts: { shake: boolean }): Promise<void> {
  const p = useProject.getState().project;
  const fx = p.clips[clipId];
  const media = fx ? p.media[fx.mediaId] : undefined;
  const spec = media?.vfx;
  if (!fx || !spec) return;
  const def = vfxKind(spec.kind);
  const time = fx.start + Math.min(clipDuration(fx) * 0.3, 1);
  const scene = sceneClipBelow(fx.trackId, time);
  if (!scene) { useUi.getState().toast(t.vfx.noScene, 'error'); return; }
  const sceneMedia = p.media[scene.mediaId]!;
  const img = await engine.grabFrame(scene, sceneMedia, time - scene.start, 320);
  if (!img) return;
  const half = def.fullFrame ? 0.5 : Math.max(0.12, Math.min(0.5, fx.transform.scale * 0.35));
  const stats = regionStats(img, 0.5 + fx.transform.x / 100, 0.5 + fx.transform.y / 100, half);
  const m = matchToScene(spec, stats);
  beginTransaction();
  const st = useProject.getState();
  st.updateClip(fx.id, { color: { ...fx.color, ...m.color }, shadow: m.shadow ?? fx.shadow });
  for (const c of Object.values(st.project.clips)) {
    if (c.link?.mode === 'light' && c.link.clipId === fx.id) useProject.getState().updateClip(c.id, { opacity: m.lightStrength });
  }
  if (opts.shake && (!scene.motion || scene.motion.preset === 'custom')) {
    const local = Math.max(0, fx.start - scene.start + 0.03);
    const keep = (scene.motion?.keyframes ?? []).filter((k) => k.t < local - 0.1 || k.t > local + 1.2);
    const kfs = [...keep, ...shakeKeyframes(local, Math.max(0.4, spec.intensity), clipDuration(scene))].sort((a, b) => a.t - b.t);
    useProject.getState().updateClip(scene.id, { motion: { preset: 'custom', intensity: 1, smooth: true, keyframes: kfs } });
  }
  endTransaction();
  useUi.getState().toast(t.vfx.matched, 'success');
}

/** Getracktes Objekt vor alle anderen Ebenen holen (z. B. Auto fährt „durch“ einen Text). */
export function bringObjectToFront(clipId: string, trackId: string): void {
  const p = useProject.getState().project;
  const clip = p.clips[clipId];
  const obj = clip?.objects?.find((o) => o.id === trackId);
  if (!clip || !obj) return;
  if (!obj.masks?.length) { useUi.getState().toast(t.layers.needMasks, 'error'); return; }
  beginTransaction();
  const st = useProject.getState();
  const top = st.project.tracks.find((tr) => tr.kind === 'video')?.id ?? null;
  const track = st.addVideoTrackAbove(top, `Vorne: ${obj.labelDe}`);
  const copy: Clip = {
    ...clip,
    id: makeId('clip'),
    trackId: track,
    name: `${obj.labelDe} (vorne)`,
    muted: true,
    volume: 0,
    cutout: { enabled: true, trackId, feather: clip.cutout?.feather ?? 2, grow: clip.cutout?.grow ?? 1, invert: false },
    chroma: undefined, subtitles: undefined, transition: undefined, attach: undefined, blend: undefined, shadow: undefined, ducking: undefined,
    link: { clipId: clip.id, mode: 'copy' },
  };
  useProject.getState().insertClips([copy]);
  endTransaction();
  useUi.getState().select([copy.id]);
  useUi.getState().toast(t.layers.broughtToFront, 'success');
}

/** Für die Bibliothek: ist das ein Effekt-Medium? */
export function isEffectMedia(m: MediaItem | undefined): boolean {
  return !!m?.vfx;
}

// ---------- Objekt ins Video fallen lassen (Auftritt + Aufprall) ----------

export interface DropInOptions { style: EntranceStyle; strength: number; dust: boolean; shake: boolean }

/** Lage des Objekts im fertigen Bild (0..1): aus der gemerkten Objekt-Box, dem Freistell-Tracking oder dem ganzen Clip. */
export function objectFrameBox(clip: Clip, media: MediaItem, W: number, H: number, localT: number): FrameBox {
  let b: { x: number; y: number; w: number; h: number } | null = media.bbox ?? null;
  if (clip.cutout?.enabled) {
    const tr = clip.objects?.find((o) => o.id === clip.cutout!.trackId);
    const tb = tr ? trackBoxAt(tr, localT) : null;
    if (tb) b = tb;
  }
  if (!b) b = { x: 0, y: 0, w: 1, h: 1 };
  const vw = media.info.width || W, vh = media.info.height || H;
  const sc = clip.transform.scale;
  let dw: number, dh: number;
  if (clip.fit === 'stretch') { dw = W * sc; dh = H * sc; }
  else { const s = (clip.fit === 'cover' ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh)) * sc; dw = vw * s; dh = vh * s; }
  const cx = W / 2 + (clip.transform.x / 100) * W, cy = H / 2 + (clip.transform.y / 100) * H;
  return { x: (cx - dw / 2 + b.x * dw) / W, y: (cy - dh / 2 + b.y * dh) / H, w: (b.w * dw) / W, h: (b.h * dh) / H };
}

/** Erschütterung in einen Szenen-Clip einsetzen (wie bei der Explosion). */
function shakeScene(scene: Clip, at: number, strength: number): void {
  if (scene.motion && scene.motion.preset !== 'custom') return;
  const local = Math.max(0, at - scene.start);
  const keep = (scene.motion?.keyframes ?? []).filter((k) => k.t < local - 0.1 || k.t > local + 1.2);
  const kfs = [...keep, ...shakeKeyframes(local, strength, clipDuration(scene))].sort((a, b) => a.t - b.t);
  useProject.getState().updateClip(scene.id, { motion: { preset: 'custom', intensity: 1, smooth: true, keyframes: kfs } });
}

/**
 * Auftritt für ein freigestelltes Objekt: fällt/rast ins Bild, beim Aufprall Staubwolke mit Trümmern und
 * Erschütterung der Szene. Alles mit einer Stärke (0,3..2).
 */
export async function dropObjectIn(clipId: string, opts: DropInOptions, onProgress: Progress): Promise<void> {
  const p = useProject.getState().project;
  const clip = p.clips[clipId];
  const media = clip ? p.media[clip.mediaId] : undefined;
  if (!clip || !media) return;
  const { width: W, height: H, fps } = p.settings;
  const dur = clipDuration(clip);
  const box = objectFrameBox(clip, media, W, H, Math.min(dur, 1));
  const { keyframes, impact } = entranceKeyframes(opts.style, opts.strength, dur, box);
  const shakeStrength = Math.max(0.3, opts.strength * 0.8);
  let kfs = keyframes;
  // Das Objekt wackelt beim Aufprall mit der Szene mit (sonst wirkt es losgelöst)
  if (impact !== null && opts.shake) kfs = combineKeyframes(kfs, shakeKeyframes(impact, shakeStrength, dur));
  const scene = impact !== null ? sceneClipBelow(clip.trackId, clip.start + impact) : null;
  beginTransaction();
  useProject.getState().updateClip(clip.id, { motion: { preset: opts.style, intensity: opts.strength, smooth: false, keyframes: kfs } });
  if (scene && opts.shake && impact !== null) shakeScene(scene, clip.start + impact + 0.02, shakeStrength);
  endTransaction();
  if (impact === null || !opts.dust) { useUi.getState().toast(t.dropIn.done, 'success'); return; }

  // Staubfarbe vom Boden unter dem Objekt nehmen (Staub besteht aus dem, was dort liegt)
  const spec: VfxSpec = { ...defaultVfx('impact', W, H, fps, 'Aufprall'), intensity: Math.max(0.3, Math.min(2, 0.4 + 0.6 * opts.strength)), size: 1 };
  if (scene) {
    const img = await engine.grabFrame(scene, p.media[scene.mediaId]!, clip.start + impact - scene.start, 320).catch(() => null);
    if (img) {
      const st = regionStats(img, box.x + box.w / 2, Math.min(0.97, box.y + box.h + 0.03), Math.max(0.05, box.w * 0.4));
      const lift = (v: number) => Math.round(Math.min(255, (0.35 + 0.65 * v) * 255 * 1.05 + 25));
      spec.color = `#${[st.meanR, st.meanG, st.meanB].map((v) => lift(v).toString(16).padStart(2, '0')).join('')}`;
    }
  }
  const res = await renderVfx(p.id, spec, { withLight: false, onProgress });
  untracked(() => useProject.getState().addMedia([res.effect]));
  // Größe: Wolke etwa 2,4× so breit wie das Objekt; Bodenpunkt des Effekts (75 % der Höhe) auf die Unterkante des Objekts
  const ew = res.effect.info.width || spec.width, eh = res.effect.info.height || spec.height;
  const contain = Math.min(W / ew, H / eh);
  const targetW = Math.max(0.25, Math.min(2.5, box.w * 2.4)) * W;
  const sc = targetW / (ew * contain);
  const dispH = eh * contain * sc;
  const groundX = (box.x + box.w / 2) * W, groundY = Math.min(H * 1.05, (box.y + box.h) * H);
  beginTransaction();
  const track = useProject.getState().addVideoTrackAbove(clip.trackId, `Effekt: ${vfxKind('impact').name}`);
  const fx = createClip(res.effect, track, Math.max(0, clip.start + impact - 0.02));
  fx.name = res.effect.name;
  fx.fit = 'contain';
  fx.transform = { x: (groundX / W - 0.5) * 100, y: ((groundY - 0.275 * dispH) / H - 0.5) * 100, scale: sc, rotation: 0 };
  useProject.getState().insertClips([fx]);
  endTransaction();
  useUi.getState().select([clip.id]);
  useUi.getState().toast(t.dropIn.done, 'success');
}
