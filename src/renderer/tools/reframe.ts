// Hochformat (oder Quadrat/4:5) per Knopf: Projektformat ändern, Clips füllen das Bild, der Ausschnitt bleibt
// mittig oder folgt einem erkannten Objekt (Auto, Person …). Alles in einem Rückgängig-Schritt.
import type { AiDetectModel, Clip, MediaItem, MotionKeyframe, Project } from '@shared/types';
import { clipDuration } from '@shared/timeline';
import { beginTransaction, endTransaction, useProject } from '../store/project';
import { detectAt } from '../ai/tracking';

export type ReframeTarget = '9:16' | '1:1' | '4:5' | '16:9';
export interface ReframeOptions {
  target: ReframeTarget;
  follow: 'center' | 'object';
  model: AiDetectModel;
  prefer: 'auto' | 'car' | 'person';   // welches Objekt verfolgt werden soll
  smooth: number;                        // 0..1 Kamerabewegung beruhigen
}

export function targetSize(_p: Project, target: ReframeTarget): { W: number; H: number } {
  // Standardgrößen der Plattformen
  switch (target) {
    case '9:16': return { W: 1080, H: 1920 };
    case '1:1': return { W: 1080, H: 1080 };
    case '4:5': return { W: 1080, H: 1350 };
    case '16:9': return { W: 1920, H: 1080 };
  }
}

const CAR = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'boat', 'airplane', 'train']);

/** Mittelpunkt (0..1, horizontal) des Hauptobjekts zu mehreren Zeiten im Clip. */
async function objectPath(clip: Clip, media: MediaItem, opts: ReframeOptions, onStep: () => void): Promise<Array<{ t: number; cx: number }>> {
  const dur = clipDuration(clip);
  const step = dur <= 6 ? 0.4 : dur <= 30 ? 0.75 : 1.5;
  const pts: Array<{ t: number; cx: number }> = [];
  let lastCx = 0.5;
  for (let t = 0; t <= dur + 1e-3; t += step) {
    const dets = await detectAt(clip, media, Math.min(t, Math.max(0, dur - 0.05)), opts.model).catch(() => []);
    const want = (d: { label: string }) => opts.prefer === 'car' ? CAR.has(d.label) : opts.prefer === 'person' ? d.label === 'person' : true;
    const cands = dets.filter(want);
    // größtes, sicherstes Objekt – bei Gleichstand das, das dem bisherigen am nächsten ist (keine Sprünge)
    let best: (typeof dets)[number] | null = null, bs = -1;
    for (const d of cands) {
      const score = d.score * Math.sqrt(d.w * d.h) * (1 - Math.min(0.6, Math.abs(d.x + d.w / 2 - lastCx)));
      if (score > bs) { bs = score; best = d; }
    }
    const cx = best ? best.x + best.w / 2 : lastCx;
    lastCx = cx;
    pts.push({ t: Math.min(t, dur), cx });
    onStep();
  }
  return pts;
}

/** Weich machen: gleitender Mittelwert. */
function smoothPath(pts: Array<{ t: number; cx: number }>, amount: number): Array<{ t: number; cx: number }> {
  const r = Math.round(amount * 3);
  if (r <= 0) return pts;
  return pts.map((p, i) => {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const q = pts[i + k]; if (q) { s += q.cx; n++; } }
    return { t: p.t, cx: s / n };
  });
}

export async function reframeProject(opts: ReframeOptions, onProgress: (pct: number, msg: string) => void): Promise<{ followed: number; skipped: number }> {
  const store = useProject.getState();
  const p = store.project;
  const { W, H } = targetSize(p, opts.target);
  const visual = Object.values(p.clips).filter((c) => c.kind !== 'title' && p.media[c.mediaId] && p.media[c.mediaId].type !== 'audio' && !p.media[c.mediaId].vfx && !c.link);
  const patches = new Map<string, Partial<Clip>>();
  let followed = 0, skipped = 0;
  // Geschätzte Schritte für den Fortschritt
  const total = Math.max(1, opts.follow === 'object' ? visual.reduce((s, c) => s + Math.ceil(clipDuration(c) / (clipDuration(c) <= 6 ? 0.4 : clipDuration(c) <= 30 ? 0.75 : 1.5)) + 1, 0) : visual.length);
  let done = 0;
  for (const c of visual) {
    const m = p.media[c.mediaId];
    const is360 = !!(m.info.is360 && c.pano);
    const patch: Partial<Clip> = {};
    if (!is360 && !m.hasAlpha && !m.model3d) patch.fit = 'cover';
    if (opts.follow === 'object' && !is360 && !m.hasAlpha && !m.model3d && m.info.width && m.info.height) {
      if (c.motion && c.motion.keyframes.length > 0) { skipped++; }
      else {
        onProgress(Math.round((done / total) * 100), c.name);
        const path = smoothPath(await objectPath(c, m, opts, () => { done++; onProgress(Math.round((done / total) * 100), c.name); }), opts.smooth);
        // Ausschnitt verschieben: Objektmitte soll in die Bildmitte, aber nie über den Bildrand hinaus
        const srcAspect = m.info.width / m.info.height;
        const dispW = Math.max(W, H * srcAspect) * (c.transform.scale || 1);
        const maxX = ((dispW - W) / 2 / W) * 100;
        if (maxX > 0.5) {
          const kfs: MotionKeyframe[] = path.map((q) => ({ t: q.t, x: Math.round(Math.max(-maxX, Math.min(maxX, -(q.cx - 0.5) * (dispW / W) * 100)) * 100) / 100, y: 0, scale: 1, rotation: 0, opacity: 1 }));
          patch.transform = { ...c.transform, x: 0 };
          patch.motion = { preset: 'custom', intensity: 1, smooth: true, keyframes: kfs };
          followed++;
        }
      }
    } else done++;
    patches.set(c.id, patch);
  }
  beginTransaction();
  try {
    useProject.getState().updateSettings({ width: W, height: H });
    for (const [id, patch] of patches) if (Object.keys(patch).length) useProject.getState().updateClip(id, patch);
  } finally {
    endTransaction();
  }
  onProgress(100, '');
  return { followed, skipped };
}
