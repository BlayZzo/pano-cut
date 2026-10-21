import fs from 'node:fs';
import { fontDef } from '@shared/pano';

/** Liefert eine Schriftdatei für den drawtext-Filter – oder null, wenn FFmpeg die Schrift per Name suchen soll. */
export function resolveFontFile(key: string): string | null {
  const def = fontDef(key);
  const candidates = def.files[process.platform as 'darwin' | 'win32' | 'linux'] ?? [];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Allgemeine Rückfalloptionen
  const fallbacks = process.platform === 'darwin'
    ? ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf']
    : process.platform === 'win32'
      ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'];
  for (const c of fallbacks) if (fs.existsSync(c)) return c;
  return null;
}

/** Schriftname für libass/fontconfig (Untertitel-Filter). */
export function fontFamilyName(key: string): string {
  switch (key) {
    case 'impact': return 'Impact';
    case 'serif': return process.platform === 'win32' ? 'Georgia' : 'Georgia';
    case 'mono': return process.platform === 'darwin' ? 'Menlo' : 'Courier New';
    case 'black': return 'Arial Black';
    case 'condensed': return process.platform === 'win32' ? 'Arial Narrow' : 'Arial Narrow';
    case 'rounded': return process.platform === 'win32' ? 'Arial Rounded MT Bold' : 'Arial Rounded MT Bold';
    case 'script': return process.platform === 'win32' ? 'Segoe Script' : 'Brush Script MT';
    case 'trebuchet': return 'Trebuchet MS';
    default: return process.platform === 'darwin' ? 'Helvetica' : 'Arial';
  }
}

/** Pfad-Escaping für FFmpeg-Filteroptionen (Doppelpunkte, Backslashes, Hochkommas). */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
