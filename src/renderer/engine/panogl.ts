// WebGL-Renderer für 360°-Videos: Equirectangular → flache Ansicht / gedrehtes Panorama / Little Planet.
// Die Mathematik entspricht FFmpegs v360-Filter, damit Vorschau und Export übereinstimmen.
import type { PanoMode, StitchSettings } from '@shared/types';
import { blendWidth, COVER_FADE, coverHalf, lensModel, mul3 } from '@shared/stitchModel';
import { SEAM_BINS, SEAM_MAX, seamTaper } from '@shared/seamFlow';
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
uniform sampler2D uDisp; // bewegte Naht: Versatz je Nahtstelle (SEAM_BINS × 1, Byte → ±SEAM_MAX°)
uniform vec3 uSeam;       // an (1/0), t0, t1 (Grad)
uniform sampler2D uMask;  // Maske im ganzen 360°-Bild (Equirect, Deckkraft = sichtbar)
uniform vec2 uMaskOn;     // x: an, y: umkehren
uniform vec2 uNadir;    // unten ausblenden: ab Breite x (Grad), weicher Rand y (Grad); x ≥ 90 = aus
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
// Zwei Fischaugen → Farbe für Richtung v (Panorama-Koordinaten)
vec3 seamShift(vec3 gu, float sgn) {
  // bewegte Naht (shared/seamFlow.ts shiftedDir): quer zur Naht um ±Versatz/2 verschieben, weich auslaufend
  float s = asin(clamp(gu.z, -1.0, 1.0));
  float x = clamp((uSeam.z - abs(degrees(s))) / (uSeam.z - uSeam.y), 0.0, 1.0);
  float tp = x * x * (3.0 - 2.0 * x);
  float a = atan(gu.y, gu.x);
  float d = (texture2D(uDisp, vec2(a / (2.0 * PI) + 0.5, 0.5)).r * 2.0 - 1.0) * ${SEAM_MAX.toFixed(1)};
  float s2 = s + sgn * 0.5 * radians(d) * tp;
  return vec3(cos(s2) * cos(a), cos(s2) * sin(a), sin(s2)) * uG;
}
vec3 stitchAt(vec3 v) {
  vec3 v0 = v, v1 = v;
  if (uSeam.x > 0.5) { vec3 g = uG * v; v0 = seamShift(g, -1.0); v1 = seamShift(g, 1.0); }
  vec4 c0 = fish(uL0 * v0, uRect0, uK0);
  vec4 c1 = fish(uL1 * v1, uRect1, uK1);
  vec3 gu = uG * v;
  float uz = gu.z;
  float lonu = abs(degrees(atan(gu.x, gu.z)));
  // wie frontWeight (stitchModel.ts): Naht weich, Linsen-Grenzen weich
  float x = uBlend <= 0.0 ? (uz >= 0.0 ? 1.0 : 0.0) : clamp((degrees(asin(clamp(uz, -1.0, 1.0))) + uBlend * 0.5) / uBlend, 0.0, 1.0);
  x = x * x * (3.0 - 2.0 * x);
  float wa = x * clamp((uCover - lonu) / ${COVER_FADE.toFixed(1)}, 0.0, 1.0);
  float wb = (1.0 - x) * clamp((lonu - (180.0 - uCover)) / ${COVER_FADE.toFixed(1)}, 0.0, 1.0);
  float w = wa + wb > 0.0 ? wa / (wa + wb) : (lonu < 90.0 ? 1.0 : 0.0);
  if (c1.a < 0.5) w = 0.0;
  if (c0.a < 0.5) w = 1.0;
  return mix(c0.rgb * uGain0, c1.rgb * uGain1, w);
}
// Equirectangular → Farbe für Richtung v
vec3 equiAt(vec3 v) {
  float lon = atan(v.x, v.z) / PI;
  float lat = asin(clamp(v.y, -1.0, 1.0)) / (PI * 0.5);
  return texture2D(uTex, vec2((lon + 1.0) * 0.5, (lat + 1.0) * 0.5)).rgb;
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
  // Unten ausblenden (Selfie-Stick/Hand): Farbe vom Ring darüber nach innen ziehen (wie der Export)
  float nw = 0.0;
  vec3 vr = v;
  if (uNadir.x < 90.0) {
    float latd = degrees(asin(clamp(v.y, -1.0, 1.0)));
    float r0 = uNadir.x - uNadir.y;
    nw = clamp((latd - r0) / uNadir.y, 0.0, 1.0);
    nw = nw * nw * (3.0 - 2.0 * nw);
    float rr = radians(r0);
    float lonv = atan(v.x, v.z);
    vr = vec3(cos(rr) * sin(lonv), sin(rr), cos(rr) * cos(lonv));
  }
  float alpha = 1.0;
  if (uMaskOn.x > 0.5) {
    float ml = atan(v.x, v.z) / PI;
    float mt = asin(clamp(v.y, -1.0, 1.0)) / (PI * 0.5);
    alpha = texture2D(uMask, vec2((ml + 1.0) * 0.5, (mt + 1.0) * 0.5)).a;
    if (uMaskOn.y > 0.5) alpha = 1.0 - alpha;
  }
  if (uInput == 1) {
    vec3 col = stitchAt(v);
    if (nw > 0.0) col = mix(col, stitchAt(vr), nw);
    gl_FragColor = vec4(col, alpha);
    return;
  }
  vec3 ce = equiAt(v);
  if (nw > 0.0) ce = mix(ce, equiAt(vr), nw);
  gl_FragColor = vec4(ce, alpha);
}`;

/** Rohvideo mit zwei Fischaugen nebeneinander: Zusammensetz-Einstellungen; `swap` = Bildhälften andersherum. */
export interface FisheyeInput { stitch: StitchSettings; swap?: boolean; disp?: Uint8Array }

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
  private dispTex: WebGLTexture | null = null;
  private maskTex: WebGLTexture | null = null;
  private lastMask: unknown = null;

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
    for (const n of ['uInput', 'uL0', 'uL1', 'uG', 'uRect0', 'uRect1', 'uK0', 'uK1', 'uGain0', 'uGain1', 'uBlend', 'uCover', 'uNadir', 'uSeam', 'uMaskOn']) this.u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uDisp'), 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'uMask'), 2);
    this.maskTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);
    this.dispTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, SEAM_BINS, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(SEAM_BINS).fill(128));
    gl.activeTexture(gl.TEXTURE0);
    this.program = prog;
  }

  /**
   * Rendert eine Ansicht. `source` ist das Equirectangular-Bild (Video/Bild), Ausgabe hat `outW`×`outH` Pixel.
   * Mit `fisheye` ist `source` ein Rohvideo mit zwei Fischaugen nebeneinander (wird direkt hier zusammengesetzt).
   */
  render(source: TexImageSource, outW: number, outH: number, mode: PanoMode, view: PanoView, sourceTime: number, fisheye?: FisheyeInput, preRot?: number[], nadir?: { size: number; feather: number }, mask?: TexImageSource | null): HTMLCanvasElement | null {
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
    // Stabilisierung: Gegendrehung vor die Ansicht (Blick → stabilisierte Welt → Panorama)
    const m = preRot ? mul3(preRot, panoMatrix(view.yaw, view.pitch, view.roll)) : panoMatrix(view.yaw, view.pitch, view.roll);
    gl.uniform2f(this.u.uNadir, nadir ? 90 - nadir.size : 999, nadir ? Math.max(0.01, nadir.feather) : 1);
    if (mask) {
      if (mask !== this.lastMask) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask); } catch { /* ignorieren */ }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        this.lastMask = mask;
      }
      gl.uniform2f(this.u.uMaskOn, 1, 0);
    } else gl.uniform2f(this.u.uMaskOn, 0, 0);
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
      if (fisheye.disp) {
        const { t0, t1 } = seamTaper(st);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEAM_BINS, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, fisheye.disp);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform3f(this.u.uSeam, 1, t0, t1);
      } else gl.uniform3f(this.u.uSeam, 0, 1, 2);
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
