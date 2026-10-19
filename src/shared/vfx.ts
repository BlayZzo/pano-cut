// Effekt-Simulationen: Arten, Standardwerte und das Verstehen einer Beschreibung („große Explosion mit viel Rauch“).
// Die Bilder selbst rechnet der Renderer per WebGL (renderer/vfx); hier liegt nur die gemeinsame Logik.
import type { ColorGrade, LayerShadow, VfxKind, VfxSpec } from './types';
import type { FrameStats } from './color';

export interface VfxKindDef {
  kind: VfxKind;
  name: string;
  icon: string;
  fullFrame: boolean;     // füllt das ganze Bild
  light: boolean;         // wirft Licht auf die Szene
  shadow: boolean;        // Schatten sinnvoll
  duration: number;       // Standard-Dauer (s)
  loop: boolean;          // nahtlos wiederholbar
  aspect: number;         // Breite/Höhe der Render-Fläche (platzierbare Effekte)
  scale: number;          // Standard-Größe im Bild (Anteil der Bildhöhe)
  y: number;              // Standard-Position (in % der Bildhöhe, 0 = Mitte)
  words: string[];        // Schlüsselwörter (klein, ohne Umlaut-Varianten nötig)
}

export const VFX_KINDS: VfxKindDef[] = [
  { kind: 'explosion', name: 'Explosion', icon: '💥', fullFrame: false, light: true, shadow: true, duration: 3.5, loop: false, aspect: 1, scale: 0.75, y: 0,
    words: ['explosion', 'explodier', 'detonation', 'detonier', 'bombe', 'feuerball', 'knall', 'sprengung', 'spreng', 'blast', 'explode', 'boom'] },
  { kind: 'fire', name: 'Feuer', icon: '🔥', fullFrame: false, light: true, shadow: false, duration: 4, loop: true, aspect: 0.75, scale: 0.55, y: 15,
    words: ['feuer', 'flamme', 'brand', 'brenn', 'lagerfeuer', 'fire', 'flame', 'burn'] },
  { kind: 'smoke', name: 'Rauch', icon: '💨', fullFrame: false, light: false, shadow: true, duration: 5, loop: true, aspect: 0.75, scale: 0.8, y: -5,
    words: ['rauch', 'qualm', 'dampf', 'smoke', 'steam', 'rauchsäule', 'rauchwolke'] },
  { kind: 'snow', name: 'Schnee', icon: '❄️', fullFrame: true, light: false, shadow: false, duration: 6, loop: true, aspect: 16 / 9, scale: 1, y: 0,
    words: ['schnee', 'schneit', 'schneefall', 'flocken', 'snow', 'winter'] },
  { kind: 'rain', name: 'Regen', icon: '🌧️', fullFrame: true, light: false, shadow: false, duration: 4, loop: true, aspect: 16 / 9, scale: 1, y: 0,
    words: ['regen', 'regnet', 'schauer', 'nieselregen', 'platzregen', 'rain', 'gewitter', 'sturm', 'unwetter'] },
  { kind: 'fog', name: 'Nebel', icon: '🌫️', fullFrame: true, light: false, shadow: false, duration: 6, loop: true, aspect: 16 / 9, scale: 1, y: 0,
    words: ['nebel', 'neblig', 'dunst', 'fog', 'mist', 'diesig'] },
  { kind: 'sparks', name: 'Funken', icon: '✨', fullFrame: false, light: true, shadow: false, duration: 3, loop: true, aspect: 1, scale: 0.7, y: 0,
    words: ['funken', 'funke', 'sprühen', 'schweiß', 'feuerwerk', 'wunderkerze', 'sparks', 'spark'] },
  { kind: 'lightning', name: 'Blitz', icon: '⚡', fullFrame: false, light: true, shadow: false, duration: 2.5, loop: false, aspect: 0.6, scale: 1.1, y: -10,
    words: ['blitz', 'gewitter', 'donner', 'lightning', 'thunder', 'unwetter'] },
  { kind: 'dust', name: 'Staub', icon: '🟤', fullFrame: true, light: false, shadow: false, duration: 5, loop: true, aspect: 16 / 9, scale: 1, y: 0,
    words: ['staub', 'sand', 'sandsturm', 'staubig', 'dust', 'pollen', 'partikel'] },
  { kind: 'confetti', name: 'Konfetti', icon: '🎉', fullFrame: true, light: false, shadow: false, duration: 4, loop: true, aspect: 16 / 9, scale: 1, y: 0,
    words: ['konfetti', 'confetti', 'party', 'feier', 'luftschlangen'] },
  { kind: 'impact', name: 'Aufprall', icon: '💢', fullFrame: false, light: false, shadow: false, duration: 2.5, loop: false, aspect: 2, scale: 0.6, y: 25,
    words: ['aufprall', 'einschlag', 'aufschlag', 'landung', 'impact', 'crash', 'trümmer', 'truemmer', 'druckwelle'] },
];

