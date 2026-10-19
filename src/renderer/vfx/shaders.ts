// GLSL-Shader der Effekt-Simulationen (WebGL 1). Jeder Effekt liefert eine Farbe mit vormultipliziertem Alpha
// (`effect`) und – für leuchtende Effekte – einen Lichtschein (`light`), der per „Negativ multiplizieren“ auf die Szene fällt.
// Alle Animationen, die sich wiederholen dürfen, sind periodisch mit der Dauer uDur (nahtlose Schleife).
import type { VfxKind } from '@shared/types';

export const VERT = `
attribute vec2 aPos; varying vec2 vUv;
void main() { vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

const COMMON = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime, uDur, uSeed, uSize, uIntensity, uSpeed, uWind, uSmoke, uHasColor, uLightScale;
uniform vec3 uColor;
#define PI 3.14159265

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1.0, 0.0, 0.0)), c = hash13(i + vec3(0.0, 1.0, 0.0)), d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0)), f1 = hash13(i + vec3(1.0, 0.0, 1.0)), g = hash13(i + vec3(0.0, 1.0, 1.0)), h = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float fbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise2(p); p = p * 2.02 + vec2(1.3, 7.1); a *= 0.5; } return s; }
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.4); a *= 0.5; } return s; }
float fbm3s(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * noise3(p); p = p * 2.07 + vec3(4.1, 2.3, 8.7); a *= 0.5; } return s / 0.875; }

// Temperatur → Farbe (schwarz → dunkelrot → orange → gelb → weiß)
vec3 fireRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.0), vec3(0.42, 0.03, 0.0), smoothstep(0.0, 0.25, t));
  c = mix(c, vec3(1.0, 0.30, 0.03), smoothstep(0.2, 0.5, t));
  c = mix(c, vec3(1.0, 0.70, 0.20), smoothstep(0.45, 0.75, t));
  c = mix(c, vec3(1.0, 0.95, 0.82), smoothstep(0.75, 1.0, t));
  if (uHasColor > 0.5) {
    float l = dot(c, vec3(0.3, 0.5, 0.2));
    c = mix(c, uColor * l * 1.7 + vec3(smoothstep(0.8, 1.0, t)) * 0.5, 0.85);
  }
  return c;
}

// Koordinaten: Höhe -1..1 (y nach oben), Breite nach Seitenverhältnis
vec2 boxCoord() { return vec2((vUv.x - 0.5) * uRes.x / uRes.y, 0.5 - vUv.y) * 2.0; }

// Funken/Trümmer: Teilchen mit Schwerkraft. burst = alle auf einmal (Explosion), sonst gleichmäßig (Schleife mit Periode T)
vec4 sparksField(vec2 P, vec2 origin, float t, float T, float count, float spread, float speed, float burst, float lifeK) {
  vec3 col = vec3(0.0); float a = 0.0;
  for (int i = 0; i < 72; i++) {
    float fi = float(i);
    if (fi >= count) break;
    float h1 = hash11(fi * 7.13 + uSeed * 13.7), h2 = hash11(fi * 3.71 + uSeed * 5.3), h3 = hash11(fi * 11.9 + uSeed * 0.77);
    float life = (0.55 + h2 * 0.9) * lifeK;
    float age = burst > 0.5 ? t - h3 * 0.08 : mod(t - h3 * T, T);
    if (age < 0.0 || age > life) continue;
    float ang = burst > 0.5 ? (0.15 + h1 * 0.7) * PI + (hash11(fi * 1.7) - 0.5) * 0.9 : PI * 0.5 + (h1 - 0.5) * spread;
    float sp = (0.45 + h2 * 1.1) * speed;
    vec2 v = vec2(cos(ang), sin(ang)) * sp;
    vec2 g = vec2(uWind * 0.5, -1.7);
    float a0 = max(0.0, age - 0.06);
    vec2 p1 = origin + v * age + 0.5 * g * age * age;
    vec2 p0 = origin + v * a0 + 0.5 * g * a0 * a0;
    vec2 pa = P - p0, ba = p1 - p0;
    float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-7), 0.0, 1.0);
    float d = length(pa - ba * hh);
    float fade = 1.0 - age / life;
    float w = (0.009 + 0.006 * h2) * (0.6 + 0.4 * uSize);
    float k = (1.0 - smoothstep(w * 0.35, w, d)) * fade;
    float glow = exp(-d * d / (w * w * 25.0)) * 0.45 * fade;
    vec3 c = fireRamp(0.5 + 0.5 * fade);
    col += c * (k * 1.6 + glow);
    a = max(a, k + glow * 0.6);
  }
  return vec4(col, clamp(a, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------- Explosion
const EXPLOSION = `
vec2 fireballCenter(float t) {
  float rise = 0.38 * (1.0 - exp(-t * 0.55));
  return vec2(uWind * 0.1 * t, -0.32 + rise);
}
float fireballRadius(float t) { return max(0.015, 0.42 * (1.0 - exp(-t * 4.0)) + 0.1 * min(t, 3.0)); }
vec4 effect() {
  vec2 P = boxCoord();
  float t = uTime * uSpeed, T = uDur * uSpeed;
  vec2 c = fireballCenter(t);
  float R = fireballRadius(t);
  float heat = clamp(1.15 * exp(-t * 0.5 / max(0.4, uIntensity)) - 0.15 * smoothstep(0.8, 2.5, t), 0.0, 1.0);
  float life = 1.0 - smoothstep(T * 0.55, T, t);
  vec2 q2 = P - c;
  q2.y /= 1.0 + 0.06 * min(t, 2.0);
  vec3 col = vec3(0.0); float acc = 0.0;
  float smokeK = mix(0.7, 1.5, clamp(uSmoke, 0.0, 2.0) * 0.5);
  vec3 L = normalize(vec3(-0.5, 0.8, -0.4));
  if (length(q2) < R * 1.75) {
    for (int i = 0; i < 30; i++) {
      float z = (float(i) + 0.5) / 30.0 * 2.0 - 1.0;
      vec3 q = vec3(q2, z * R * 1.35);
      float d = length(q) / R;
      if (d > 1.7) continue;
      vec3 np = q / R * 2.3 + vec3(0.0, -t * 0.45, t * 0.2) + vec3(uSeed * 3.17, uSeed * 1.31, uSeed * 0.71);
      float w = fbm3s(np * 0.5);
      float n = fbm3(np + w * 1.3);
      // Oberfläche wie Blumenkohl: Kugel, verschoben durch Rauschen
      float disp = (n - 0.5) * 0.95;
      float dens = smoothstep(1.02 + disp, 0.72 + disp, d);
      if (dens < 0.002) continue;
      float core = smoothstep(1.0, 0.15, d - disp * 0.5);
      float temp = heat * clamp(core * (0.3 + 1.25 * n * n * 1.6), 0.0, 1.0);
      // Selbstschatten (Licht von oben links)
      float nl = fbm3s(np + L * 0.35);
      float shade = clamp(0.5 + (n - nl) * 4.5 + q.y / R * 0.25, 0.1, 1.2);
      vec3 smokeCol = mix(vec3(0.08, 0.07, 0.065), vec3(0.3, 0.27, 0.25), clamp(t * 0.35, 0.0, 1.0)) * shade;
      smokeCol += fireRamp(temp * 0.85 + 0.1) * 0.45 * heat * (1.0 - core * 0.3);
      vec3 em = fireRamp(temp) * pow(temp, 0.9) * 4.0;
      float a = dens * (2.0 / 30.0) * 3.4 * smokeK * mix(1.0, 0.5, smoothstep(0.25, 0.7, temp));
      vec3 c3 = smokeCol * (1.0 - smoothstep(0.3, 0.8, temp)) + em;
      col += (1.0 - acc) * a * c3;
      acc += (1.0 - acc) * a;
      if (acc > 0.995) break;
    }
  }
  // Blitz im ersten Moment
  float flash = exp(-t * 11.0) * smoothstep(0.0, 0.02, t) * uIntensity;
  float fd = length(P - vec2(0.0, -0.32));
  float fl = exp(-fd * fd / (0.03 + 0.3 * t));
  col += vec3(1.0, 0.93, 0.78) * flash * fl * 1.5;
  acc = max(acc, clamp(flash * fl * 1.2, 0.0, 1.0));
  // Trümmer und Funken
  vec4 sp = sparksField(P, vec2(0.0, -0.32), t, T, 46.0 * uIntensity, 0.0, 2.0, 1.0, 1.0);
  col += sp.rgb * (1.0 - acc * 0.7);
  acc = max(acc, sp.a);
  // weich ausblenden und Ränder der Fläche nie hart abschneiden
  float edge = smoothstep(1.0, 0.86, max(abs(P.x) * uRes.y / uRes.x, abs(P.y)));
  col *= life * edge; acc *= life * edge;
  return vec4(col, acc);
}
vec3 light() {
  vec2 P = boxCoord() * uLightScale;
  float t = uTime * uSpeed;
  vec2 c = fireballCenter(t);
  float heat = clamp(1.15 * exp(-t * 0.5 / max(0.4, uIntensity)) - 0.15 * smoothstep(0.8, 2.5, t), 0.0, 1.0);
  float flash = exp(-t * 12.0) * smoothstep(0.0, 0.02, t);
  float flicker = 0.85 + 0.15 * noise2(vec2(t * 9.0, uSeed));
  float Lv = (flash * 0.9 + heat * 0.75 * flicker) * uIntensity;
  float d = length(P - c);
  float sigma = 1.0 + 0.6 * min(t, 1.0);
  vec3 col = fireRamp(0.6 + 0.25 * heat) * Lv * (0.6 * exp(-d * d / (sigma * sigma)) + 0.4 * exp(-d * d / 7.5));
  col += vec3(1.0, 0.95, 0.85) * flash * 0.35 * exp(-d * d / 5.0);
  return col;
}
`;

// ---------------------------------------------------------------- Feuer
const FIRE = `
float fireNoise(vec2 q, float t) {
  vec2 p = vec2(q.x * 2.7, q.y * 1.9 - t * 2.3);
  float w1 = fbm2(p * 0.8 + vec2(0.0, -t * 0.7) + uSeed * 2.1);
  return fbm2(p + vec2(w1 * 1.3, w1 * 0.9) + uSeed * 1.3);
}
vec4 effect() {
  vec2 P = boxCoord();
  float t = uTime * uSpeed, T = uDur * uSpeed;
  float ph = fract(uTime / uDur);
  vec2 q = P; q.y += 0.9;
  q.x -= uWind * 0.2 * q.y * q.y;
  float n = mix(fireNoise(q, t), fireNoise(q, t - T), ph);
  float n2 = mix(fbm2(vec2(q.x * 6.0, q.y * 4.0 - t * 4.5) + uSeed * 3.3), fbm2(vec2(q.x * 6.0, q.y * 4.0 - (t - T) * 4.5) + uSeed * 3.3), ph);
  float h = clamp(q.y / (1.35 + 0.2 * uIntensity), 0.0, 1.2);
  float w = (0.42 + 0.1 * uIntensity) * (1.0 - 0.55 * h);
  float base = 1.0 - smoothstep(0.0, w, abs(q.x + (n2 - 0.5) * 0.12 * h));
  float vertical = clamp(1.0 - h, 0.0, 1.0);
  // Rauschen multiplizieren statt addieren → einzelne, flackernde Flammenzungen
  float flame = base * (0.35 + vertical * 0.9) * pow(n * 1.75, 2.2) * (0.75 + 0.5 * n2) - h * 0.32;
  flame = clamp(flame * 1.25, 0.0, 1.0) * smoothstep(-0.04, 0.06, q.y);
  float temp = clamp(pow(flame, 0.85) * (1.05 - h * 0.35), 0.0, 1.0);
  vec3 col = fireRamp(temp * 0.93) * (0.6 + 1.3 * temp);
  float a = smoothstep(0.04, 0.5, flame);
  vec4 res = vec4(col * a, a);
  // Rauch über der Flamme
  if (uSmoke > 0.01) {
    vec2 s = q; s.x -= uWind * 0.3 * (s.y - 0.8) * (s.y - 0.8);
    float sn = mix(fbm2(vec2(s.x * 2.8, s.y * 1.9 - t * 0.8) + uSeed), fbm2(vec2(s.x * 2.8, s.y * 1.9 - (t - T) * 0.8) + uSeed), ph);
    float sw = 0.1 + 0.32 * clamp(s.y - 0.7, 0.0, 2.0);
    float sd = (1.0 - smoothstep(sw * 0.3, sw, abs(s.x) + (sn - 0.5) * 0.35)) * smoothstep(0.75, 1.15, s.y) * (1.0 - smoothstep(1.55, 1.95, s.y));
    float sa = clamp(sd * (sn * 1.6 - 0.25), 0.0, 1.0) * 0.6 * uSmoke;
    vec3 sc = vec3(0.12, 0.11, 0.11) * (0.6 + 0.7 * sn);
    res.rgb += (1.0 - res.a) * sc * sa;
    res.a += (1.0 - res.a) * sa;
  }
  // Glut-Funken
  vec4 sp = sparksField(P, vec2(0.0, -0.65), t, T, 16.0 * uIntensity, 1.0, 1.1, 0.0, 1.3);
  res.rgb += sp.rgb * 0.9 * (1.0 - res.a * 0.8);
  res.a = max(res.a, sp.a * 0.85);
  float edge = smoothstep(1.0, 0.88, max(abs(P.x) * uRes.y / uRes.x, abs(P.y)));
  return res * edge;
}
vec3 light() {
  vec2 P = boxCoord() * uLightScale;
  float t = uTime * uSpeed, T = uDur * uSpeed;
  float ph = fract(uTime / uDur);
  float fl = mix(noise2(vec2(t * 7.0, uSeed)), noise2(vec2((t - T) * 7.0, uSeed)), ph);
  float L = (0.55 + 0.3 * fl) * uIntensity;
  float d = length(P - vec2(0.0, -0.35));
  return fireRamp(0.6) * L * (0.6 * exp(-d * d / 1.2) + 0.4 * exp(-d * d / 5.0));
}
`;

// ---------------------------------------------------------------- Rauch
const SMOKE = `
float smokeDensity(vec3 q, float t) {
  vec3 np = vec3(q.x * 3.0, q.y * 3.0 - t * 0.75, q.z * 3.0) + vec3(uSeed * 2.3, uSeed * 0.9, uSeed * 1.7);
  float w = fbm3s(np * 0.6);
  return fbm3(np + w * 1.2);
}
vec4 effect() {
  vec2 P = boxCoord();
  float t = uTime * uSpeed, T = uDur * uSpeed;
  float ph = fract(uTime / uDur);
  vec3 acc3 = vec3(0.0); float acc = 0.0;
  vec3 base = uHasColor > 0.5 ? uColor : vec3(0.62, 0.62, 0.63);
  for (int i = 0; i < 22; i++) {
    float z = ((float(i) + 0.5) / 22.0 * 2.0 - 1.0) * 0.6;
    vec3 q = vec3(P.x, P.y + 0.92, z);
    q.x -= uWind * 0.28 * q.y * q.y;
    float rad = 0.08 + 0.34 * clamp(q.y, 0.0, 2.0);
    float d = length(q.xz) / rad;
    if (d > 1.8) continue;
    float n = mix(smokeDensity(q, t), smokeDensity(q, t - T), ph);
    float disp = (n - 0.5) * 1.1;
    float dens = smoothstep(1.0 + disp, 0.55 + disp, d);
    dens *= smoothstep(-0.02, 0.12, q.y) * (1.0 - smoothstep(1.3, 1.9, q.y + (n - 0.5) * 0.5));
    if (dens < 0.002) continue;
    float shade = clamp(0.35 + (n - 0.35) * 1.4 - q.x * 0.25 + (q.y - 0.8) * 0.1, 0.18, 1.15);
    vec3 c = base * shade;
    float a = dens * 0.24 * uIntensity;
    acc3 += (1.0 - acc) * a * c;
    acc += (1.0 - acc) * a;
  }
  return vec4(acc3, acc);
}
vec3 light() { return vec3(0.0); }
`;

// ---------------------------------------------------------------- Schnee (ganzes Bild)
const SNOW = `
vec4 effect() {
  float t = uTime, T = uDur;
  float aspect = uRes.x / uRes.y;
  vec2 uv = vec2(vUv.x * aspect, vUv.y);
  vec4 acc = vec4(0.0);
  for (int l = 0; l < 4; l++) {
    float fl = float(l);
    float depth = 1.0 - fl / 3.0;                       // 1 = nah
    float cells = mix(4.0, 16.0, fl / 3.0) / uSize;
    float v = mix(0.3, 0.1, fl / 3.0) * uSpeed;         // Fallgeschwindigkeit (Bildhöhen/s)
    float k = max(1.0, floor(v * T * cells + 0.5));     // ganze Zellen pro Schleife → nahtlos
    vec2 g = uv * cells;
    g.y -= k * t / T;
    float kw = floor(uWind * 0.5 * T * cells / aspect + 0.5);
    g.x -= kw * t / T;
    vec2 id = floor(g); vec2 f = fract(g);
    float r = hash12(id + fl * 17.31 + uSeed);
    if (r > 0.3 + 0.55 * min(uIntensity, 1.6) / 1.6) continue;
    vec2 c = 0.3 + 0.4 * hash22(id + fl * 3.7 + uSeed);
    float m = max(1.0, floor(T / 2.6 + 0.5));
    c.x += 0.15 * sin(2.0 * PI * m * t / T + r * 37.0);
    float rad = mix(0.05, 0.14, depth) * (0.6 + 0.6 * hash12(id + 5.1));
    float blur = mix(0.35, 0.9, depth * depth);
    float d = length(f - c);
    float flake = 1.0 - smoothstep(rad * (1.0 - blur), rad, d);
    float alpha = flake * mix(0.55, 0.9, depth);
    acc.rgb += (1.0 - acc.a) * vec3(0.97, 0.98, 1.0) * alpha;
    acc.a += (1.0 - acc.a) * alpha;
  }
  float haze = 0.05 * uIntensity;
  acc.rgb += (1.0 - acc.a) * vec3(0.86, 0.9, 1.0) * haze;
  acc.a += (1.0 - acc.a) * haze;
  return acc;
}
vec3 light() { return vec3(0.0); }
`;

// ---------------------------------------------------------------- Regen (ganzes Bild)
const RAIN = `
vec4 effect() {
  float t = uTime, T = uDur;
  float aspect = uRes.x / uRes.y;
  vec4 acc = vec4(0.0);
  for (int l = 0; l < 4; l++) {
    float fl = float(l);
    float depth = 1.0 - fl / 3.0;
    vec2 uv = vec2(vUv.x * aspect + uWind * 0.35 * vUv.y, vUv.y);
    float cx = mix(28.0, 90.0, fl / 3.0) * uSize;
    float cy = mix(2.2, 4.5, fl / 3.0);
    float v = mix(2.6, 1.6, fl / 3.0) * uSpeed;
    float k = max(1.0, floor(v * T * cy + 0.5));
    vec2 g = vec2(uv.x * cx, uv.y * cy);
    g.y -= k * t / T;
    vec2 id = floor(g); vec2 f = fract(g);
    float r = hash12(id + fl * 11.7 + uSeed);
    if (r > 0.25 + 0.45 * min(uIntensity, 1.6) / 1.6) continue;
    float x0 = 0.2 + 0.6 * hash12(id + 3.3);
    float len = 0.3 + 0.35 * hash12(id + 7.7);
    float y0 = hash12(id + 9.1) * (1.0 - len);
    float wpx = 0.8 + 1.4 * depth;
    float w = wpx * cx / uRes.y / aspect;
    float across = 1.0 - smoothstep(w * 0.3, w, abs(f.x - x0));
    float along = smoothstep(y0, y0 + len * 0.25, f.y) * (1.0 - smoothstep(y0 + len * 0.7, y0 + len, f.y));
    float alpha = across * along * mix(0.16, 0.42, depth);
    acc.rgb += (1.0 - acc.a) * vec3(0.78, 0.84, 0.9) * alpha;
    acc.a += (1.0 - acc.a) * alpha;
  }
  float veil = 0.16 * uIntensity;
  acc.rgb += (1.0 - acc.a) * vec3(0.05, 0.07, 0.09) * veil;
  acc.a += (1.0 - acc.a) * veil;
  return acc;
}
vec3 light() { return vec3(0.0); }
`;

// ---------------------------------------------------------------- Nebel (ganzes Bild)
const FOG = `
float fogField(vec2 p, float t) {
  vec2 dir = vec2(0.06 + uWind * 0.12, 0.01);
  float a = fbm2(p * 1.1 + dir * t * 3.0 + uSeed);
  float b = fbm2(p * 2.3 - dir * t * 1.7 + uSeed * 1.9);
  return a * 0.7 + b * 0.3;
}
vec4 effect() {
  float t = uTime, T = uDur;
  float ph = fract(uTime / uDur);
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y) * 1.8 / uSize;
  float n = mix(fogField(p, t * uSpeed), fogField(p, (t - T) * uSpeed), ph);
  float ground = smoothstep(0.0, 1.0, vUv.y);
  float dens = clamp((n - 0.2) * 1.8, 0.0, 1.0) * (0.35 + 0.65 * ground);
  float a = clamp(dens * 0.8 * uIntensity + 0.16 * uIntensity, 0.0, 0.94);
  vec3 c = uHasColor > 0.5 ? uColor : vec3(0.82, 0.85, 0.88);
  c *= 0.9 + 0.2 * n;
  return vec4(c * a, a);
}
vec3 light() { return vec3(0.0); }
`;

// ---------------------------------------------------------------- Funken
const SPARKS = `
vec4 effect() {
  vec2 P = boxCoord();
  float t = uTime * uSpeed, T = uDur * uSpeed;
  vec4 sp = sparksField(P, vec2(0.0, -0.85), t, T, 70.0 * min(uIntensity, 1.0), 1.0, 2.6, 0.0, 1.0);
  float ph = fract(uTime / uDur);
  float fl = 0.8 + 0.2 * mix(noise2(vec2(t * 12.0, 1.0)), noise2(vec2((t - T) * 12.0, 1.0)), ph);
  float d = length(P - vec2(0.0, -0.85));
  float core = exp(-d * d / 0.004) * fl;
  vec3 col = sp.rgb + fireRamp(0.95) * core * 1.5;
  float a = max(sp.a, clamp(core * 1.2, 0.0, 1.0));
  return vec4(col, a);
}
vec3 light() {
  vec2 P = boxCoord() * uLightScale;
  float t = uTime * uSpeed, T = uDur * uSpeed;
  float ph = fract(uTime / uDur);
  float fl = 0.75 + 0.25 * mix(noise2(vec2(t * 12.0, 1.0)), noise2(vec2((t - T) * 12.0, 1.0)), ph);
  float d = length(P - vec2(0.0, -0.85));
  return fireRamp(0.75) * 0.45 * uIntensity * fl * (0.6 * exp(-d * d / 0.8) + 0.4 * exp(-d * d / 3.5));
}
`;

// ---------------------------------------------------------------- Blitz
const LIGHTNING = `
float strikeLevel(float t, float T, out float idx, out float since) {
  float best = 0.0; idx = 0.0; since = 99.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float st = T * (0.04 + 0.27 * fi) + hash11(fi * 3.1 + uSeed) * 0.12;
    float age = t - st;
    if (age < 0.0) continue;
    float b = exp(-age * 11.0) * (i == 0 ? 1.0 : 0.75) + exp(-age * 30.0) * 0.4 * step(0.07, age) ;
    if (age < since) { since = age; idx = fi; }
    best = max(best, b);
  }
  return best;
}
float boltX(float y, float s) {
  return (fbm2(vec2(y * 1.6, s)) - 0.5) * 0.7 + (noise2(vec2(y * 9.0, s * 3.0)) - 0.5) * 0.14 + (noise2(vec2(y * 38.0, s * 5.0)) - 0.5) * 0.035;
}
vec4 effect() {
  vec2 P = boxCoord();
  float t = uTime * uSpeed, T = uDur * uSpeed;
  float idx, since;
  float br = strikeLevel(t, T, idx, since) * uIntensity;
  if (br < 0.003) return vec4(0.0);
  float s = uSeed + idx * 7.3;
  float reveal = 1.0 - clamp(since * 30.0, 0.0, 1.0) * 2.0;      // Blitz wächst von oben nach unten
  float visible = smoothstep(reveal - 0.06, reveal, P.y);
  float x = boltX(P.y, s);
  float d = abs(P.x - x);
  float core = exp(-d * d / 0.00012) + exp(-d * d / 0.0012) * 0.5;
  float glow = exp(-d * d / 0.012) * 0.45 + exp(-d * d / 0.12) * 0.15;
  // Verästelungen
  for (int b = 0; b < 3; b++) {
    float fb = float(b);
    float yb = 0.55 - fb * 0.45 + hash11(s + fb) * 0.2;
    if (P.y > yb) continue;
    float len = 0.25 + 0.35 * hash11(s * 1.3 + fb);
    float u = (yb - P.y) / len;
    if (u > 1.0) continue;
    float dir = hash11(s * 2.1 + fb) > 0.5 ? 1.0 : -1.0;
    float xb = boltX(yb, s) + dir * (yb - P.y) * (0.5 + 0.4 * hash11(fb + s)) + (noise2(vec2(P.y * 14.0, s + fb)) - 0.5) * 0.06;
    float db = abs(P.x - xb);
    float fade = 1.0 - u;
    core += (exp(-db * db / 0.00007) * 0.8) * fade;
    glow += exp(-db * db / 0.006) * 0.25 * fade;
  }
  vec3 tint = uHasColor > 0.5 ? uColor : vec3(0.62, 0.72, 1.0);
  vec3 col = (vec3(1.0) * core * 1.3 + tint * glow) * br * visible;
  float a = clamp((core + glow * 0.8) * br * visible, 0.0, 1.0);
  return vec4(col, a);
}
vec3 light() {
  vec2 P = boxCoord() * uLightScale;
  float t = uTime * uSpeed, T = uDur * uSpeed;
  float idx, since;
  float br = strikeLevel(t, T, idx, since) * uIntensity;
  vec3 tint = uHasColor > 0.5 ? uColor : vec3(0.7, 0.78, 1.0);
  float d = length(P);
  return tint * br * (0.55 * exp(-d * d / 4.0) + 0.3 * exp(-d * d / 12.0));
}
`;

// ---------------------------------------------------------------- Staub (ganzes Bild)
const DUST = `
vec4 effect() {
  float t = uTime, T = uDur;
  float ph = fract(uTime / uDur);
  float aspect = uRes.x / uRes.y;
  vec2 uv = vec2(vUv.x * aspect, vUv.y);
  vec3 dustCol = uHasColor > 0.5 ? uColor : vec3(0.78, 0.66, 0.5);
  // wehender Schleier
  vec2 dir = vec2(0.15 + uWind * 0.35, -0.02);
  float n = mix(fbm2(uv * 2.2 - dir * t * uSpeed + uSeed), fbm2(uv * 2.2 - dir * (t - T) * uSpeed + uSeed), ph);
  float veil = clamp((n - 0.3) * 1.6, 0.0, 1.0) * 0.5 * uIntensity + 0.1 * uIntensity;
  vec4 acc = vec4(dustCol * veil, veil);
  // Körnchen
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float depth = 1.0 - fl / 2.0;
    float cells = mix(14.0, 40.0, fl / 2.0) / uSize;
    float kx = max(1.0, floor((0.12 + 0.25 * abs(uWind + 0.4)) * uSpeed * T * cells / aspect + 0.5)) * sign(uWind + 0.4);
    float ky = floor(0.04 * T * cells + 0.5);
    vec2 g = uv * cells - vec2(kx, -ky) * t / T;
    vec2 id = floor(g); vec2 f = fract(g);
    if (hash12(id + fl * 9.1 + uSeed) > 0.35 * min(uIntensity, 1.6)) continue;
    vec2 c = 0.25 + 0.5 * hash22(id + fl);
    float rad = mix(0.05, 0.12, depth);
    float a = (1.0 - smoothstep(rad * 0.3, rad, length(f - c))) * mix(0.4, 0.8, depth);
    acc.rgb += (1.0 - acc.a) * dustCol * 1.1 * a;
    acc.a += (1.0 - acc.a) * a;
  }
  return acc;
}
vec3 light() { return vec3(0.0); }
`;

// ---------------------------------------------------------------- Konfetti (ganzes Bild)
const CONFETTI = `
vec3 confettiColor(float h) {
  if (h < 0.17) return vec3(1.0, 0.25, 0.35);
  if (h < 0.34) return vec3(1.0, 0.8, 0.15);
  if (h < 0.5) return vec3(0.2, 0.75, 1.0);
  if (h < 0.67) return vec3(0.35, 0.9, 0.4);
  if (h < 0.84) return vec3(0.8, 0.4, 1.0);
  return vec3(1.0, 0.55, 0.15);
}
vec4 effect() {
  float t = uTime, T = uDur;
  float aspect = uRes.x / uRes.y;
  vec2 uv = vec2(vUv.x * aspect, vUv.y);
  vec4 acc = vec4(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float depth = 1.0 - fl / 2.0;
    float cells = mix(5.0, 11.0, fl / 2.0) / uSize;
    float v = mix(0.28, 0.16, fl / 2.0) * uSpeed;
    float k = max(1.0, floor(v * T * cells + 0.5));
    vec2 g = uv * cells; g.y -= k * t / T;
    float kw = floor(uWind * 0.4 * T * cells / aspect + 0.5); g.x -= kw * t / T;
    vec2 id = floor(g); vec2 f = fract(g);
    float r = hash12(id + fl * 5.3 + uSeed);
    if (r > 0.3 + 0.4 * min(uIntensity, 1.6) / 1.6) continue;
    vec2 c = 0.3 + 0.4 * hash22(id + fl * 2.1 + uSeed);
    float m = max(1.0, floor(T / 1.3 + 0.5));
    float rot = 2.0 * PI * (m * t / T + r * 3.0) * (hash12(id + 2.2) > 0.5 ? 1.0 : -1.0);
    vec2 d = f - c;
    float cr = cos(rot), sr = sin(rot);
    d = vec2(cr * d.x - sr * d.y, sr * d.x + cr * d.y);
    float flip = abs(cos(2.0 * PI * m * 2.0 * t / T + r * 10.0)) * 0.85 + 0.15;
    vec2 sz = vec2(0.13 * flip, 0.07) * mix(0.6, 1.0, depth);
    vec2 e = smoothstep(sz, sz * 0.7, abs(d));
    float a = e.x * e.y * mix(0.75, 1.0, depth);
    vec3 col = confettiColor(hash12(id + 8.8)) * (0.75 + 0.25 * flip);
    acc.rgb += (1.0 - acc.a) * col * a;
    acc.a += (1.0 - acc.a) * a;
  }
  return acc;
}
vec3 light() { return vec3(0.0); }
`;

// ---------------------------------------------------------------- Aufprall (Staubwolke, Druckwelle, Trümmer)
const IMPACT = `
float impactDensity(vec3 q, float t) {
  vec3 np = q * vec3(2.6, 3.2, 2.6) + vec3(uSeed * 1.7, -t * 0.25, uSeed * 0.6 + t * 0.15);
  float w = fbm3s(np * 0.7);
  return fbm3(np + w * 1.3);
}
vec4 effect() {
  vec2 P = boxCoord();
  float t = uTime * uSpeed, T = uDur * uSpeed;
  vec2 G = vec2(0.0, -0.55);                     // Aufprallpunkt am Boden
  vec3 dustCol = uHasColor > 0.5 ? uColor : vec3(0.72, 0.64, 0.54);
  float I = clamp(uIntensity, 0.2, 2.0);
  float grow = 1.0 - exp(-t * 2.6);
  float R = (0.3 + 1.3 * grow) * uSize * (0.75 + 0.25 * I);                          // Breite der Wolke
  float Hh = (0.22 + 0.75 * (1.0 - exp(-t * 1.3))) * uSize * (0.7 + 0.3 * I);         // Höhe der Wolke
  float fade = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.45 * T, T, t));
  vec3 acc3 = vec3(0.0); float acc = 0.0;
  for (int i = 0; i < 18; i++) {
    float z = ((float(i) + 0.5) / 18.0 * 2.0 - 1.0) * R * 0.5;
    vec3 q = vec3(P.x - uWind * 0.25 * t * (0.3 + P.y - G.y), P.y - G.y, z);
    float n = impactDensity(q / max(0.4, uSize), t);
    float disp = (n - 0.5) * 0.95;
    // Kuppel aus Staub, unten breit; die Mitte ist etwas lichter (Druck schiebt den Staub nach außen)
    float e = length(vec3(q.x / max(R, 1e-3), q.y / max(Hh, 1e-3) * (0.75 + 0.25 * abs(q.x) / max(R, 1e-3)), q.z / max(R * 0.5, 1e-3)));
    float hollow = 0.55 + 0.45 * smoothstep(0.0, 0.55, length(vec2(q.x, q.z)) / max(R, 1e-3) + q.y / max(Hh, 1e-3) * 0.6);
    float dens = smoothstep(1.0 + disp, 0.62 + disp, e) * smoothstep(-0.12, 0.04, q.y) * hollow;
    if (dens < 0.003) continue;
    float hy = q.y / max(Hh, 1e-3);
    float shade = clamp(0.5 + 0.55 * hy + (n - 0.45) * 1.1 - q.x * 0.12, 0.22, 1.2);
    float a = dens * 0.3 * I * fade;
    acc3 += (1.0 - acc) * a * dustCol * shade;
    acc += (1.0 - acc) * a;
  }
  vec4 col = vec4(acc3, acc);
  // Druckwelle: dünner, heller Ring am Boden in den ersten Augenblicken
  if (t < 0.4) {
    float rw = t / 0.35 * 1.9 * uSize;
    vec2 d = vec2(P.x, (P.y - G.y) * 5.0);
    float ring = exp(-pow((length(d) - rw) / (0.03 + 0.05 * t), 2.0)) * (1.0 - t / 0.4) * 0.45 * min(I, 1.5);
    col.rgb += (1.0 - col.a) * min(vec3(1.0), dustCol * 1.3) * ring;
    col.a += (1.0 - col.a) * ring;
  }
  // Trümmer: dunkle Brocken fliegen in Bögen und bleiben am Boden liegen
  float cnt = 34.0 * I;
  for (int i = 0; i < 68; i++) {
    float fi = float(i);
    if (fi >= cnt) break;
    float h1 = hash11(fi * 7.31 + uSeed * 3.1), h2 = hash11(fi * 2.17 + uSeed * 9.4), h3 = hash11(fi * 5.9 + uSeed);
    float age = t - h3 * 0.05;
    if (age < 0.0) continue;
    float ang = (0.12 + 0.76 * h1) * PI;
    float sp = (0.6 + 1.5 * h2) * (0.6 + 0.4 * I) * uSize;
    vec2 v = vec2(cos(ang) * 1.3, sin(ang)) * sp;
    vec2 g = vec2(uWind * 0.4, -3.2);
    vec2 p = G + v * age + 0.5 * g * age * age;
    if (p.y < G.y - 0.04) continue;
    float r = (0.008 + 0.016 * h3) * uSize;
    float d = length(P - p);
    float k = (1.0 - smoothstep(r * 0.6, r, d)) * fade;
    vec3 c = dustCol * (0.35 + 0.25 * h2);
    col.rgb = mix(col.rgb, c, k);
    col.a = max(col.a, k);
  }
  return col;
}
vec3 light() { return vec3(0.0); }
`;

const KIND_SRC: Record<VfxKind, string> = {
  explosion: EXPLOSION, fire: FIRE, smoke: SMOKE, snow: SNOW, rain: RAIN, fog: FOG, sparks: SPARKS, lightning: LIGHTNING, dust: DUST, confetti: CONFETTI, impact: IMPACT,
};

/** Fragment-Shader für eine Effektart; `lightPass` = Lichtschein statt Effekt. */
export function fragmentSource(kind: VfxKind, lightPass: boolean): string {
  const main = lightPass
    ? `void main() {
        vec3 c = light();
        vec2 e = abs(vUv - 0.5) * 2.0;
        c *= smoothstep(1.0, 0.6, max(e.x, e.y));   // Schein läuft zum Rand weich aus (keine sichtbare Kante)
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`
    : `void main() {
        vec4 c = effect();
        // Leuchtende Stellen gelten als deckend (sonst ginge Helligkeit verloren); gespeichert wird gerades Alpha
        float a = clamp(max(c.a, max(c.r, max(c.g, c.b))), 0.0, 1.0);
        vec3 rgb = a > 0.0001 ? clamp(c.rgb / a, 0.0, 1.0) : vec3(0.0);
        gl_FragColor = vec4(rgb, a);
      }`;
  return `${COMMON}\n${KIND_SRC[kind]}\n${main}`;
}
