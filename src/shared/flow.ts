// Bewegung zwischen zwei Bildern schätzen (für das Verfolgen von Masken): Lucas-Kanade mit Bildpyramide auf
// Merkmalspunkten in/um die Maske, daraus eine robuste Ähnlichkeits-Abbildung (Verschieben, Drehen, Größe),
// mit der die Maske ins nächste Bild gelegt wird. Reine Rechnung ohne Abhängigkeiten.

export interface Gray { data: Float32Array; width: number; height: number }

export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return { data: out, width, height };
}

function down(g: Gray): Gray {
  const w = Math.max(1, g.width >> 1), h = Math.max(1, g.height >> 1);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.min(g.width - 1, 2 * x), y0 = Math.min(g.height - 1, 2 * y);
    const x1 = Math.min(g.width - 1, x0 + 1), y1 = Math.min(g.height - 1, y0 + 1);
    out[y * w + x] = 0.25 * (g.data[y0 * g.width + x0] + g.data[y0 * g.width + x1] + g.data[y1 * g.width + x0] + g.data[y1 * g.width + x1]);
  }
  return { data: out, width: w, height: h };
}

export function pyramid(g: Gray, levels: number): Gray[] {
  const out = [g];
  for (let i = 1; i < levels; i++) out.push(down(out[i - 1]));
  return out;
}

function at(g: Gray, x: number, y: number): number {
  const xc = Math.max(0, Math.min(g.width - 1.001, x)), yc = Math.max(0, Math.min(g.height - 1.001, y));
  const x0 = Math.floor(xc), y0 = Math.floor(yc), fx = xc - x0, fy = yc - y0;
  const i = y0 * g.width + x0, w = g.width;
  return (g.data[i] * (1 - fx) + g.data[i + 1] * fx) * (1 - fy) + (g.data[i + w] * (1 - fx) + g.data[i + w + 1] * fx) * fy;
}

/** Punkte mit guter Struktur (kleinster Eigenwert der Gradienten-Matrix) in der Region `mask` (0..255, gleiche Größe). */
export function goodFeatures(g: Gray, mask: Uint8Array, max = 300, step = 6, win = 3): Array<[number, number]> {
  const cands: Array<{ x: number; y: number; s: number }> = [];
  const W = g.width, H = g.height, d = g.data;
  for (let y = win + 1; y < H - win - 1; y += step) for (let x = win + 1; x < W - win - 1; x += step) {
    if (mask[y * W + x] < 128) continue;
    let sxx = 0, syy = 0, sxy = 0;
    for (let v = -win; v <= win; v++) for (let u = -win; u <= win; u++) {
      const i = (y + v) * W + x + u;
      const gx = (d[i + 1] - d[i - 1]) * 0.5, gy = (d[i + W] - d[i - W]) * 0.5;
      sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
    }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const lmin = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    if (lmin > 20) cands.push({ x, y, s: lmin });
  }
  cands.sort((a, b) => b.s - a.s);
  return cands.slice(0, max).map((c) => [c.x, c.y]);
}

/** Pyramidaler Lucas-Kanade: Lage der Punkte im zweiten Bild (null = verloren). */
export function trackPoints(pa: Gray[], pb: Gray[], pts: Array<[number, number]>, win = 7, iters = 12): Array<[number, number] | null> {
  const L = pa.length;
  return pts.map(([px, py]) => {
    let gx = 0, gy = 0; // Verschiebung auf der aktuellen Stufe
    for (let l = L - 1; l >= 0; l--) {
      const A = pa[l], B = pb[l];
      const s = 1 / (1 << l);
      const x = px * s, y = py * s;
      gx *= 2; gy *= 2;
      if (l === L - 1) { gx = 0; gy = 0; }
      // Gradienten-Matrix im Fenster (Bild A)
      let sxx = 0, syy = 0, sxy = 0;
      const ix: number[] = [], iy: number[] = [], ia: number[] = [];
      for (let v = -win; v <= win; v++) for (let u = -win; u <= win; u++) {
        const ax = at(A, x + u + 1, y + v) - at(A, x + u - 1, y + v);
        const ay = at(A, x + u, y + v + 1) - at(A, x + u, y + v - 1);
        const dx = ax * 0.5, dy = ay * 0.5;
        ix.push(dx); iy.push(dy); ia.push(at(A, x + u, y + v));
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      const det = sxx * syy - sxy * sxy;
      if (det < 1e-3) return null;
      for (let it = 0; it < iters; it++) {
        let bx = 0, by = 0, k = 0;
        for (let v = -win; v <= win; v++) for (let u = -win; u <= win; u++, k++) {
          const diff = ia[k] - at(B, x + u + gx, y + v + gy);
          bx += diff * ix[k]; by += diff * iy[k];
        }
        const ux = (syy * bx - sxy * by) / det, uy = (sxx * by - sxy * bx) / det;
        gx += ux; gy += uy;
        if (ux * ux + uy * uy < 0.0009) break;
      }
    }
    const nx = px + gx, ny = py + gy;
    if (!isFinite(nx) || !isFinite(ny) || nx < 0 || ny < 0 || nx >= pa[0].width || ny >= pa[0].height) return null;
    return [nx, ny];
  });
}

/** Ähnlichkeits-Abbildung x' = s·R·x + t (a = s·cos, b = s·sin). */
export interface Similarity { a: number; b: number; tx: number; ty: number }

function fitSimilarity(src: Array<[number, number]>, dst: Array<[number, number]>): Similarity | null {
  const n = src.length;
  if (n < 2) return n === 1 ? { a: 1, b: 0, tx: dst[0][0] - src[0][0], ty: dst[0][1] - src[0][1] } : null;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sa = 0, sb = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - nx, v = dst[i][1] - ny;
    sa += x * u + y * v; sb += x * v - y * u; ss += x * x + y * y;
  }
  if (ss < 1e-9) return { a: 1, b: 0, tx: nx - mx, ty: ny - my };
  const a = sa / ss, b = sb / ss;
  return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) };
}