export function vfxKind(kind: VfxKind): VfxKindDef {
  return VFX_KINDS.find((k) => k.kind === kind) ?? VFX_KINDS[0];
}

const COLORS: Array<[string[], string]> = [
  [['blau', 'blue'], '#3f8cff'], [['grün', 'gruen', 'green'], '#38e05a'], [['rot', 'red'], '#ff3b2f'], [['lila', 'violett', 'purple'], '#a35cff'],
  [['pink', 'rosa'], '#ff5fb4'], [['gelb', 'yellow'], '#ffd23f'], [['orange'], '#ff8a1f'], [['weiß', 'weiss', 'white'], '#f4f6ff'],
  [['schwarz', 'black'], '#141414'], [['grau', 'gray', 'grey'], '#8a8a8a'], [['gold', 'golden'], '#ffc24a'], [['türkis', 'tuerkis', 'cyan'], '#2fe0d6'],
];

function hasWord(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/** Render-Größe eines Effekts für ein Projekt (platzierbar: quadratnah, ganzes Bild: Projektseitenverhältnis). */
export function vfxRenderSize(def: VfxKindDef, projectW: number, projectH: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (def.fullFrame) {
    const k = Math.min(1, 1280 / projectW, 1280 / projectH);
    return { width: even(projectW * k), height: even(projectH * k) };
  }
  const h = Math.min(960, Math.max(360, projectH * 0.9));
  return { width: even(h * def.aspect), height: even(h) };
}

/** Standard-Einstellungen einer Effektart. */
export function defaultVfx(kind: VfxKind, projectW: number, projectH: number, fps: number, prompt = ''): VfxSpec {
  const def = vfxKind(kind);
  const { width, height } = vfxRenderSize(def, projectW, projectH);
  return {
    kind, prompt, duration: def.duration, seed: Math.floor(Math.random() * 1000), size: 1, intensity: 1, speed: 1, wind: 0,
    smoke: kind === 'explosion' ? 1 : kind === 'fire' ? 0.5 : 0, width, height, fps: Math.min(60, Math.max(24, fps)), fullFrame: def.fullFrame, loop: def.loop,
  };
}

export interface ParsedVfx {
  specs: VfxSpec[];
  /** Kurze Zusammenfassung, was verstanden wurde (für die Anzeige). */
  understood: string[];
}

/**
 * Versteht eine Beschreibung auf Deutsch (oder Englisch) und macht daraus einen oder mehrere Effekte.
 * Beispiele: „große Explosion mit viel Rauch“, „leichter Schneefall von links“, „Gewitter“, „blaue Funken 2 Sekunden“.
 */
export function parseVfxPrompt(prompt: string, projectW: number, projectH: number, fps: number): ParsedVfx {
  const text = ` ${prompt.toLowerCase().replace(/[.,!?;:]/g, ' ')} `;
  const kinds: VfxKind[] = [];
  for (const def of VFX_KINDS) if (hasWord(text, def.words)) kinds.push(def.kind);
  // „Gewitter/Unwetter“ = Regen + Blitz; „Rauch“ zusammen mit Feuer/Explosion ist nur ein Zusatz
  if ((kinds.includes('explosion') || kinds.includes('fire')) && kinds.includes('smoke') && /(mit|ohne)\s+(viel\s+|wenig\s+|etwas\s+|dichtem\s+|dickem\s+|schwarzem\s+)?(rauch|qualm)/.test(text)) {
    kinds.splice(kinds.indexOf('smoke'), 1);
  }
  if (kinds.includes('explosion') && kinds.includes('fire') && !/und\s+feuer|feuer\s+und/.test(text)) kinds.splice(kinds.indexOf('fire'), 1);
  if (kinds.length === 0) return { specs: [], understood: [] };

  const understood: string[] = [];
  let size = 1, intensity = 1, speed = 1, wind = 0, smoke = -1;
  // Rauch-Angaben („mit viel Rauch“) nicht als Stärke des Haupteffekts lesen
  const main = kinds.every((k) => k === 'smoke' || k === 'fog') ? text : text.replace(/(mit|ohne)?\s*(viel|wenig|etwas|dicht\w*|dick\w*|schwarz\w*|leicht\w*)?\s+(rauch|qualm)\b/g, ' ');
  if (hasWord(main, ['riesig', 'gewaltig', 'massiv', 'enorm', 'gigantisch', 'huge', 'massive'])) { size = 1.6; understood.push('sehr groß'); }
  else if (hasWord(main, ['groß', 'gross', 'große', 'big', 'large'])) { size = 1.3; understood.push('groß'); }
  else if (hasWord(main, ['winzig', 'tiny'])) { size = 0.5; understood.push('winzig'); }
  else if (hasWord(main, ['klein', 'small'])) { size = 0.7; understood.push('klein'); }
  if (hasWord(main, ['heftig', 'stark', 'dicht', 'extrem', 'viel ', 'starker', 'starke', 'kräftig', 'heavy', 'strong', 'platzregen', 'sturm', 'unwetter'])) { intensity = 1.5; understood.push('stark'); }
  else if (hasWord(main, ['leicht', 'wenig', 'sanft', 'fein', 'zart', 'etwas', 'niesel', 'light ', 'soft'])) { intensity = 0.55; understood.push('leicht'); }
  if (hasWord(main, ['langsam', 'zeitlupe', 'slow'])) { speed = 0.6; understood.push('langsam'); }
  else if (hasWord(main, ['schnell', 'rasant', ' fast '])) { speed = 1.5; understood.push('schnell'); }
  if (hasWord(text, ['von links', 'nach rechts', 'aus links'])) { wind = 0.6; understood.push('Wind nach rechts'); }
  else if (hasWord(text, ['von rechts', 'nach links', 'aus rechts'])) { wind = -0.6; understood.push('Wind nach links'); }
  else if (hasWord(text, ['wind', 'schräg', 'sturm', 'böig'])) { wind = 0.45; understood.push('windig'); }
  if (/ohne\s+(rauch|qualm)/.test(text)) { smoke = 0; understood.push('ohne Rauch'); }
  else if (/(viel|dicht|dick|schwarz)\w*\s+(rauch|qualm)/.test(text)) { smoke = 1.7; understood.push('viel Rauch'); }
  else if (/(wenig|etwas|leicht)\w*\s+(rauch|qualm)/.test(text)) { smoke = 0.4; understood.push('wenig Rauch'); }
  else if (/mit\s+(rauch|qualm)/.test(text)) { smoke = 1.1; understood.push('mit Rauch'); }
  let color: string | undefined;
  for (const [words, hex] of COLORS) if (words.some((w) => new RegExp(`\\b${w}`).test(text))) { color = hex; understood.push(words[0]); break; }
  const dur = /(\d+(?:[.,]\d+)?)\s*(s|sek|sekunde|sekunden|sec|seconds?)\b/.exec(text);
  const duration = dur ? Math.max(0.5, Math.min(30, parseFloat(dur[1].replace(',', '.')))) : undefined;
  if (duration) understood.push(`${String(duration).replace('.', ',')} s`);

  const specs = kinds.map((kind) => {
    const s = defaultVfx(kind, projectW, projectH, fps, prompt);
    s.size = size; s.intensity = intensity; s.speed = speed; s.wind = wind;
    if (smoke >= 0 && (kind === 'explosion' || kind === 'fire')) s.smoke = smoke;
    if (color && kind !== 'smoke' && kind !== 'fog') s.color = color;
    if (color && (kind === 'smoke' || kind === 'fog') && /(rauch|nebel|qualm|dampf)/.test(text)) s.color = color;
    if (duration) s.duration = duration;
    return s;
  });
  return { specs, understood: [...specs.map((s) => vfxKind(s.kind).name), ...understood] };
}

/** Kurzer Anzeigename eines Effekts. */
export function vfxLabel(spec: VfxSpec): string {
  const def = vfxKind(spec.kind);
  const parts = [def.name];
  if (spec.size >= 1.25) parts.push('groß'); else if (spec.size <= 0.75) parts.push('klein');
  if (spec.intensity >= 1.3) parts.push('stark'); else if (spec.intensity <= 0.7) parts.push('leicht');
  return parts.join(' · ');
}

// ---------- An die Szene anpassen ----------

export interface SceneMatch {
  color: Partial<ColorGrade>;   // Farbkorrektur für den Effekt
  lightStrength: number;        // Deckkraft des Lichtscheins (0 = aus)
  shadow?: LayerShadow;         // Schatten
}

/**
 * Berechnet aus der Helligkeit/Farbe der Szene, wie der Effekt eingepasst wird:
 * dunkle Szenen → Rauch/Schnee dunkler, Licht stärker; Farbstich der Szene wird übernommen.
 */
export function matchToScene(spec: VfxSpec, scene: FrameStats): SceneMatch {
  const def = vfxKind(spec.kind);
  const mid = scene.p50;                 // mittlere Helligkeit 0..1
  const avg = (scene.meanR + scene.meanG + scene.meanB) / 3 || 0.001;
  const warm = (scene.meanR - scene.meanB) / avg;          // >0 warm, <0 kühl
  const green = (scene.meanG - (scene.meanR + scene.meanB) / 2) / avg;
  const color: Partial<ColorGrade> = {};
  const emissive = spec.kind === 'explosion' || spec.kind === 'fire' || spec.kind === 'sparks' || spec.kind === 'lightning';
  // Belichtung: nicht leuchtende Effekte (Rauch, Schnee, Nebel …) an die Szenenhelligkeit angleichen
  const exp = Math.log2(Math.max(0.04, mid) / 0.42);
  color.exposure = round2(Math.max(-2.2, Math.min(0.4, exp * (emissive ? 0.25 : 0.75))));
  // Farbstich der Szene übernehmen (abgeschwächt)
  color.temperature = Math.round(Math.max(-40, Math.min(40, warm * (emissive ? 15 : 45))));
  color.tint = Math.round(Math.max(-25, Math.min(25, -green * 30)));
  // In flauen/dunstigen Szenen etwas weniger Kontrast und Sättigung
  const spread = scene.p95 - scene.p05;
  color.contrast = round2(Math.max(0.8, Math.min(1.1, 0.85 + spread * 0.25)));
  color.saturation = round2(Math.max(0.6, Math.min(1.1, 0.7 + scene.meanSat * 0.9)));
  // Licht: je dunkler die Szene, desto stärker wirkt der Schein
  const lightStrength = def.light ? round2(Math.max(0.25, Math.min(1, 1.15 - mid * 1.3))) : 0;
  // Schatten: bei hellen, kontrastreichen Szenen deutlicher
  const shadow: LayerShadow | undefined = def.shadow
    ? { enabled: true, opacity: round2(Math.max(0.12, Math.min(0.45, 0.15 + spread * 0.35 + mid * 0.1))), blur: 3, distance: 2.5, angle: 60 }
    : undefined;
  return { color, lightStrength, shadow };
}

/** Erschütterung (Kamera wackelt nach einer Explosion) als Keyframes ab Zeitpunkt t0 (Clip-lokal). */
export function shakeKeyframes(t0: number, strength: number, clipDur: number): Array<{ t: number; x: number; y: number; scale: number; rotation: number; opacity: number }> {
  const out: Array<{ t: number; x: number; y: number; scale: number; rotation: number; opacity: number }> = [];
  const steps = 14, len = 0.9;
  const z = 1 + 0.03 * strength;
  if (t0 > 0.05) out.push({ t: Math.max(0, t0 - 0.05), x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const t = t0 + u * len;
    if (t > clipDur) break;
    const decay = Math.exp(-u * 3.2) * (i === steps ? 0 : 1);
    const ph = i * 2.399;
    out.push({ t, x: round2(Math.sin(ph * 1.7) * 1.4 * strength * decay), y: round2(Math.cos(ph * 2.3) * 1.1 * strength * decay), scale: round2(1 + (z - 1) * (i === steps ? 0 : 1)), rotation: round2(Math.sin(ph) * 0.4 * strength * decay), opacity: 1 });
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
