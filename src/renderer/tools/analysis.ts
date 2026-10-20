// Hook-Finder und Grobschnitt: Analysen laufen nur auf Knopfdruck (im Hauptprozess), hier wird ausgewertet.
import type { Clip, MediaItem, Project } from '@shared/types';
import { clipDuration, clipEnd, projectDuration, sourceTimeAt, videoTracksBottomUp } from '@shared/timeline';
import { insertAtStart, mergeRanges, rippleCut, type TimeRange } from '@shared/edit';
import { beginTransaction, endTransaction, useProject } from '../store/project';

const api = () => window.panocut;

/** Quell-Bereich eines Clips (für die Analyse der Datei). */
function srcRange(c: Clip): { start: number; dur: number } {
  const a = Math.min(c.in, c.out), b = Math.max(c.in, c.out);
  return { start: a, dur: Math.max(0.1, b - a) };
}

/** Wert einer Kurve (Quellzeit) an einer Timeline-Zeit. */
function at(curve: { values: number[]; hop: number; offset: number }, c: Clip, T: number): number {
  const src = sourceTimeAt(c, T) - curve.offset;
  const i = Math.round(src / curve.hop);
  return curve.values[Math.max(0, Math.min(curve.values.length - 1, i))] ?? 0;
}

function visualClips(p: Project): Clip[] {
  const tracks = videoTracksBottomUp(p).filter((t) => !t.hidden).map((t) => t.id);
  return Object.values(p.clips).filter((c) => tracks.includes(c.trackId) && c.kind !== 'title' && p.media[c.mediaId]?.type === 'video' && !p.media[c.mediaId]?.vfx && !p.media[c.mediaId]?.model3d);
}

const file = (m: MediaItem) => m.proxy ?? m.path;

// ---------------------------------------------------------------- Hook-Finder

export interface HookCandidate { start: number; end: number; score: number; trackId: string; motion: number; loud: number }

