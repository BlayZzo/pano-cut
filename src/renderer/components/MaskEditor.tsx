// ✏️ Masken-Editor: Maske an beliebiger Stelle eines Clips zeichnen (Pinsel, Radierer, Lasso, Punkte, KI) und
// durch das Video verfolgen. Normale Videos: Maske im Quellbild. 360°: Maske im ganzen Rundum-Bild (Equirect).
// Gespeichert wird als ObjectTrack (Masken-PNGs je Zeit, `keys` = selbst bearbeitete Stellen).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip, ObjectTrack } from '@shared/types';
import { clipDuration, makeId, sourceTimeAt } from '@shared/timeline';
import { beginTransaction, endTransaction, setDirty, useProject } from '../store/project';
import { useUi } from '../store/ui';
import { fmt, t } from '../i18n/de';
import { canvasToPng } from './previewTools';
import { forgetMask } from '../engine/playback';
import { bringObjectToFront } from '../vfx/actions';
import { IconClose } from './Icons';

type Tool = 'brush' | 'erase' | 'lasso' | 'poly' | 'ai' | 'hand';
type ViewMode = 'overlay' | 'mask' | 'cut';
interface Poly { pts: Array<[number, number]>; closed: boolean; sub: boolean }

const COLORS = [{ id: 'pink', css: '#ff2d95' }, { id: 'lila', css: '#a855f7' }, { id: 'cyan', css: '#22d3ee' }];

/** Quellzeit → Clip-Zeit (umgekehrt zu sourceTimeAt). */
function localFromSource(clip: Clip, src: number): number {
  return clip.reverse ? (clip.out - src) / clip.speed : (src - clip.in) / clip.speed;
}

