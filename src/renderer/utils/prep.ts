import type { MediaItem } from '@shared/types';
import { fmt, t } from '../i18n/de';

/** Restzeit lesbar: „12 s“, „1:20 min“, „1 h 5 min“. */
export function formatEta(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m}:${String(s).padStart(2, '0')} min`; }
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}

/** Kurzer Text zum Vorbereitungsstand einer Datei (oder null, wenn fertig). */
export function prepLabel(item: MediaItem): { text: string; percent: number; eta?: string } | null {
  if (item.status !== 'processing' && item.status !== 'analyzing') return null;
  const p = item.prep;
  if (!p) return { text: item.thumb ? t.library.prepWaiting : t.library.prepThumbs, percent: 0 };
  const text = p.stage === 'waiting' ? t.library.prepWaiting
    : p.stage === 'proxy' ? fmt(t.library.prepProxy, { p: p.percent })
    : p.stage === 'stitch' ? fmt(t.library.prepStitch, { p: p.percent })
    : p.stage === 'wave' ? t.library.prepWave : t.library.prepThumbs;
  return { text, percent: p.percent, eta: p.etaSec !== undefined ? fmt(t.library.eta, { t: formatEta(p.etaSec) }) : undefined };
}