/** Spannendste Stellen: viel Bewegung + lauter Ton, über ein Fenster von `length` Sekunden gemittelt. */
export async function findHooks(length: number, count: number, weightMotion: number, onProgress: (pct: number) => void): Promise<HookCandidate[]> {
  const p = useProject.getState().project;
  const clips = visualClips(p);
  const curves = new Map<string, { motion: { values: number[]; hop: number; offset: number }; audio: { values: number[]; hop: number; offset: number } | null }>();
  let i = 0;
  for (const c of clips) {
    const m = p.media[c.mediaId];
    const r = srcRange(c);
    const motion = await api().motionCurve(file(m), r.start, r.dur);
    let audio: { values: number[]; hop: number; offset: number } | null = null;
    if (m.info.hasAudio && !c.muted) {
      const env = await api().audioEnvelope(m.path, r.start, r.dur).catch(() => null);
      if (env) audio = { values: env.env, hop: env.hop, offset: r.start };
    }
    curves.set(c.id, { motion: { ...motion, offset: r.start }, audio });
    onProgress(Math.round((++i / Math.max(1, clips.length)) * 90));
  }
  const D = projectDuration(p);
  const step = 0.25;
  const mot: number[] = [], loud: number[] = [], owner: string[] = [];
  for (let T = 0; T < D; T += step) {
    // oberster sichtbarer Clip an dieser Stelle
    let best: Clip | null = null;
    for (const c of clips) if (T >= c.start && T < clipEnd(c) && (!best || trackOrder(p, c.trackId) > trackOrder(p, best.trackId))) best = c;
    const cv = best ? curves.get(best.id) : undefined;
    mot.push(best && cv ? at(cv.motion, best, T) : 0);
    loud.push(best && cv?.audio ? at(cv.audio, best, T) : 0);
    owner.push(best?.id ?? '');
  }
  const norm = (a: number[]) => { const mx = Math.max(1e-6, ...a.map((x) => x).sort((x, y) => y - x).slice(0, Math.max(1, Math.floor(a.length * 0.02)))); return a.map((x) => Math.min(1, x / mx)); };
  const nm = norm(mot), nl = norm(loud);
  const wm = Math.max(0, Math.min(1, weightMotion));
  const score = nm.map((x, k) => wm * x + (1 - wm) * nl[k]);
  const win = Math.max(1, Math.round(length / step));
  const sums: number[] = [];
  for (let k = 0; k + win <= score.length; k++) {
    let s = 0;
    for (let j = 0; j < win; j++) s += score[k + j];
    // ein Fenster muss durchgehend Bild haben
    let ok = true;
    for (let j = 0; j < win; j++) if (!owner[k + j]) { ok = false; break; }
    sums.push(ok ? s / win : -1);
  }
  const out: HookCandidate[] = [];
  const used: TimeRange[] = [];
  const order = sums.map((s, k) => ({ s, k })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  for (const { s, k } of order) {
    const start = k * step, end = start + win * step;
    if (used.some((u) => start < u.end + 0.5 && end > u.start - 0.5)) continue;
    used.push({ start, end });
    let ms = 0, ls = 0;
    for (let j = 0; j < win; j++) { ms += nm[k + j]; ls += nl[k + j]; }
    out.push({ start, end, score: s, trackId: p.clips[owner[k]]?.trackId ?? '', motion: ms / win, loud: ls / win });
    if (out.length >= count) break;
  }
  onProgress(100);
  return out;
}

function trackOrder(p: Project, trackId: string): number {
  const vids = videoTracksBottomUp(p);
  return vids.findIndex((t) => t.id === trackId);
}

/** Die gefundene Stelle als Anfang des Videos einfügen (der Rest rückt nach hinten). */
export function applyHookAsIntro(h: HookCandidate): void {
  const p = useProject.getState().project;
  if (!h.trackId) return;
  const clips = insertAtStart(p, h.trackId, h.start, h.end);
  beginTransaction();
  try {
    useProject.getState().removeClips(Object.keys(p.clips));
    useProject.getState().insertClips(clips);
  } finally {
    endTransaction();
  }
}

// ---------------------------------------------------------------- Grobschnitt

export interface RoughCandidate { id: string; clipId: string; start: number; end: number; reason: 'pause' | 'blur' | 'filler'; detail: string }
export interface RoughOptions { pauses: boolean; pauseDb: number; pauseMin: number; keep: number; blur: boolean; blurLevel: number; fillers: boolean }

const FILLER = /^(äh+m*|ähm+|öh+m*|hm+|ehm+|uh+m*|um+|uhm+|erm+)[,.!?…]*$/i;

/** Pausen, unscharfe/verwackelte Stellen und Füllwörter finden (Zeiten auf der Timeline). */
export async function findRoughCuts(o: RoughOptions, onProgress: (pct: number) => void): Promise<{ candidates: RoughCandidate[]; noSubtitles: boolean }> {
  const p = useProject.getState().project;
  const clips = visualClips(p);
  const out: RoughCandidate[] = [];
  let noSubtitles = false;
  let i = 0;
  const toTl = (c: Clip, src: number) => {
    const local = c.reverse ? (c.out - src) / c.speed : (src - c.in) / c.speed;
    return c.start + Math.max(0, Math.min(clipDuration(c), local));
  };
  for (const c of clips) {
    const m = p.media[c.mediaId];
    const r = srcRange(c);
    if (o.pauses && m.info.hasAudio) {
      const sil = await api().silences(m.path, r.start, r.dur, o.pauseDb, o.pauseMin).catch(() => []);
      for (const s of sil) {
        // ein wenig Luft stehen lassen, damit es nicht abgehackt klingt
        let a = toTl(c, r.start + s.start), b = toTl(c, r.start + s.end);
        if (a > b) [a, b] = [b, a];
        a += o.keep / 2; b -= o.keep / 2;
        if (b - a > 0.15) out.push({ id: `${c.id}-p${out.length}`, clipId: c.id, start: a, end: b, reason: 'pause', detail: `${(b - a).toFixed(1).replace('.', ',')} s` });
      }
    }
    if (o.blur) {
      const bc = await api().blurCurve(file(m), r.start, r.dur).catch(() => ({ values: [], hop: 0.5 }));
      if (bc.values.length) {
        const sorted = [...bc.values].sort((x, y) => x - y);
        const median = sorted[Math.floor(sorted.length / 2)] || 1;
        const thr = median * (1.4 + (1 - o.blurLevel) * 1.2);
        let runStart = -1;
        bc.values.forEach((v, k) => {
          const bad = v > thr;
          if (bad && runStart < 0) runStart = k;
          if ((!bad || k === bc.values.length - 1) && runStart >= 0) {
            const endK = bad ? k + 1 : k;
            if ((endK - runStart) * bc.hop >= 0.5) {
              let a = toTl(c, r.start + runStart * bc.hop), b = toTl(c, r.start + endK * bc.hop);
              if (a > b) [a, b] = [b, a];
              out.push({ id: `${c.id}-b${out.length}`, clipId: c.id, start: a, end: b, reason: 'blur', detail: `${(b - a).toFixed(1).replace('.', ',')} s` });
            }
            runStart = -1;
          }
        });
      }
    }
    if (o.fillers) {
      const segs = c.subtitles?.segments ?? [];
      if (!segs.length) noSubtitles = true;
      for (const s of segs) for (const w of s.words ?? []) {
        if (FILLER.test(w.text.trim())) out.push({ id: `${c.id}-f${out.length}`, clipId: c.id, start: c.start + w.start, end: c.start + w.end, reason: 'filler', detail: `„${w.text.trim()}“` });
      }
    }
    onProgress(Math.round((++i / Math.max(1, clips.length)) * 100));
  }
  out.sort((a, b) => a.start - b.start);
  return { candidates: out, noSubtitles };
}

/** Ausgewählte Stellen herausschneiden und die Lücken schließen (Musik auf anderen Spuren bleibt durchgehend). */
export function applyRoughCuts(cands: RoughCandidate[]): number {
  const p = useProject.getState().project;
  if (!cands.length) return 0;
  const tracks = new Set(cands.map((c) => p.clips[c.clipId]?.trackId).filter(Boolean) as string[]);
  const ranges = mergeRanges(cands.map((c) => ({ start: c.start, end: c.end })));
  const clips = rippleCut(p, ranges, tracks);
  beginTransaction();
  try {
    useProject.getState().removeClips(Object.keys(p.clips));
    useProject.getState().insertClips(clips);
  } finally {
    endTransaction();
  }
  return ranges.reduce((s, r) => s + r.end - r.start, 0);
}