/** Maske (Weiß mit Deckkraft) → Graustufen-Bytes. */
function maskBytes(c: HTMLCanvasElement): Uint8Array {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(c.width * c.height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = d[i + 3];
  return out;
}
function putMask(c: HTMLCanvasElement, bytes: Uint8Array): void {
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const img = g.createImageData(c.width, c.height);
  for (let i = 0, p = 0; p < bytes.length; i += 4, p++) { img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = bytes[p]; }
  g.putImageData(img, 0, 0);
}
/** Maske als Graustufen-PNG (Schwarz = weg, Weiß = sichtbar) – so liest sie der Export. */
async function maskPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const o = document.createElement('canvas');
  o.width = c.width; o.height = c.height;
  const g = o.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, o.width, o.height);
  g.drawImage(c, 0, 0);
  return canvasToPng(o);
}
function boxOf(bytes: Uint8Array, W: number, H: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (bytes[y * W + x] >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
}
/** Punkte vereinfachen (Douglas-Peucker). */
function simplify(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function MaskEditor(): React.ReactElement | null {
  const req = useUi((s) => s.maskEditor);
  if (!req) return null;
  return <MaskEditorInner key={`${req.clipId}|${req.trackId ?? ''}`} clipId={req.clipId} initialTrack={req.trackId} />;
}

function MaskEditorInner({ clipId, initialTrack }: { clipId: string; initialTrack?: string }): React.ReactElement | null {
  const clip = useProject((s) => s.project.clips[clipId]);
  const media = useProject((s) => (clip ? s.project.media[clip.mediaId] : undefined));
  const fps = useProject((s) => s.project.settings.fps || 30);
  const toast = useUi((s) => s.toast);
  const close = () => useUi.getState().setMaskEditor(null);

  const [trackId, setTrackId] = useState<string | undefined>(initialTrack ?? clip?.objects?.find((o) => o.label === 'manual' || o.label === 'ai-mask')?.id);
  // aktuelle Spur-ID auch für asynchrone Abläufe (Zustand wäre dort veraltet)
  const tid = useRef<string | undefined>(trackId);
  tid.current = trackId ?? tid.current;
  const track = clip?.objects?.find((o) => o.id === trackId);
  const dur = clip ? clipDuration(clip) : 0;
  const ui0 = useUi.getState();
  const [local, setLocal] = useState(() => (clip ? Math.max(0, Math.min(dur, ui0.playhead - clip.start)) : 0));
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [space, setSpace] = useState<'source' | 'equirect'>('source');
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState<Tool>('ai');
  const [brush, setBrush] = useState({ size: 24, hardness: 0.7 });
  const [view, setView] = useState<{ mode: ViewMode; color: string; opacity: number }>({ mode: 'overlay', color: COLORS[0].css, opacity: 0.5 });
  const [poly, setPoly] = useState<Poly | null>(null);
  const [selV, setSelV] = useState<number | null>(null);
  const [ai, setAi] = useState<{ points: Array<{ x: number; y: number; label: 0 | 1 }>; box?: { x0: number; y0: number; x1: number; y1: number }; mode: 'replace' | 'add' | 'sub' }>({ points: [], mode: 'replace' });
  const [aiBusy, setAiBusy] = useState(false);
  const [tracking, setTracking] = useState<number | null>(null);
  const [trackMode, setTrackMode] = useState<'ai' | 'fast'>('ai');
  const [everyFrame, setEveryFrame] = useState(false);
  const [until, setUntil] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [use, setUse] = useState<'cutout' | 'remove' | 'front' | 'none'>(clip?.cutout?.enabled && clip.cutout.trackId === trackId ? (clip.cutout.invert ? 'remove' : 'cutout') : 'cutout');

  const imgRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const maskRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const tintRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const cutRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const loadedT = useRef(0);   // Clip-Zeit des geladenen Bilds (gespeichert wird immer dorthin)
  const viewRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tf = useRef({ s: 1, ox: 0, oy: 0 });
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const dirty = useRef(false);
  const undo = useRef<Uint8Array[]>([]);
  const redo = useRef<Uint8Array[]>([]);
  const aiBase = useRef<Uint8Array | null>(null);
  const spaceDown = useRef(false);
  const userView = useRef(false);   // selbst gezoomt/verschoben → beim Größe-Ändern nicht neu einpassen
  const redraw = useCallback(() => setTick((x) => x + 1), []);

  // ---------- Laden ----------
  const W = size?.w ?? 0, H = size?.h ?? 0;
  const wrap = space === 'equirect';
  const half = 0.5 / fps;

  const updateTint = useCallback(() => {
    const m = maskRef.current, c = tintRef.current;
    if (c.width !== m.width || c.height !== m.height) { c.width = m.width; c.height = m.height; }
    const g = c.getContext('2d')!;
    g.globalCompositeOperation = 'copy';
    g.fillStyle = view.color; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(m, 0, 0);
    g.globalCompositeOperation = 'source-over';
  }, [view.color]);

  const fit = useCallback(() => {
    const el = viewRef.current;
    // Größe direkt vom geladenen Bild (der Zustand kann beim ersten Laden noch veraltet sein)
    const iw = imgRef.current.width, ih = imgRef.current.height;
    if (!el || !iw || !ih || !el.clientWidth) return;
    const cw = el.clientWidth, ch = el.clientHeight;
    const s = Math.min(cw / iw, ch / ih) * 0.96;
    tf.current = { s, ox: (cw - iw * s) / 2, oy: (ch - ih * s) / 2 };
    redraw();
  }, [redraw]);

  const loadAt = useCallback(async (lt: number) => {
    if (!clip || !media) return;
    setLoading(true);
    try {
      const src = sourceTimeAt(clip, clip.start + lt);
      const f = await window.panocut.maskEditFrame(media, src);
      loadedT.current = lt;
      const img = imgRef.current;
      img.width = f.width; img.height = f.height;
      const id = new ImageData(new Uint8ClampedArray(f.data), f.width, f.height);
      img.getContext('2d')!.putImageData(id, 0, 0);
      const m = maskRef.current;
      const first = m.width !== f.width || m.height !== f.height;
      m.width = f.width; m.height = f.height;
      setSpace(f.space);
      // Maske dieser Stelle: bearbeitete Stelle, sonst nächste verfolgte Maske
      const tr = useProject.getState().project.clips[clipId]?.objects?.find((o) => o.id === tid.current);
      const cand = [...(tr?.keys ?? []), ...(tr?.masks ?? [])].filter((k) => Math.abs(k.t - lt) <= Math.max(half * 2.2, 0.05)).sort((a, b) => Math.abs(a.t - lt) - Math.abs(b.t - lt))[0];
      if (cand) putMask(m, await window.panocut.maskRead(cand.path, f.width, f.height));
      else m.getContext('2d')!.clearRect(0, 0, m.width, m.height);
      undo.current = []; redo.current = [];
      dirty.current = false;
      aiBase.current = null;
      setAi((a) => ({ ...a, points: [], box: undefined }));
      setPoly(null);
      setSize({ w: f.width, h: f.height });
      updateTint();
      if (first) requestAnimationFrame(() => fit());
      redraw();
    } catch (e) {
      toast(`${t.maskEd.loadFailed}: ${(e as Error).message}`, 'error');
    } finally { setLoading(false); }
  }, [clip, media, clipId, trackId, half, updateTint, fit, redraw, toast]);

  useEffect(() => { void loadAt(local); /* nur beim Öffnen */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTint(); redraw(); }, [view.color, updateTint, redraw]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = viewRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
      if (!userView.current) fit(); else redraw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [redraw, fit]);

  // ---------- Speichern ----------
  const ensureTrack = useCallback((): ObjectTrack => {
    const st = useProject.getState();
    const c = st.project.clips[clipId];
    const existing = c?.objects?.find((o) => o.id === tid.current);
    if (existing) return existing;
    const n = (c?.objects ?? []).filter((o) => o.label === 'manual').length + 1;
    const tr: ObjectTrack = { id: makeId('trk'), label: 'manual', labelDe: `${t.maskEd.trackName} ${n}`, color: '#ff2d95', boxes: [], masks: [], keys: [], space, maskSize: { w: W, h: H } };
    st.addObjectTrack(clipId, tr);
    tid.current = tr.id;
    setTrackId(tr.id);
    return tr;
  }, [clipId, trackId, space, W, H]);

  /** Aktuelle Stelle als bearbeitete Stelle speichern (falls geändert). */
  const saveHere = useCallback(async (force = false): Promise<ObjectTrack | null> => {
    if (!media || !W || (!dirty.current && !force)) return null;
    const tr = ensureTrack();
    const bytes = maskBytes(maskRef.current);
    const at = loadedT.current;
    const file = await window.panocut.aiSaveMask(media.path, tr.id, `key_${Math.round(at * 1000)}_${Date.now().toString(36)}`, await maskPng(maskRef.current));
    const cur = useProject.getState().project.clips[clipId]?.objects?.find((o) => o.id === tr.id) ?? tr;
    const near = (k: { t: number }) => Math.abs(k.t - at) <= half * 1.01;
    for (const k of [...(cur.keys ?? []), ...(cur.masks ?? [])]) if (near(k)) forgetMask(k.path);
    const keys = [...(cur.keys ?? []).filter((k) => !near(k)), { t: at, path: file }].sort((a, b) => a.t - b.t);
    const masks = [...(cur.masks ?? []).filter((k) => !near(k)), { t: at, path: file }].sort((a, b) => a.t - b.t);
    const b = boxOf(bytes, W, H);
    const boxes = [...cur.boxes.filter((k) => !near(k)), ...(b ? [{ t: at, ...b }] : [])].sort((a, c) => a.t - c.t);
    useProject.getState().updateObjectTrack(clipId, tr.id, { keys, masks, boxes, space, maskSize: { w: W, h: H } });
    dirty.current = false;
    setDirty(true);
    return { ...cur, keys, masks, boxes };
  }, [media, W, H, ensureTrack, clipId, half, space]);

  const goTo = async (lt: number) => {
    const v = Math.max(0, Math.min(dur, lt));
    await saveHere();
    setLocal(v);
    await loadAt(v);
  };

  // ---------- Bearbeiten ----------
  const snapshot = () => { undo.current.push(maskBytes(maskRef.current)); if (undo.current.length > 40) undo.current.shift(); redo.current = []; dirty.current = true; };
  const doUndo = () => { const u = undo.current.pop(); if (!u) return; redo.current.push(maskBytes(maskRef.current)); putMask(maskRef.current, u); dirty.current = true; updateTint(); redraw(); };
  const doRedo = () => { const r = redo.current.pop(); if (!r) return; undo.current.push(maskBytes(maskRef.current)); putMask(maskRef.current, r); dirty.current = true; updateTint(); redraw(); };
  const fillAll = (on: boolean) => { snapshot(); const g = maskRef.current.getContext('2d')!; g.clearRect(0, 0, W, H); if (on) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); } updateTint(); redraw(); };
  const invert = () => { snapshot(); const b = maskBytes(maskRef.current); for (let i = 0; i < b.length; i++) b[i] = 255 - b[i]; putMask(maskRef.current, b); updateTint(); redraw(); };

  const dab = (x: number, y: number, erase: boolean) => {
    const g = maskRef.current.getContext('2d')!;
    const r = brush.size / 2;
    const draw = (cx: number) => {
      const grad = g.createRadialGradient(cx, y, Math.max(0, r * brush.hardness - 0.5), cx, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(cx, y, r, 0, Math.PI * 2); g.fill();
    };
    g.save();
    g.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    draw(x);
    if (wrap) { if (x - r < 0) draw(x + W); if (x + r > W) draw(x - W); }
    g.restore();
  };

  const fillPoly = (p: Poly) => {
    if (p.pts.length < 3) return;
    snapshot();
    const g = maskRef.current.getContext('2d')!;
    g.save();
    g.globalCompositeOperation = p.sub ? 'destination-out' : 'source-over';
    g.fillStyle = '#fff';
    const path = (dx: number) => { g.beginPath(); p.pts.forEach(([x, y], i) => (i ? g.lineTo(x + dx, y) : g.moveTo(x + dx, y))); g.closePath(); g.fill(); };
    path(0);
    if (wrap) { path(W); path(-W); }
    g.restore();
    updateTint(); redraw();
  };
  const commitPoly = () => { if (poly && poly.pts.length >= 3) fillPoly(poly); setPoly(null); setSelV(null); };

  // KI
  const runAi = useCallback(async (next: typeof ai) => {
    if (!media || !clip || (next.points.length === 0 && !next.box)) return;
    setAiBusy(true);
    try {
      if (!aiBase.current) aiBase.current = maskBytes(maskRef.current);
      const src = sourceTimeAt(clip, clip.start + loadedT.current);
      const res = await window.panocut.maskSegment(media, src, { points: next.points, box: next.box });
      const base = aiBase.current;
      const out = new Uint8Array(res.length);
      for (let i = 0; i < out.length; i++) out[i] = next.mode === 'replace' ? res[i] : next.mode === 'add' ? Math.max(base[i], res[i]) : Math.min(base[i], 255 - res[i]);
      undo.current.push(maskBytes(maskRef.current)); redo.current = [];
      putMask(maskRef.current, out);
      dirty.current = true;
      updateTint(); redraw();
    } catch (e) {
      toast(`${t.maskEd.aiFailed}: ${(e as Error).message}`, 'error');
    } finally { setAiBusy(false); }
  }, [media, clip, updateTint, redraw, toast]);
  const newAiSelection = () => { aiBase.current = null; setAi((a) => ({ ...a, points: [], box: undefined })); };

  // ---------- Verfolgen ----------
  useEffect(() => window.panocut.onMaskTrackProgress((p) => setTracking(p.percent)), []);
  const track_ = async (dir: 1 | -1) => {
    if (!media || !clip) return;
    const tr = (await saveHere(true)) ?? ensureTrack();
    const bytes = maskBytes(maskRef.current);
    if (!boxOf(bytes, W, H)) { toast(t.maskEd.emptyMask, 'error'); return; }
    // bis zur nächsten selbst bearbeiteten Stelle bzw. bis „bis“ / Clip-Ende
    const keys = (useProject.getState().project.clips[clipId]?.objects?.find((o) => o.id === tr.id)?.keys ?? []).map((k) => k.t);
    const local = loadedT.current;
    let endLocal = dir > 0 ? dur : 0;
    if (until !== null) endLocal = dir > 0 ? Math.min(dur, Math.max(local, until)) : Math.max(0, Math.min(local, until));
    const nextKey = dir > 0 ? keys.filter((k) => k > local + half * 1.5).sort((a, b) => a - b)[0] : keys.filter((k) => k < local - half * 1.5).sort((a, b) => b - a)[0];
    if (nextKey !== undefined && (dir > 0 ? nextKey < endLocal : nextKey > endLocal)) endLocal = nextKey - dir / fps;
    if (Math.abs(endLocal - local) < 1 / fps) { toast(t.maskEd.nothingToTrack, 'info'); return; }
    const srcStart = sourceTimeAt(clip, clip.start + local), srcEnd = sourceTimeAt(clip, clip.start + endLocal);
    const trackFps = Math.max(5, Math.min(30, (everyFrame ? fps : fps / 2) * clip.speed));
    setTracking(0);
    try {
      const res = await window.panocut.maskTrack({ media, trackId: tr.id, start: srcStart, end: srcEnd, fps: trackFps, mask: bytes, mode: trackMode });
      const items = res.map((r) => ({ t: localFromSource(clip, r.t), path: r.path, box: r.box })).filter((r) => r.t >= -1e-3 && r.t <= dur + 1e-3);
      if (!items.length) return;
      const lo = Math.min(...items.map((r) => r.t)), hi = Math.max(...items.map((r) => r.t));
      const cur = useProject.getState().project.clips[clipId]?.objects?.find((o) => o.id === tr.id) ?? tr;
      const inside = (x: number) => x > lo - 1e-4 && x < hi + 1e-4;
      const masks = [...(cur.masks ?? []).filter((m) => !inside(m.t) || (cur.keys ?? []).some((k) => Math.abs(k.t - m.t) < 1e-4)), ...items.map((r) => ({ t: r.t, path: r.path }))].sort((a, b) => a.t - b.t);
      const boxes = [...cur.boxes.filter((b) => !inside(b.t)), ...items.filter((r) => r.box).map((r) => ({ t: r.t, ...r.box! }))].sort((a, b) => a.t - b.t);
      useProject.getState().updateObjectTrack(clipId, tr.id, { masks, boxes });
      setDirty(true);
      toast(fmt(t.maskEd.tracked, { n: items.length, s: (hi - lo).toFixed(1) }), 'success');
    } catch (e) {
      if ((e as Error).message !== 'Abgebrochen' && !/Abgebrochen/.test((e as Error).message)) toast(`${t.maskEd.trackFailed}: ${(e as Error).message}`, 'error');
    } finally { setTracking(null); }
  };

  // ---------- Fertig ----------
  const finish = async () => {
    await saveHere();
    const cur = useProject.getState().project.clips[clipId];
    const tr = cur?.objects?.find((o) => o.id === tid.current);
    if (cur && tr && tr.masks?.length) {
      // außerhalb des verfolgten Bereichs: keine Maske (leeres Bild), damit nichts „stehen bleibt“
      const masks = [...tr.masks].sort((a, b) => a.t - b.t);
      const step = 1 / fps;
      const blank = async () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return window.panocut.aiSaveMask(media!.path, tr.id, 'empty', await maskPng(c)); };
      let changed = false;
      if (masks[0].t > step * 1.5) { masks.unshift({ t: Math.max(0, masks[0].t - step), path: await blank() }); changed = true; }
      if (masks[masks.length - 1].t < dur - step * 1.5) { masks.push({ t: Math.min(dur, masks[masks.length - 1].t + step), path: await blank() }); changed = true; }
      beginTransaction();
      if (changed) useProject.getState().updateObjectTrack(clipId, tr.id, { masks });
      const feather = cur.cutout?.trackId === tr.id ? cur.cutout.feather : 2;
      const grow = cur.cutout?.trackId === tr.id ? cur.cutout.grow : 0;
      if (use === 'cutout' || use === 'remove') useProject.getState().setCutout(clipId, { enabled: true, trackId: tr.id, feather, grow, invert: use === 'remove' });
      else if (cur.cutout?.trackId === tr.id) useProject.getState().setCutout(clipId, { ...cur.cutout, enabled: false });
      endTransaction();
      if (use === 'front') bringObjectToFront(clipId, tr.id);
      setDirty(true);
    }
    close();
  };

  // ---------- Zeichnen ----------
  useEffect(() => {
    const c = viewRef.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#16181d'; g.fillRect(0, 0, c.width, c.height);
    if (!W) return;
    const { s, ox, oy } = tf.current;
    g.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    g.imageSmoothingEnabled = s < 2;
    const copies = wrap ? [-W, 0, W] : [0];
    for (const dx of copies) {
      if (view.mode === 'mask') { g.fillStyle = '#000'; g.fillRect(dx, 0, W, H); g.drawImage(maskRef.current, dx, 0); }
      else if (view.mode === 'cut') {
        g.fillStyle = '#2a2d35'; g.fillRect(dx, 0, W, H);
        const cc = cutRef.current;
        if (cc.width !== W || cc.height !== H) { cc.width = W; cc.height = H; }
        const cg = cc.getContext('2d')!;
        cg.globalCompositeOperation = 'copy'; cg.drawImage(maskRef.current, 0, 0);
        cg.globalCompositeOperation = 'source-in'; cg.drawImage(imgRef.current, 0, 0);
        cg.globalCompositeOperation = 'source-over';
        g.drawImage(cc, dx, 0);
      } else {
        g.drawImage(imgRef.current, dx, 0);
        g.globalAlpha = view.opacity; g.drawImage(tintRef.current, dx, 0); g.globalAlpha = 1;
      }
    }
    if (wrap) { g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1 / s; g.strokeRect(0, 0, W, H); }
    // Punkte-Werkzeug / Lasso
    const px = 1 / s;
    if (poly) {
      g.strokeStyle = poly.sub ? '#f87171' : '#fde047'; g.lineWidth = 1.5 * px;
      g.beginPath(); poly.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (poly.closed) g.closePath(); g.stroke();
      poly.pts.forEach(([x, y], i) => { g.fillStyle = i === selV ? '#fff' : i === 0 ? '#22c55e' : '#fde047'; g.fillRect(x - 3.5 * px, y - 3.5 * px, 7 * px, 7 * px); });
    }
    // KI-Hinweise
    for (const p of ai.points) { g.fillStyle = p.label ? '#22c55e' : '#ef4444'; g.beginPath(); g.arc(p.x, p.y, 5 * px, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5 * px; g.stroke(); }
    if (ai.box) { g.strokeStyle = '#22d3ee'; g.lineWidth = 2 * px; g.setLineDash([6 * px, 4 * px]); g.strokeRect(ai.box.x0, ai.box.y0, ai.box.x1 - ai.box.x0, ai.box.y1 - ai.box.y0); g.setLineDash([]); }
    // Pinsel-Kreis
    const m = mouse.current;
    if (m && (tool === 'brush' || tool === 'erase')) {
      g.strokeStyle = tool === 'erase' ? '#f87171' : '#fff'; g.lineWidth = 1 * px;
      g.beginPath(); g.arc(m.x, m.y, brush.size / 2, 0, Math.PI * 2); g.stroke();
      if (brush.hardness < 0.95) { g.globalAlpha = 0.5; g.beginPath(); g.arc(m.x, m.y, (brush.size / 2) * brush.hardness, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
    }
  }, [tick, W, H, view, poly, selV, ai, tool, brush, wrap]);

  // ---------- Maus ----------
  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = viewRef.current!.getBoundingClientRect();
    const { s, ox, oy } = tf.current;
    return { x: (e.clientX - r.left - ox) / s, y: (e.clientY - r.top - oy) / s };
  };
  const wrapX = (x: number) => (wrap ? ((x % W) + W) % W : x);

  const onWheel = (e: React.WheelEvent) => {
    const r = viewRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const { s, ox, oy } = tf.current;
    if (e.altKey && (tool === 'brush' || tool === 'erase')) { setBrush((b) => ({ ...b, size: Math.max(1, Math.min(400, b.size * Math.exp(-e.deltaY * 0.002))) })); return; }
    userView.current = true;
    const ns = Math.max(0.05, Math.min(40, s * Math.exp(-e.deltaY * 0.0015)));
    tf.current = { s: ns, ox: mx - ((mx - ox) / s) * ns, oy: my - ((my - oy) / s) * ns };
    redraw();
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!W || loading) return;
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* z. B. künstliche Ereignisse im Test */ }
    const p0 = toImage(e);
    const pan = tool === 'hand' || e.button === 1 || e.button === 2 || spaceDown.current;
    if (pan) {
      userView.current = true;
      const start = { x: e.clientX, y: e.clientY, ox: tf.current.ox, oy: tf.current.oy };
      const move = (ev: PointerEvent) => { tf.current = { ...tf.current, ox: start.ox + ev.clientX - start.x, oy: start.oy + ev.clientY - start.y }; redraw(); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
      return;
    }
    if (tool === 'brush' || tool === 'erase') {
      snapshot();
      const erase = tool === 'erase' ? !e.altKey : e.altKey;
      let last = p0;
      dab(wrapX(p0.x), p0.y, erase);
      updateTint(); redraw();
      const move = (ev: PointerEvent) => {
        const p = toImage(ev);
        const d = Math.hypot(p.x - last.x, p.y - last.y);
        const stepLen = Math.max(0.5, brush.size * 0.12);
        for (let k = 1; k <= Math.floor(d / stepLen); k++) { const u = (k * stepLen) / d; dab(wrapX(last.x + (p.x - last.x) * u), last.y + (p.y - last.y) * u, erase); }
        if (d >= stepLen) last = p;
        mouse.current = p;
        updateTint(); redraw();
      };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
      return;
    }
    if (tool === 'lasso' && !poly) {
      const pts: Array<[number, number]> = [[p0.x, p0.y]];
      setPoly({ pts, closed: false, sub: e.altKey });
      const move = (ev: PointerEvent) => { const p = toImage(ev); pts.push([p.x, p.y]); setPoly({ pts: [...pts], closed: false, sub: e.altKey }); };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        if (pts.length < 3) { setPoly(null); return; }
        // Lasso wird zu verschiebbaren Punkten (nachjustierbar, dann „Übernehmen“)
        setPoly({ pts: simplify(pts, 1.2 / tf.current.s), closed: true, sub: e.altKey });
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
      return;
    }
    if (tool === 'poly' || (tool === 'lasso' && poly)) {
      const hit = 8 / tf.current.s;
      const cur = poly ?? { pts: [], closed: false, sub: e.altKey };
      const vi = cur.pts.findIndex(([x, y]) => Math.hypot(x - p0.x, y - p0.y) < hit);
      let dragIdx: number | null = null;
      let next = cur;
      if (vi === 0 && !cur.closed && cur.pts.length >= 3) { next = { ...cur, closed: true }; setPoly(next); setSelV(null); return; }
      if (vi >= 0) dragIdx = vi;
      else {
        // auf einer Kante → Punkt einfügen
        let ei = -1, best = hit * 0.8;
        const n = cur.pts.length;
        for (let i = 0; i < (cur.closed ? n : n - 1); i++) {
          const [ax, ay] = cur.pts[i], [bx, by] = cur.pts[(i + 1) % n];
          const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
          const u = Math.max(0, Math.min(1, ((p0.x - ax) * (bx - ax) + (p0.y - ay) * (by - ay)) / L2));
          const d = Math.hypot(ax + u * (bx - ax) - p0.x, ay + u * (by - ay) - p0.y);
          if (d < best) { best = d; ei = i; }
        }
        if (ei >= 0) { const pts = [...cur.pts]; pts.splice(ei + 1, 0, [p0.x, p0.y]); next = { ...cur, pts }; dragIdx = ei + 1; }
        else if (!cur.closed) { next = { ...cur, pts: [...cur.pts, [p0.x, p0.y]] }; dragIdx = next.pts.length - 1; }
        else return;
        setPoly(next);
      }
      setSelV(dragIdx);
      const base = next;
      const move = (ev: PointerEvent) => {
        if (dragIdx === null) return;
        const p = toImage(ev);
        const pts = [...base.pts]; pts[dragIdx] = [p.x, p.y];
        setPoly({ ...base, pts });
      };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
      return;
    }
    if (tool === 'ai') {
      let dragged = false;
      const move = (ev: PointerEvent) => {
        const p = toImage(ev);
        if (Math.hypot(p.x - p0.x, p.y - p0.y) * tf.current.s > 6) dragged = true;
        if (dragged) setAi((a) => ({ ...a, box: { x0: Math.min(p0.x, p.x), y0: Math.min(p0.y, p.y), x1: Math.max(p0.x, p.x), y1: Math.max(p0.y, p.y) } }));
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        const p = toImage(ev);
        setAi((a) => {
          const next = dragged
            ? { ...a, box: { x0: Math.min(p0.x, p.x), y0: Math.max(0, Math.min(p0.y, p.y)), x1: Math.max(p0.x, p.x), y1: Math.min(H - 1, Math.max(p0.y, p.y)) } }
            : { ...a, points: [...a.points, { x: wrapX(p0.x), y: p0.y, label: (e.altKey ? 0 : 1) as 0 | 1 }] };
          void runAi(next);
          return next;
        });
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    }
  };
  const onMove = (e: React.PointerEvent) => { mouse.current = toImage(e); if (tool === 'brush' || tool === 'erase') redraw(); };

  // ---------- Tasten ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (e.key === ' ') { spaceDown.current = true; e.preventDefault(); return; }
      if (mod) return;
      switch (e.key) {
        case 'b': case 'B': setTool('brush'); break;
        case 'e': case 'E': setTool('erase'); break;
        case 'l': case 'L': setTool('lasso'); break;
        case 'p': case 'P': setTool('poly'); break;
        case 'a': case 'A': setTool('ai'); break;
        case 'h': case 'H': setTool('hand'); break;
        case '[': setBrush((b) => ({ ...b, size: Math.max(1, b.size / 1.25) })); break;
        case ']': setBrush((b) => ({ ...b, size: Math.min(400, b.size * 1.25) })); break;
        case 'Enter': commitPoly(); break;
        case 'Escape': if (poly) { setPoly(null); setSelV(null); } else void finish(); break;
        case 'Backspace': case 'Delete':
          if (poly && selV !== null) { const pts = poly.pts.filter((_, i) => i !== selV); setPoly(pts.length ? { ...poly, pts } : null); setSelV(null); }
          break;
        case 'ArrowLeft': void goTo(local - 1 / fps); break;
        case 'ArrowRight': void goTo(local + 1 / fps); break;
        case 'f': case 'F': userView.current = false; fit(); break;
        default: return;
      }
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => { if (e.key === ' ') spaceDown.current = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  });
  useEffect(() => {
    const onUndo = (e: Event) => { e.preventDefault(); doUndo(); };
    window.addEventListener('pc-mask-undo', onUndo);
    return () => window.removeEventListener('pc-mask-undo', onUndo);
  });

  if (!clip || !media) return null;
  const keys = track?.keys ?? [];
  const masks = track?.masks ?? [];
  const covered = masks.length > 1 ? [masks[0].t, masks[masks.length - 1].t] : null;
  const cut = clip.cutout?.trackId === track?.id ? clip.cutout : undefined;
  const toolBtn = (id: Tool, icon: string, label: string, key: string) => (
    <button className={`btn sm${tool === id ? ' active' : ''}`} title={`${label} (${key})`} onClick={() => { if (poly && id !== 'poly' && id !== 'lasso') commitPoly(); setTool(id); }}>{icon} {label}</button>
  );

  return (
    <div className="mask-editor" data-tool={tool} data-dirty={dirty.current ? '1' : '0'}>
      <div className="me-top">
        <strong>✏️ {t.maskEd.title}</strong>
        <span className="me-sub">{clip.name}{wrap ? ` · ${t.maskEd.pano}` : ''}</span>
        <div className="spacer" />
        {toolBtn('ai', '🤖', t.maskEd.toolAi, 'A')}
        {toolBtn('brush', '🖌', t.maskEd.toolBrush, 'B')}
        {toolBtn('erase', '🩹', t.maskEd.toolErase, 'E')}
        {toolBtn('lasso', '➰', t.maskEd.toolLasso, 'L')}
        {toolBtn('poly', '📍', t.maskEd.toolPoly, 'P')}
        {toolBtn('hand', '✋', t.maskEd.toolHand, 'H / Leertaste')}
        <div className="spacer" />
        <button className="btn sm" title="⌘Z" onClick={doUndo}>↶</button>
        <button className="btn sm" title="⇧⌘Z" onClick={doRedo}>↷</button>
        <button className="btn sm" onClick={() => { userView.current = false; fit(); }} title="F">⤢ {t.maskEd.fit}</button>
        <button className="btn sm primary" onClick={() => void finish()}>✓ {t.maskEd.done}</button>
        <button className="btn icon ghost sm" onClick={() => void finish()}><IconClose /></button>
      </div>
      <div className="me-body">
        <div className="me-stage" ref={wrapRef} onContextMenu={(e) => e.preventDefault()}>
          <canvas ref={viewRef} onPointerDown={onDown} onPointerMove={onMove} onPointerLeave={() => { mouse.current = null; redraw(); }} onWheel={onWheel}
            className={`tool-${tool}`} />
          {loading && <div className="me-loading">{t.maskEd.loading}</div>}
          {(aiBusy || tracking !== null) && <div className="me-loading">{tracking !== null ? fmt(t.maskEd.trackingPct, { p: Math.round(tracking) }) : t.maskEd.aiWorking}</div>}
        </div>
        <div className="me-side">
          {(tool === 'brush' || tool === 'erase') && (
            <div className="me-group">
              <div className="me-title">{tool === 'brush' ? '🖌 ' + t.maskEd.toolBrush : '🩹 ' + t.maskEd.toolErase}</div>
              <label>{t.maskEd.size}: {Math.round(brush.size)} px</label>
              <input type="range" min={1} max={300} step={1} value={brush.size} onChange={(e) => setBrush({ ...brush, size: Number(e.target.value) })} />
              <label>{t.maskEd.hardness}: {Math.round(brush.hardness * 100)} %</label>
              <input type="range" min={0} max={1} step={0.05} value={brush.hardness} onChange={(e) => setBrush({ ...brush, hardness: Number(e.target.value) })} />
              <div className="hint">{t.maskEd.brushHint}</div>
            </div>
          )}
          {(tool === 'lasso' || tool === 'poly') && (
            <div className="me-group">
              <div className="me-title">{tool === 'lasso' ? '➰ ' + t.maskEd.toolLasso : '📍 ' + t.maskEd.toolPoly}</div>
              <div className="hint">{tool === 'lasso' ? t.maskEd.lassoHint : t.maskEd.polyHint}</div>
              {poly && (
                <div className="field-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  <button className="btn sm primary" disabled={poly.pts.length < 3} onClick={commitPoly}>✓ {poly.sub ? t.maskEd.subtract : t.maskEd.add} (Enter)</button>
                  <button className="btn sm" onClick={() => setPoly({ ...poly, sub: !poly.sub })}>{poly.sub ? '➕' : '➖'} {poly.sub ? t.maskEd.makeAdd : t.maskEd.makeSub}</button>
                  <button className="btn sm ghost" onClick={() => { setPoly(null); setSelV(null); }}>{t.common.cancel}</button>
                </div>
              )}
              {poly && <div className="hint">{fmt(t.maskEd.points, { n: poly.pts.length })}</div>}
            </div>
          )}
          {tool === 'ai' && (
            <div className="me-group">
              <div className="me-title">🤖 {t.maskEd.toolAi}</div>
              <div className="hint">{t.maskEd.aiHint}</div>
              <select value={ai.mode} onChange={(e) => { aiBase.current = null; setAi({ ...ai, mode: e.target.value as typeof ai.mode }); }}>
                <option value="replace">{t.maskEd.aiReplace}</option>
                <option value="add">{t.maskEd.aiAdd}</option>
                <option value="sub">{t.maskEd.aiSub}</option>
              </select>
              <button className="btn sm" onClick={newAiSelection}>✨ {t.maskEd.aiNew}</button>
            </div>
          )}
          <div className="me-group">
            <div className="me-title">🧽 {t.maskEd.whole}</div>
            <div className="field-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => fillAll(true)}>{t.maskEd.fillAll}</button>
              <button className="btn sm" onClick={() => fillAll(false)}>{t.maskEd.clearAll}</button>
              <button className="btn sm" onClick={invert}>{t.maskEd.invert}</button>
            </div>
          </div>
          <div className="me-group">
            <div className="me-title">👁 {t.maskEd.viewTitle}</div>
            <select value={view.mode} onChange={(e) => setView({ ...view, mode: e.target.value as ViewMode })}>
              <option value="overlay">{t.maskEd.viewOverlay}</option>
              <option value="mask">{t.maskEd.viewMask}</option>
              <option value="cut">{t.maskEd.viewCut}</option>
            </select>
            {view.mode === 'overlay' && (
              <>
                <div className="field-row" style={{ gap: 4 }}>
                  {COLORS.map((c) => <button key={c.id} className={`me-swatch${view.color === c.css ? ' active' : ''}`} style={{ background: c.css }} onClick={() => setView({ ...view, color: c.css })} />)}
                </div>
                <label>{t.maskEd.opacity}: {Math.round(view.opacity * 100)} %</label>
                <input type="range" min={0.1} max={0.9} step={0.05} value={view.opacity} onChange={(e) => setView({ ...view, opacity: Number(e.target.value) })} />
              </>
            )}
          </div>
          <div className="me-group">
            <div className="me-title">🎯 {t.maskEd.trackTitle}</div>
            <div className="hint">{t.maskEd.trackHint}</div>
            <select value={trackMode} onChange={(e) => setTrackMode(e.target.value as 'ai' | 'fast')}>
              <option value="ai">{t.maskEd.trackAi}</option>
              <option value="fast">{t.maskEd.trackFast}</option>
            </select>
            <label className="toggle"><input type="checkbox" checked={everyFrame} onChange={(e) => setEveryFrame(e.target.checked)} /> {t.maskEd.everyFrame}</label>
            <label className="toggle"><input type="checkbox" checked={until !== null} onChange={(e) => setUntil(e.target.checked ? Math.min(dur, local + 3) : null)} /> {t.maskEd.untilOn}</label>
            {until !== null && (
              <div className="field-row" style={{ gap: 4 }}>
                <input type="number" min={0} max={dur} step={0.1} value={Number(until.toFixed(2))} onChange={(e) => setUntil(Math.max(0, Math.min(dur, Number(e.target.value))))} style={{ width: 80 }} />
                <span>s</span>
                <button className="btn sm ghost" onClick={() => setUntil(local)}>{t.maskEd.untilHere}</button>
              </div>
            )}
            {tracking === null ? (
              <div className="field-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => void track_(-1)}>◀ {t.maskEd.trackBack}</button>
                <button className="btn sm primary" onClick={() => void track_(1)}>{t.maskEd.trackFwd} ▶</button>
              </div>
            ) : (
              <button className="btn sm" onClick={() => void window.panocut.maskTrackCancel()}>{t.common.cancel}</button>
            )}
          </div>
          {cut && (
            <div className="me-group">
              <div className="me-title">🪶 {t.maskEd.edgeTitle}</div>
              <label>{t.maskEd.feather}: {cut.feather}</label>
              <input type="range" min={0} max={40} step={1} value={cut.feather} onChange={(e) => useProject.getState().setCutout(clipId, { ...cut, feather: Number(e.target.value) })} />
              <label>{t.maskEd.grow}: {cut.grow}</label>
              <input type="range" min={-20} max={20} step={1} value={cut.grow} onChange={(e) => useProject.getState().setCutout(clipId, { ...cut, grow: Number(e.target.value) })} />
            </div>
          )}
          <div className="me-group">
            <div className="me-title">✅ {t.maskEd.useTitle}</div>
            <select value={use} onChange={(e) => setUse(e.target.value as typeof use)}>
              <option value="cutout">{t.maskEd.useCutout}</option>
              <option value="remove">{t.maskEd.useRemove}</option>
              <option value="front">{t.maskEd.useFront}</option>
              <option value="none">{t.maskEd.useNone}</option>
            </select>
          </div>
        </div>
      </div>
      <div className="me-time">
        <button className="btn sm" onClick={() => void goTo(local - 1 / fps)} title="←">⏮</button>
        <span className="me-tc">{local.toFixed(2)} s</span>
        <button className="btn sm" onClick={() => void goTo(local + 1 / fps)} title="→">⏭</button>
        <div className="me-bar">
          {covered && <div className="me-covered" style={{ left: `${(covered[0] / Math.max(1e-6, dur)) * 100}%`, width: `${((covered[1] - covered[0]) / Math.max(1e-6, dur)) * 100}%` }} />}
          {keys.map((k) => <div key={k.t} className="me-key" style={{ left: `${(k.t / Math.max(1e-6, dur)) * 100}%` }} title={`${k.t.toFixed(2)} s`} onClick={() => void goTo(k.t)} />)}
          <input type="range" min={0} max={dur} step={1 / fps} value={local} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={(e) => void goTo(Number((e.target as HTMLInputElement).value))} onKeyUp={(e) => void goTo(Number((e.target as HTMLInputElement).value))} />
        </div>
        <span className="me-tc dim">{dur.toFixed(2)} s</span>
        <span className="hint">{t.maskEd.timeHint}</span>
      </div>
    </div>
  );
}

