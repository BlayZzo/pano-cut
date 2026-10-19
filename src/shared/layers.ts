// Ebenen: Mischmodi, Schlagschatten und verknüpfte Clips (folgen einem anderen Clip).
import type { BlendMode, Clip, LayerShadow, Project } from './types';

export const BLEND_MODES: Array<{ id: BlendMode; name: string; canvas: GlobalCompositeOperation; ffmpeg: string }> = [
  { id: 'normal', name: 'Normal', canvas: 'source-over', ffmpeg: 'normal' },
  { id: 'screen', name: 'Negativ multiplizieren (Licht)', canvas: 'screen', ffmpeg: 'screen' },
  { id: 'add', name: 'Aufhellen (Addieren)', canvas: 'lighter', ffmpeg: 'addition' },
  { id: 'multiply', name: 'Multiplizieren (Abdunkeln)', canvas: 'multiply', ffmpeg: 'multiply' },
  { id: 'lighten', name: 'Nur Helleres', canvas: 'lighten', ffmpeg: 'lighten' },
  { id: 'darken', name: 'Nur Dunkleres', canvas: 'darken', ffmpeg: 'darken' },
];

export function blendDef(mode: BlendMode | undefined) {
  return BLEND_MODES.find((b) => b.id === (mode ?? 'normal')) ?? BLEND_MODES[0];
}

export const DEFAULT_SHADOW: LayerShadow = { enabled: true, opacity: 0.35, blur: 2, distance: 2, angle: 60 };

/** Versatz und Weichheit eines Schattens in Pixeln (für eine Bildhöhe H). Canvas: shadowBlur = 2·sigma. */
export function shadowPixels(sh: LayerShadow, H: number): { dx: number; dy: number; sigma: number } {
  const dist = (sh.distance / 100) * H;
  const rad = (sh.angle * Math.PI) / 180;
  return { dx: Math.cos(rad) * dist, dy: Math.sin(rad) * dist, sigma: Math.max(0, (sh.blur / 100) * H) };
}

export function hasShadow(c: Clip): boolean {
  return !!c.shadow?.enabled && c.shadow.opacity > 0.005;
}

/**
 * Verknüpfte Clips nachführen: Lichtschein und Objekt-Kopien übernehmen Zeit, Position usw. ihres Haupt-Clips.
 * Liefert dasselbe Projekt-Objekt zurück, wenn sich nichts ändert. Fehlt der Haupt-Clip, wird der verknüpfte Clip entfernt.
 */
export function syncLinkedClips(project: Project): Project {
  let clips: Record<string, Clip> | null = null;
  for (const c of Object.values(project.clips)) {
    if (!c.link) continue;
    const m = project.clips[c.link.clipId];
    if (!m) {
      if (!clips) clips = { ...project.clips };
      delete clips[c.id];
      continue;
    }
    const next = linkedState(c, m);
    if (next !== c) {
      if (!clips) clips = { ...project.clips };
      clips[c.id] = next;
    }
  }
  return clips ? { ...project, clips } : project;
}

function linkedState(c: Clip, m: Clip): Clip {
  const patch: Partial<Clip> = {};
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const set = <K extends keyof Clip>(k: K, v: Clip[K]) => { if (!same(c[k], v)) patch[k] = v; };
  set('start', m.start);
  set('speed', m.speed);
  set('reverse', m.reverse);
  set('motion', m.motion);
  if (c.link!.mode === 'light') {
    // Licht hat eigene Mediendatei gleicher Länge: nur Zeitfenster übernehmen
    set('in', m.in);
    set('out', m.out);
    const k = c.link!.scale ?? 3;
    set('transform', { x: m.transform.x, y: m.transform.y, scale: m.transform.scale * k, rotation: m.transform.rotation });
    set('fit', m.fit);
  } else {
    set('in', m.in);
    set('out', m.out);
    set('transform', m.transform);
    set('fit', m.fit);
    set('crop', m.crop);
    set('color', m.color);
    set('fx', m.fx);
    set('pano', m.pano);
    set('stabilize', m.stabilize);
    set('objects', m.objects);
    set('opacity', m.opacity);
  }
  return Object.keys(patch).length ? { ...c, ...patch } : c;
}
