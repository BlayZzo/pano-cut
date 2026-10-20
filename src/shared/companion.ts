// Kamera-Vorschaudateien („Begleitdateien“): Drohnen und Action-Kameras speichern neben dem großen Video eine kleine
// Kopie (DJI: .LRF, GoPro/Insta360: .LRV). PanoCut nutzt sie als fertige Vorschau-Datei – dann muss nichts umgerechnet werden.

export const COMPANION_EXT = ['.lrf', '.lrv'];

function splitName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  return i > 0 ? { stem: name.slice(0, i), ext: name.slice(i).toLowerCase() } : { stem: name, ext: '' };
}

/** Ist das (vom Namen her) eine Kamera-Vorschaudatei? */
export function isCompanionName(name: string): boolean {
  const { stem, ext } = splitName(name);
  if (COMPANION_EXT.includes(ext)) return true;
  // Insta360: LRV_….insv
  return ext === '.insv' && /^LRV_/i.test(stem);
}

/**
 * Prüft, ob `candidate` die Kamera-Vorschaudatei zum Video `main` ist (nur Dateinamen, gleicher Ordner).
 * - gleicher Name, Endung .LRF/.LRV (DJI, ältere GoPro)
 * - GoPro: GX010042.MP4 / GH010042.MP4 ↔ GL010042.LRV
 * - Insta360: VID_20240101_120000_00_001.mp4 ↔ LRV_20240101_120000_01_001.lrv
 */
export function isCompanionFor(main: string, candidate: string): boolean {
  const a = splitName(main), b = splitName(candidate);
  if (a.ext === b.ext && a.stem === b.stem) return false;
  if (!isCompanionName(candidate)) return false;
  const ms = a.stem.toUpperCase(), cs = b.stem.toUpperCase();
  if (ms === cs) return true;
  const gopro = /^G[HXP](\d{6})$/.exec(ms);
  if (gopro && cs === `GL${gopro[1]}`) return true;
  const insta = /^VID_(\d{8}_\d{6})_\d{2}_(\d+)$/.exec(ms);
  const instaC = /^LRV_(\d{8}_\d{6})_\d{2}_(\d+)$/.exec(cs);
  if (insta && instaC && insta[1] === instaC[1] && insta[2] === instaC[2]) return true;
  return false;
}

/** Aus einer Dateiliste die Kamera-Vorschaudateien entfernen, zu denen das große Video ebenfalls in der Liste ist. */
export function dropCompanions(paths: string[]): string[] {
  const byDir = new Map<string, string[]>();
  const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  const baseOf = (p: string) => p.slice(dirOf(p).length);
  for (const p of paths) {
    const d = dirOf(p);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(baseOf(p));
  }
  return paths.filter((p) => {
    const name = baseOf(p);
    if (!isCompanionName(name)) return true;
    return !(byDir.get(dirOf(p)) ?? []).some((other) => other !== name && isCompanionFor(other, name));
  });
}
