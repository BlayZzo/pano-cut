// Untertitel für Social Media: Wort-Zeiten, Zeilenumbruch, „Wort für Wort“-Hervorhebung.
// Dieselbe Rechnung für Vorschau (Canvas) und Export (ASS) – so sehen beide gleich aus.
import type { Clip, SubtitleSegment, SubWord, TitleStyle } from './types';

type Subs = NonNullable<Clip['subtitles']>;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Wörter eines Segments mit Zeiten: gespeicherte Zeiten, wenn sie zum (evtl. bearbeiteten) Text passen, sonst geschätzt. */
export function segmentWords(seg: SubtitleSegment, text = seg.text): SubWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const w = seg.words;
  if (w && w.length === parts.length && w.every((x, i) => norm(x.text) === norm(parts[i]))) return w.map((x, i) => ({ ...x, text: parts[i] }));
  // Schätzung: Dauer nach Länge der Wörter verteilen
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const dur = Math.max(0.05, seg.end - seg.start);
  let t = seg.start;
  return parts.map((p) => {
    const d = (dur * (p.length + 1)) / total;
    const out = { start: t, end: t + d, text: p };
    t += d;
    return out;
  });
}

/** Wörter (aus der Spracherkennung) zu gut lesbaren Untertitel-Zeilen bündeln. */
export function groupWords(words: SubWord[], maxChars: number, makeId: () => string): SubtitleSegment[] {
  const out: SubtitleSegment[] = [];
  let cur: SubWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ id: makeId(), start: cur[0].start, end: Math.max(cur[cur.length - 1].end, cur[0].start + 0.3), text: cur.map((w) => w.text).join(' '), words: cur });
    cur = [];
  };
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const word = { ...w, text };
    if (cur.length) {
      const len = cur.reduce((s, x) => s + x.text.length + 1, 0) + text.length;
      const gap = word.start - cur[cur.length - 1].end;
      const prev = cur[cur.length - 1].text;
      // neue Zeile bei Satzende, längerer Pause oder wenn die Zeile zu lang würde
      if (len > maxChars || gap > 0.7 || (/[.!?…]$/.test(prev) && len > maxChars * 0.45)) flush();
    }
    cur.push(word);
  }
  flush();
  return out;
}

/** Wie viele Zeichen passen in eine Zeile (gleiche Schätzung in Vorschau und Export). */
export function charsPerLine(style: Omit<TitleStyle, 'text'>, W: number, H: number): number {
  const px = Math.max(4, (style.size / 100) * H);
  return Math.max(8, Math.floor((W * 0.9) / (px * (style.bold ? 0.6 : 0.55))));
}

/** Wörter auf Zeilen verteilen (höchstens 3 Zeilen, möglichst gleich lang). */
export function wrapWords(words: string[], perLine: number): string[][] {
  const total = words.reduce((s, w) => s + w.length + 1, 0) - 1;
  if (total <= perLine) return [words];
  const lines = Math.min(3, Math.ceil(total / perLine));
  const target = total / lines;
  const out: string[][] = [[]];
  let len = 0;
  for (const w of words) {
    const line = out[out.length - 1];
    if (line.length && len + 1 + w.length > Math.max(target, 1) * 1.15 && out.length < lines) { out.push([w]); len = w.length; continue; }
    line.push(w);
    len += (line.length > 1 ? 1 : 0) + w.length;
  }
  return out;
}

export interface SubtitleRun { text: string; active: boolean }
export interface SubtitleView { lines: SubtitleRun[][]; second?: string }

/** Was zu einer Clip-Zeit angezeigt wird (null = nichts). */
export function subtitleViewAt(subs: Subs, seg: SubtitleSegment, local: number, perLine: number): SubtitleView | null {
  const showTr = !!subs.showTranslation;
  const useTr = showTr && subs.translationOnly && !!seg.translation;
  let text = useTr ? seg.translation! : seg.text;
  if (!text.trim()) return null;
  if (subs.uppercase) text = text.toLocaleUpperCase('de-DE');
  // Hervorhebung nur für die gesprochene Sprache (bei reiner Übersetzung: geschätzte Zeiten)
  let words = useTr ? segmentWords({ ...seg, words: undefined }, text) : segmentWords(seg, text);
  let activeIdx = -1;
  for (let i = 0; i < words.length; i++) if (local >= words[i].start - 1e-6) activeIdx = i;
  const chunk = subs.chunk && subs.chunk > 0 ? subs.chunk : 0;
  let offset = 0;
  if (chunk) {
    const block = Math.max(0, Math.floor(Math.max(0, activeIdx) / chunk));
    offset = block * chunk;
    words = words.slice(offset, offset + chunk);
  }
  const strings = words.map((w) => w.text);
  const wrapped = wrapWords(strings, perLine);
  let k = 0;
  const lines = wrapped.map((ln) => ln.map((w) => ({ text: w, active: !!subs.highlight && k++ + offset === activeIdx })));
  const second = showTr && !subs.translationOnly && seg.translation ? (subs.uppercase ? seg.translation.toLocaleUpperCase('de-DE') : seg.translation) : undefined;
  return { lines, second };
}

/** Zeitpunkte, an denen sich die Anzeige eines Segments ändert (für den Export: ein Ereignis je Abschnitt). */
export function subtitleChangeTimes(subs: Subs, seg: SubtitleSegment): number[] {
  const pts = new Set<number>([seg.start]);
  if (subs.highlight || (subs.chunk ?? 0) > 0) {
    const useTr = !!subs.showTranslation && subs.translationOnly && !!seg.translation;
    const words = useTr ? segmentWords({ ...seg, words: undefined }, seg.translation!) : segmentWords(seg);
    for (const w of words) if (w.start > seg.start + 1e-3 && w.start < seg.end - 1e-3) pts.add(w.start);
  }
  return [...pts].sort((a, b) => a - b);
}

export interface SubtitlePreset { id: string; name: string; style: Partial<Omit<TitleStyle, 'text'>>; highlight: string; chunk: number; uppercase: boolean; maxChars: number }

export const SUBTITLE_PRESETS: SubtitlePreset[] = [
  { id: 'social', name: 'Social Media (groß, Wort leuchtet)', style: { font: 'sans-bold', size: 6.5, color: '#ffffff', bold: true, align: 'center', x: 50, y: 72, background: '', shadow: true, outline: true }, highlight: '#ffd400', chunk: 0, uppercase: false, maxChars: 30 },
  { id: 'words', name: 'Wort für Wort (wenige Wörter, sehr groß)', style: { font: 'sans-bold', size: 9, color: '#ffffff', bold: true, align: 'center', x: 50, y: 62, background: '', shadow: true, outline: true }, highlight: '#3dd6c1', chunk: 3, uppercase: true, maxChars: 30 },
  { id: 'box', name: 'Kasten (gut lesbar auf hellem Bild)', style: { font: 'sans-bold', size: 5.5, color: '#ffffff', bold: true, align: 'center', x: 50, y: 80, background: '#000000', backgroundOpacity: 0.6, shadow: false, outline: false }, highlight: '#ffd400', chunk: 0, uppercase: false, maxChars: 36 },
  { id: 'classic', name: 'Klassisch (unten, ohne Hervorhebung)', style: { font: 'sans-bold', size: 5, color: '#ffffff', bold: true, align: 'center', x: 50, y: 88, background: '#000000', backgroundOpacity: 0.5, shadow: true, outline: false }, highlight: '', chunk: 0, uppercase: false, maxChars: 42 },
];
