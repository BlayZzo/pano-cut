// Rendert Effekt-Simulationen Bild für Bild per WebGL und gibt die Bilder an den Hauptprozess (FFmpeg) weiter.
import type { MediaItem, VfxKind, VfxSpec } from '@shared/types';
import { vfxKind } from '@shared/vfx';
import { VERT, fragmentSource } from './shaders';

/** Größe des Lichtscheins relativ zum Effekt (Kantenlänge). */
export const LIGHT_SCALE = 3;
/** Höhe der Lichtschein-Datei in Pixeln (weicher Schein → wenig Auflösung reicht). */
const LIGHT_HEIGHT = 320;

interface Prog { program: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }

const UNIFORMS = ['uRes', 'uTime', 'uDur', 'uSeed', 'uSize', 'uIntensity', 'uSpeed', 'uWind', 'uSmoke', 'uHasColor', 'uColor', 'uLightScale'];

export class VfxRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private programs = new Map<string, Prog>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true });
    if (this.gl) {
      const gl = this.gl;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    }
  }

  get available(): boolean { return !!this.gl; }

  private program(kind: VfxKind, light: boolean): Prog {
    const key = `${kind}:${light ? 'l' : 'e'}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl!;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader-Fehler (${key}): ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource(kind, light)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Shader-Fehler (${key}): ${gl.getProgramInfoLog(program)}`);
    const loc: Record<string, WebGLUniformLocation | null> = {};
    for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(program, n);
    const p = { program, loc };
    this.programs.set(key, p);
    return p;
  }

  /** Ein Bild rendern; Ergebnis RGBA (Zeilen von unten nach oben, wie readPixels). */
  renderFrame(spec: VfxSpec, t: number, light: boolean, width: number, height: number, out?: Uint8Array): Uint8Array {
    const gl = this.gl;
    if (!gl) throw new Error('WebGL ist nicht verfügbar');
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    const p = this.program(spec.kind, light);
    gl.useProgram(p.program);
    const aPos = gl.getAttribLocation(p.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const col = hexToRgb(spec.color);
    gl.uniform2f(p.loc.uRes, width, height);
    gl.uniform1f(p.loc.uTime, t);
    gl.uniform1f(p.loc.uDur, Math.max(0.1, spec.duration));
    gl.uniform1f(p.loc.uSeed, (spec.seed % 997) * 0.731 + 0.37);
    gl.uniform1f(p.loc.uSize, Math.max(0.3, spec.size));
    gl.uniform1f(p.loc.uIntensity, Math.max(0.1, spec.intensity));
    gl.uniform1f(p.loc.uSpeed, Math.max(0.1, spec.speed));
    gl.uniform1f(p.loc.uWind, spec.wind);
    gl.uniform1f(p.loc.uSmoke, spec.smoke);
    gl.uniform1f(p.loc.uHasColor, col ? 1 : 0);
    gl.uniform3f(p.loc.uColor, col?.[0] ?? 1, col?.[1] ?? 1, col?.[2] ?? 1);
    gl.uniform1f(p.loc.uLightScale, LIGHT_SCALE);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, light ? 1 : 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // In Streifen zeichnen: aufwendige Effekte blockieren die Grafikkarte so nie zu lange am Stück
    const heavy = spec.kind === 'explosion' || spec.kind === 'smoke';
    const strips = heavy && !light ? Math.max(1, Math.ceil((width * height) / 250_000)) : 1;
    if (strips > 1) gl.enable(gl.SCISSOR_TEST);
    for (let i = 0; i < strips; i++) {
      const y0 = Math.floor((i * height) / strips), y1 = Math.floor(((i + 1) * height) / strips);
      if (strips > 1) gl.scissor(0, y0, width, y1 - y0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (strips > 1) gl.flush();
    }
    if (strips > 1) gl.disable(gl.SCISSOR_TEST);
    const buf = out && out.length === width * height * 4 ? out : new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }
}

function hexToRgb(hex?: string): [number, number, number] | null {
  if (!hex) return null;
  const h = hex.replace('#', '');
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

let shared: VfxRenderer | null = null;
export function vfxRenderer(): VfxRenderer {
  if (!shared) shared = new VfxRenderer();
  return shared;
}

export interface VfxRenderResult { effect: MediaItem; light?: MediaItem }

let cancelFlag = false;
export function cancelVfx(): void { cancelFlag = true; }

/** Rendert Effekt (+ ggf. Lichtschein) und lässt daraus Videos kodieren. */
export async function renderVfx(projectId: string, spec: VfxSpec, opts: { mediaId?: string; lightMediaId?: string; withLight: boolean; onProgress: (percent: number, message: string) => void }): Promise<VfxRenderResult> {
  cancelFlag = false;
  const r = vfxRenderer();
  if (!r.available) throw new Error('Effekte brauchen WebGL – die Grafikkarte wird nicht unterstützt.');
  const api = window.panocut;
  const frames = Math.max(1, Math.round(spec.duration * spec.fps));
  const def = vfxKind(spec.kind);
  const withLight = opts.withLight && def.light;
  const lightH = LIGHT_HEIGHT, lightW = Math.max(2, Math.round((LIGHT_HEIGHT * spec.width) / spec.height / 2) * 2);
  const jobs: Array<{ id: string; light: boolean; w: number; h: number }> = [];
  try {
    jobs.push({ id: await api.vfxBegin({ projectId, spec, role: 'effect', width: spec.width, height: spec.height, mediaId: opts.mediaId }), light: false, w: spec.width, h: spec.height });
    if (withLight) jobs.push({ id: await api.vfxBegin({ projectId, spec, role: 'light', width: lightW, height: lightH, mediaId: opts.lightMediaId }), light: true, w: lightW, h: lightH });
    const bufs = new Map<string, Uint8Array>();
    let lastYield = performance.now();
    for (let i = 0; i < frames; i++) {
      if (cancelFlag) throw new Error('Abgebrochen');
      const t = i / spec.fps;
      for (const j of jobs) {
        const px = r.renderFrame(spec, t, j.light, j.w, j.h, bufs.get(j.id));
        bufs.set(j.id, px);
        await api.vfxFrame(j.id, px);
      }
      if (i % 3 === 0) opts.onProgress(Math.round(((i + 1) / frames) * 97), `Bild ${i + 1} von ${frames} …`);
      // Oberfläche zwischendurch atmen lassen
      if (performance.now() - lastYield > 40) { await new Promise((res) => setTimeout(res, 0)); lastYield = performance.now(); }
    }
    opts.onProgress(98, 'Video wird gespeichert …');
    const effect = await api.vfxEnd(jobs[0].id);
    const light = jobs[1] ? await api.vfxEnd(jobs[1].id) : undefined;
    opts.onProgress(100, 'Fertig');
    return { effect, light };
  } catch (err) {
    for (const j of jobs) await api.vfxCancel(j.id).catch(() => {});
    throw err;
  }
}
