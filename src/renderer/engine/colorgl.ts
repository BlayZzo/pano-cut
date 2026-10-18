// WebGL-Farbbearbeitung für die Vorschau: wendet dieselbe 3D-LUT an wie der Export (lut3d) und die Vignette.
import type { ColorGrade } from '@shared/types';
import { bakeGradeLut, gradeKey, isNeutralGrade, parseCube, type Lut3D } from '@shared/color';

/** Für die Vorschau gemeinsam genutzte Instanz (spart WebGL-Kontexte). */
let shared: ColorGL | null = null;
export function sharedColorGL(): ColorGL {
  if (!shared) shared = new ColorGL();
  return shared;
}

const VERT = `
attribute vec2 aPos; varying vec2 vUv;
void main() { vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform sampler2D uTex; uniform sampler2D uLut; uniform float uSize; uniform float uUseLut;
uniform float uVignette; uniform vec2 uDim; uniform vec4 uCrop; uniform vec2 uFlip;
varying vec2 vUv;
vec3 lut(vec3 c) {
  float N = uSize;
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (N - 1.0);
  float b0 = floor(b); float b1 = min(b0 + 1.0, N - 1.0); float fb = b - b0;
  float x = c.r * (N - 1.0) + 0.5; float y = (c.g * (N - 1.0) + 0.5) / N;
  vec3 s0 = texture2D(uLut, vec2((b0 * N + x) / (N * N), y)).rgb;
  vec3 s1 = texture2D(uLut, vec2((b1 * N + x) / (N * N), y)).rgb;
  return mix(s0, s1, fb);
}
void main() {
  vec2 u = vec2(uFlip.x > 0.5 ? 1.0 - vUv.x : vUv.x, uFlip.y > 0.5 ? 1.0 - vUv.y : vUv.y);
  vec4 c = texture2D(uTex, uCrop.xy + u * uCrop.zw);
  vec3 rgb = c.rgb;
  if (uUseLut > 0.5) rgb = lut(rgb);
  if (uVignette > 0.0) {
    vec2 p = (vUv - 0.5) * uDim;
    float d = length(p) / length(uDim * 0.5);
    float f = cos(uVignette * d); f = f * f; f = f * f;
    rgb *= f;
  }
  gl_FragColor = vec4(rgb, c.a);
}`;

const PREVIEW_LUT_SIZE = 25;

const userLuts = new Map<string, Lut3D | null>();
const lutPixelCache = new Map<string, Uint8Array>();
const pendingLuts = new Set<string>();

/** Eigene .cube-Datei laden (asynchron, zwischengespeichert). */
function userLut(path: string | undefined, onLoaded: () => void): Lut3D | null | undefined {
  if (!path) return null;
  if (userLuts.has(path)) return userLuts.get(path);
  if (!pendingLuts.has(path)) {
    pendingLuts.add(path);
    void window.panocut.readTextFile(path).then((txt) => {
      try { userLuts.set(path, txt ? parseCube(txt) : null); } catch { userLuts.set(path, null); }
      pendingLuts.delete(path);
      onLoaded();
    });
  }
  return undefined; // wird noch geladen
}

export class ColorGL {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutKey = '';
  private loc: Record<string, WebGLUniformLocation | null> = {};

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (this.gl) this.init(this.gl);
  }

  get available(): boolean { return !!this.gl && !!this.program; }

  private init(gl: WebGLRenderingContext): void {
    const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null; };
    const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const mk = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.tex = mk();
    this.lutTex = mk();
    for (const n of ['uSize', 'uUseLut', 'uVignette', 'uDim', 'uCrop', 'uFlip']) this.loc[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uLut'), 1);
    this.program = prog;
  }

  private uploadLut(grade: ColorGrade, onLoaded: () => void): boolean {
    const gl = this.gl!;
    const ul = userLut(grade.lut, onLoaded);
    if (ul === undefined) return false; // noch nicht geladen
    const key = gradeKey(grade) + (ul ? '|u' : '');
    if (key === this.lutKey) return true;
    const N = PREVIEW_LUT_SIZE;
    let px = lutPixelCache.get(key);
    if (!px) {
      const lut = bakeGradeLut(grade, ul, N);
      px = new Uint8Array(N * N * N * 4);
      // Layout: x = r + b*N, y = g
      for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
        const si = ((b * N + g) * N + r) * 3;
        const di = (g * N * N + b * N + r) * 4;
        px[di] = Math.round(lut.data[si] * 255); px[di + 1] = Math.round(lut.data[si + 1] * 255); px[di + 2] = Math.round(lut.data[si + 2] * 255); px[di + 3] = 255;
      }
      lutPixelCache.set(key, px);
      if (lutPixelCache.size > 48) lutPixelCache.delete(lutPixelCache.keys().next().value as string);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N * N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.activeTexture(gl.TEXTURE0);
    this.lutKey = key;
    return true;
  }

  /**
   * Zuschnitt, Spiegeln, Farbe und Vignette in einem Durchgang (gleiche Reihenfolge wie im Export).
   * `w`/`h` sind die Maße der Quelle; die Ausgabe hat die Maße des Zuschnitts. Gibt null zurück, wenn nichts zu tun ist.
   */
  render(source: TexImageSource, w: number, h: number, grade: ColorGrade, vignette: number, crop: { x: number; y: number; w: number; h: number } | null, mirror: boolean, flip: boolean, onLutLoaded: () => void): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || !this.program) return null;
    const useLut = !isNeutralGrade(grade);
    if (!useLut && vignette <= 0.01 && !crop && !mirror && !flip) return null;
    const lutReady = useLut ? this.uploadLut(grade, onLutLoaded) : false;
    const cr = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const ow = Math.max(2, Math.round(w * cr.w)), oh = Math.max(2, Math.round(h * cr.h));
    if (this.canvas.width !== ow || this.canvas.height !== oh) { this.canvas.width = ow; this.canvas.height = oh; }
    gl.viewport(0, 0, ow, oh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch { return null; }
    gl.uniform1f(this.loc.uSize, PREVIEW_LUT_SIZE);
    gl.uniform1f(this.loc.uUseLut, useLut && lutReady ? 1 : 0);
    gl.uniform1f(this.loc.uVignette, vignette > 0.01 ? 0.15 + vignette * 0.95 : 0);
    gl.uniform2f(this.loc.uDim, ow, oh);
    gl.uniform4f(this.loc.uCrop, cr.x, cr.y, cr.w, cr.h);
    gl.uniform2f(this.loc.uFlip, mirror ? 1 : 0, flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
