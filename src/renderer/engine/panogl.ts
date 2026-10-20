// WebGL-Renderer für 360°-Videos: Equirectangular → flache Ansicht / gedrehtes Panorama / Little Planet.
// Die Mathematik entspricht FFmpegs v360-Filter, damit Vorschau und Export übereinstimmen.
import type { PanoMode, StitchSettings } from '@shared/types';
import { blendWidth, coverHalf, lensModel } from '@shared/stitchModel';
import { panoMatrix, verticalFov } from '@shared/pano';
import type { PanoView } from '@shared/pano';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform mat3 uRot;
uniform vec2 uRange;
uniform int uMode;
uniform int uInput;     // 0 = Equirectangular, 1 = zwei Fischaugen nebeneinander (Rohvideo) – Mathematik: shared/stitchModel.ts
uniform mat3 uL0;       // Linse 0 (hinten): Blickrichtung → Linsen-Koordinaten
uniform mat3 uL1;       // Linse 1 (vorne)
uniform mat3 uG;        // Grund-Ausrichtung (für die Naht)
uniform vec4 uRect0;    // Bildbereich der Linse in der Textur (x, y, w, h)
uniform vec4 uRect1;
uniform float uK0;      // 180 / ih_fov
uniform float uK1;
uniform vec3 uGain0;
uniform vec3 uGain1;
uniform float uBlend;   // Breite der weichen Naht (Grad)
uniform float uCover;   // Linse wird bis zu diesem Längengrad benutzt (Grad)
varying vec2 vUv;
const float PI = 3.141592653589793;
// Fischauge (wie v360 input=fisheye): a = 0, wenn die Richtung außerhalb des Bildkreises liegt
vec4 fish(vec3 d, vec4 rect, float k) {
  float h = length(d.xy);
  float lh = h > 0.0 ? h : 1.0;
  float phi = atan(h, d.z) / PI;
  vec2 f = d.xy / lh * phi * k;
  if (abs(f.x) >= 0.5 || abs(f.y) >= 0.5) return vec4(0.0);
  return vec4(texture2D(uTex, rect.xy + (f + 0.5) * rect.zw).rgb, 1.0);
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 v;
  if (uMode == 0) {
    v = vec3(uRange.x * p.x, uRange.y * p.y, 1.0);
  } else if (uMode == 1) {
    float phi = p.x * uRange.x;
    float theta = p.y * uRange.y;
    v = vec3(cos(theta) * sin(phi), sin(theta), cos(theta) * cos(phi));
  } else {
    float x = p.x * uRange.x;
    float y = p.y * uRange.y;
    float r = length(vec2(x, y));
    float th = atan(r) * 2.0;
    float s = sin(th);
    v = r > 0.0 ? vec3(x / r * s, y / r * s, cos(th)) : vec3(0.0, 0.0, 1.0);
  }
  v = normalize(v);
  v = uRot * v;
  if (uInput == 1) {
    vec4 c0 = fish(uL0 * v, uRect0, uK0);
    vec4 c1 = fish(uL1 * v, uRect1, uK1);
    vec3 gu = uG * v;
    float uz = gu.z;
    float lonu = abs(degrees(atan(gu.x, gu.z)));
    float w;
    if (lonu > uCover) w = 0.0;
    else if (lonu < 180.0 - uCover) w = 1.0;
    else if (uBlend <= 0.0) w = uz >= 0.0 ? 1.0 : 0.0;
    else {
      float x = clamp((degrees(asin(clamp(uz, -1.0, 1.0))) + uBlend * 0.5) / uBlend, 0.0, 1.0);
      w = x * x * (3.0 - 2.0 * x);
    }
    if (c1.a < 0.5) w = 0.0;
    if (c0.a < 0.5) w = 1.0;
    gl_FragColor = vec4(mix(c0.rgb * uGain0, c1.rgb * uGain1, w), 1.0);
    return;
  }
  float lon = atan(v.x, v.z) / PI;
  float lat = asin(clamp(v.y, -1.0, 1.0)) / (PI * 0.5);
  vec2 uv = vec2((lon + 1.0) * 0.5, (lat + 1.0) * 0.5);
  gl_FragColor = texture2D(uTex, uv);
}`;

/** Rohvideo mit zwei Fischaugen nebeneinander: Zusammensetz-Einstellungen; `swap` = Bildhälften andersherum. */
export interface FisheyeInput { stitch: StitchSettings; swap?: boolean }

export class PanoGL {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private uRot: WebGLUniformLocation | null = null;
  private uRange: WebGLUniformLocation | null = null;
  private uMode: WebGLUniformLocation | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private lastSource: unknown = null;
  private lastSourceTime = -1;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (this.gl) this.init(this.gl);
  }

  get available(): boolean { return !!this.gl && !!this.program; }

  private init(gl: WebGLRenderingContext): void {
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('Shader-Fehler', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Programm-Fehler', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.uRot = gl.getUniformLocation(prog, 'uRot');
    this.uRange = gl.getUniformLocation(prog, 'uRange');
    this.uMode = gl.getUniformLocation(prog, 'uMode');
    for (const n of ['uInput', 'uL0', 'uL1', 'uG', 'uRect0', 'uRect1', 'uK0', 'uK1', 'uGain0', 'uGain1', 'uBlend', 'uCover']) this.u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    this.program = prog;
  }

  /**
   * Rendert eine Ansicht. `source` ist das Equirectangular-Bild (Video/Bild), Ausgabe hat `outW`×`outH` Pixel.
   * Mit `fisheye` ist `source` ein Rohvideo mit zwei Fischaugen nebeneinander (wird direkt hier zusammengesetzt).
   */
  render(source: TexImageSource, outW: number, outH: number, mode: PanoMode, view: PanoView, sourceTime: number, fisheye?: FisheyeInput): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || !this.program) return null;
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW;
      this.canvas.height = outH;
    }
    gl.viewport(0, 0, outW, outH);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (source !== this.lastSource || sourceTime !== this.lastSourceTime) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      } catch {
        return null;
      }
      this.lastSource = source;
      this.lastSourceTime = sourceTime;
    }
    const m = panoMatrix(view.yaw, view.pitch, view.roll);
    // GLSL erwartet spaltenweise; unsere Matrix ist zeilenweise → transponiert übergeben
    gl.uniformMatrix3fv(this.uRot, false, new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]));
    const hfov = Math.max(1, Math.min(359, view.fov));
    if (mode === 'flat') {
      const vfov = verticalFov(hfov, outW, outH);
      gl.uniform2f(this.uRange, Math.tan((hfov * Math.PI) / 360), Math.tan((vfov * Math.PI) / 360));
      gl.uniform1i(this.uMode, 0);
    } else if (mode === 'equirect') {
      gl.uniform2f(this.uRange, Math.PI, Math.PI / 2);
      gl.uniform1i(this.uMode, 1);
    } else {
      const rx = Math.tan((hfov * Math.PI) / 720);
      gl.uniform2f(this.uRange, rx, rx * (outH / outW));
      gl.uniform1i(this.uMode, 2);
    }
    gl.uniform1i(this.u.uInput, fisheye ? 1 : 0);
    if (fisheye) {
      const st = fisheye.stitch;
      const col = (m: number[]) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
      for (const i of [0, 1] as const) {
        const lm = lensModel(st, i);
        // Welche Bildhälfte gehört zu dieser Linse? (Kamera-Vorschaudatei evtl. andersherum)
        const half = (fisheye.swap ? 1 - i : i) * 0.5;
        gl.uniformMatrix3fv(this.u[`uL${i}`], false, col(lm.matrix));
        gl.uniform4f(this.u[`uRect${i}`], half + lm.crop.x * 0.5, lm.crop.y, lm.crop.w * 0.5, lm.crop.h);
        gl.uniform1f(this.u[`uK${i}`], 180 / lm.ihFov);
        gl.uniform3f(this.u[`uGain${i}`], lm.gain[0], lm.gain[1], lm.gain[2]);
      }
      gl.uniformMatrix3fv(this.u.uG, false, col(panoMatrix(st.yaw, st.pitch, st.roll)));
      gl.uniform1f(this.u.uBlend, blendWidth(st));
      gl.uniform1f(this.u.uCover, coverHalf(st));
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let panoInstance: PanoGL | null = null;
/** Für die Vorschau gemeinsam genutzte Instanz (spart WebGL-Kontexte). */
export function sharedPanoGL(): PanoGL {
  if (!panoInstance) panoInstance = new PanoGL();
  return panoInstance;
}
