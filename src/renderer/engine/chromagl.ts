// WebGL-Green-Screen für die Vorschau – rechnet wie FFmpegs `chromakey` (Abstand in der UV-Farbebene).
const VERT = `
attribute vec2 aPos; varying vec2 vUv;
void main() { vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex; uniform vec2 uKey; uniform float uSim; uniform float uBlend; uniform float uDespill; uniform vec3 uKeyRgb;
varying vec2 vUv;
vec2 toUv(vec3 c) {
  float u = -0.14713 * c.r - 0.28886 * c.g + 0.436 * c.b;
  float v = 0.615 * c.r - 0.51499 * c.g - 0.10001 * c.b;
  return vec2(u, v);
}
void main() {
  vec4 c = texture2D(uTex, vUv);
  vec2 uv = toUv(c.rgb);
  float diff = distance(uv, uKey) / 0.9;
  float a;
  if (uBlend > 0.0001) a = clamp((diff - uSim) / uBlend, 0.0, 1.0);
  else a = diff < uSim ? 0.0 : 1.0;
  vec3 rgb = c.rgb;
  if (uDespill > 0.5) {
    // Farbsaum entfernen: Schlüsselfarbe (z. B. Grün) auf den Mittelwert der anderen Kanäle begrenzen
    if (uKeyRgb.g >= uKeyRgb.r && uKeyRgb.g >= uKeyRgb.b) rgb.g = min(rgb.g, (rgb.r + rgb.b) * 0.5 + 0.02);
    else rgb.b = min(rgb.b, (rgb.r + rgb.g) * 0.5 + 0.02);
  }
  gl_FragColor = vec4(rgb * a, a);
}`;

export class ChromaGL {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private program: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
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
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const n of ['uKey', 'uSim', 'uBlend', 'uDespill', 'uKeyRgb']) this.loc[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    this.program = prog;
  }

  render(source: TexImageSource, w: number, h: number, color: string, similarity: number, blend: number, despill: boolean): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || !this.program) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source); } catch { return null; }
    const hex = color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
    const u = -0.14713 * r - 0.28886 * g + 0.436 * b;
    const v = 0.615 * r - 0.51499 * g - 0.10001 * b;
    gl.uniform2f(this.loc.uKey, u, v);
    gl.uniform1f(this.loc.uSim, Math.max(0.001, similarity));
    gl.uniform1f(this.loc.uBlend, Math.max(0, blend));
    gl.uniform1f(this.loc.uDespill, despill ? 1 : 0);
    gl.uniform3f(this.loc.uKeyRgb, r, g, b);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let chromaInstance: ChromaGL | null = null;
/** Für die Vorschau gemeinsam genutzte Instanz (spart WebGL-Kontexte). */
export function sharedChromaGL(): ChromaGL {
  if (!chromaInstance) chromaInstance = new ChromaGL();
  return chromaInstance;
}