/** Robuste Schätzung (RANSAC mit Paaren, danach Ausgleich über alle passenden Punkte). */
export function robustSimilarity(src: Array<[number, number]>, dst: Array<[number, number]>, tol = 3, rounds = 120): { sim: Similarity; inliers: number } | null {
  const n = src.length;
  if (n === 0) return null;
  let best: number[] = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let r = 0; r < rounds && n >= 2; r++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (i === j) continue;
    const s = fitSimilarity([src[i], src[j]], [dst[i], dst[j]]);
    if (!s) continue;
    const scale = Math.hypot(s.a, s.b);
    if (scale < 0.7 || scale > 1.4) continue;
    const inl: number[] = [];
    for (let k = 0; k < n; k++) {
      const x = s.a * src[k][0] - s.b * src[k][1] + s.tx, y = s.b * src[k][0] + s.a * src[k][1] + s.ty;
      if (Math.hypot(x - dst[k][0], y - dst[k][1]) < tol) inl.push(k);
    }
    if (inl.length > best.length) best = inl;
  }
  if (best.length < Math.min(3, n)) best = src.map((_, k) => k);
  const sim = fitSimilarity(best.map((k) => src[k]), best.map((k) => dst[k]));
  return sim ? { sim, inliers: best.length } : null;
}

/** Maske (0..255) mit der Abbildung ins neue Bild legen (rückwärts abtasten, bilinear). `wrapX` = 360°-Bild (links/rechts verbunden). */
export function warpMask(mask: Uint8Array, W: number, H: number, s: Similarity, wrapX = false): Uint8Array {
  const out = new Uint8Array(W * H);
  const det = s.a * s.a + s.b * s.b;
  if (det < 1e-9) return out;
  // Umkehrung: x = R⁻¹(x' − t)/s
  const ia = s.a / det, ib = -s.b / det;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - s.tx, dy = y - s.ty;
    let sx = ia * dx - ib * dy, sy = ib * dx + ia * dy;
    if (sy < 0 || sy > H - 1) continue;
    if (wrapX) sx = ((sx % W) + W) % W; else if (sx < 0 || sx > W - 1) continue;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const x1 = wrapX ? (x0 + 1) % W : Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const v = (mask[y0 * W + x0] * (1 - fx) + mask[y0 * W + x1] * fx) * (1 - fy) + (mask[y1 * W + x0] * (1 - fx) + mask[y1 * W + x1] * fx) * fy;
    out[y * W + x] = v;
  }
  return out;
}

/** Rahmen um die Maske (Pixel) oder null, wenn leer. */
export function maskBox(mask: Uint8Array, W: number, H: number, thr = 128): { x0: number; y0: number; x1: number; y1: number; area: number } | null {
  let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mask[y * W + x] < thr) continue;
    area++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return area ? { x0, y0, x1, y1, area } : null;
}

/** Maske vergrößern (für den Suchbereich der Merkmale): einfache Quadrat-Dilatation um r Pixel. */
export function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let run = -1e9;
    for (let x = 0; x < W; x++) { if (mask[y * W + x] >= 128) run = x; if (x - run <= r) tmp[y * W + x] = 255; }
    run = 1e9;
    for (let x = W - 1; x >= 0; x--) { if (mask[y * W + x] >= 128) run = x; if (run - x <= r) tmp[y * W + x] = 255; }
  }
  for (let x = 0; x < W; x++) {
    let run = -1e9;
    for (let y = 0; y < H; y++) { if (tmp[y * W + x]) run = y; if (y - run <= r) out[y * W + x] = 255; }
    run = 1e9;
    for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) run = y; if (run - y <= r) out[y * W + x] = 255; }
  }
  return out;
}

/** Innere Punkte der Maske (weit weg vom Rand) als positive Hinweise für die KI. */
export function interiorPoints(mask: Uint8Array, W: number, H: number, n = 3): Array<[number, number]> {
  // Abstand zum Rand per zwei Durchläufen (Chamfer)
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] >= 128 ? INF : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) v = Math.min(v, d[i - W] + 1);
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!d[i]) continue;
    let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < H - 1) v = Math.min(v, d[i + W] + 1);
    d[i] = v;
  }
  const out: Array<[number, number]> = [];
  const used = new Uint8Array(W * H);
  for (let k = 0; k < n; k++) {
    let best = 0, bi = -1;
    for (let i = 0; i < d.length; i++) if (!used[i] && d[i] > best) { best = d[i]; bi = i; }
    if (bi < 0 || best < 2) break;
    const bx = bi % W, by = Math.floor(bi / W);
    out.push([bx, by]);
    // Umgebung sperren, damit die Punkte verteilt liegen
    const r = Math.max(4, best * 1.5);
    for (let y = Math.max(0, Math.floor(by - r)); y <= Math.min(H - 1, Math.ceil(by + r)); y++)
      for (let x = Math.max(0, Math.floor(bx - r)); x <= Math.min(W - 1, Math.ceil(bx + r)); x++) used[y * W + x] = 1;
  }
  return out;
}

/** Überschneidung zweier Masken (IoU, 0..1). */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { const x = a[k] >= 128, y = b[k] >= 128; if (x && y) i++; if (x || y) u++; }
  return u ? i / u : 0;
}
