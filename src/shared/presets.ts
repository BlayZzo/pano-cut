import type { ExportCodec, ExportFormat, ExportQuality } from './types';

export type ExportPresetGroup = 'social' | 'video' | 'special';

export interface ExportPreset {
  id: string;
  name: string;
  description: string;
  group: ExportPresetGroup;
  width: number;
  height: number;
  fps: number;
  format: ExportFormat;
  codec: ExportCodec;
  quality: ExportQuality;
  loudness?: number;      // Ziel-Lautheit (LUFS), wie die Plattformen es mögen
  maxSeconds?: number;    // empfohlene Höchstlänge (nur Hinweis)
}

export const EXPORT_PRESET_GROUPS: Array<{ id: ExportPresetGroup; name: string }> = [
  { id: 'social', name: 'Social Media' },
  { id: 'video', name: 'Video' },
  { id: 'special', name: 'Spezial' },
];

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'tiktok', group: 'social', name: 'TikTok (9:16)', description: '1080×1920 · 30 fps · Lautheit angepasst', width: 1080, height: 1920, fps: 30, format: 'mp4', codec: 'h264', quality: 'high', loudness: -14, maxSeconds: 600 },
  { id: 'reels', group: 'social', name: 'Instagram Reels (9:16)', description: '1080×1920 · 30 fps · bis 3 Min. empfohlen', width: 1080, height: 1920, fps: 30, format: 'mp4', codec: 'h264', quality: 'high', loudness: -14, maxSeconds: 180 },
  { id: 'shorts', group: 'social', name: 'YouTube Shorts (9:16)', description: '1080×1920 · 60 fps · bis 3 Min.', width: 1080, height: 1920, fps: 60, format: 'mp4', codec: 'h264', quality: 'high', loudness: -14, maxSeconds: 180 },
  { id: 'social-feed', group: 'social', name: 'Instagram-Feed (4:5)', description: '1080×1350 – füllt im Feed am meisten', width: 1080, height: 1350, fps: 30, format: 'mp4', codec: 'h264', quality: 'high', loudness: -14 },
  { id: 'social-square', group: 'social', name: 'Quadrat (1:1)', description: '1080×1080', width: 1080, height: 1080, fps: 30, format: 'mp4', codec: 'h264', quality: 'high', loudness: -14 },
  { id: 'whatsapp', group: 'social', name: 'WhatsApp (klein)', description: 'Kleine Datei zum schnellen Teilen – 1280×720', width: 1280, height: 720, fps: 30, format: 'mp4', codec: 'h264', quality: 'medium' },
  { id: 'hd', group: 'video', name: 'Full HD (16:9)', description: 'YouTube, Fernseher – 1920×1080', width: 1920, height: 1080, fps: 30, format: 'mp4', codec: 'h264', quality: 'high' },
  { id: 'uhd', group: 'video', name: '4K UHD (16:9)', description: 'Maximale Qualität – 3840×2160', width: 3840, height: 2160, fps: 30, format: 'mp4', codec: 'h265', quality: 'high' },
  { id: 'youtube', group: 'video', name: 'YouTube (16:9, Lautheit)', description: '1920×1080 · Lautheit wie YouTube (−14 LUFS)', width: 1920, height: 1080, fps: 30, format: 'mp4', codec: 'h264', quality: 'high', loudness: -14 },
  { id: 'social-portrait', group: 'video', name: 'Hochformat (9:16)', description: '1080×1920 ohne Anpassung der Lautheit', width: 1080, height: 1920, fps: 30, format: 'mp4', codec: 'h264', quality: 'high' },
  { id: 'pano', group: 'special', name: '360° Panorama (2:1)', description: 'Komplettes Panorama für YouTube/Facebook 360 – 3840×1920', width: 3840, height: 1920, fps: 30, format: 'mp4', codec: 'h265', quality: 'high' },
  { id: 'prores', group: 'special', name: 'ProRes (Weiterbearbeitung)', description: 'Verlustarm für DaVinci / Final Cut – 1920×1080', width: 1920, height: 1080, fps: 30, format: 'mov', codec: 'prores', quality: 'max' },
  { id: 'gif', group: 'special', name: 'GIF', description: 'Kurze Animation – 640×360', width: 640, height: 360, fps: 15, format: 'gif', codec: 'gif', quality: 'medium' },
  { id: 'custom', group: 'special', name: 'Benutzerdefiniert', description: 'Eigene Auflösung, Format und Codec', width: 1920, height: 1080, fps: 30, format: 'mp4', codec: 'h264', quality: 'high' },
];

export const FORMAT_CODECS: Record<ExportFormat, ExportCodec[]> = {
  mp4: ['h264', 'h265'],
  mov: ['h264', 'h265', 'prores'],
  webm: ['vp9'],
  gif: ['gif'],
  jpg: ['jpeg'],
};

export const CODEC_NAMES: Record<ExportCodec, string> = {
  h264: 'H.264 (überall abspielbar)',
  h265: 'H.265 / HEVC (kleiner, 4K)',
  prores: 'Apple ProRes 422 HQ',
  vp9: 'VP9 (WebM)',
  gif: 'GIF',
  jpeg: 'JPEG-Bild',
};

export const QUALITY_NAMES: Record<ExportQuality, string> = {
  low: 'Klein (niedrige Qualität)',
  medium: 'Mittel',
  high: 'Hoch (empfohlen)',
  max: 'Maximal (sehr große Datei)',
};

export const PROJECT_PRESETS = [
  { id: 'hd', name: 'Full HD 16:9 (1920×1080)', width: 1920, height: 1080 },
  { id: 'uhd', name: '4K UHD 16:9 (3840×2160)', width: 3840, height: 2160 },
  { id: 'portrait', name: 'Hochformat 9:16 (1080×1920)', width: 1080, height: 1920 },
  { id: 'square', name: 'Quadrat 1:1 (1080×1080)', width: 1080, height: 1080 },
  { id: 'pano', name: '360° Panorama 2:1 (3840×1920)', width: 3840, height: 1920 },
];
