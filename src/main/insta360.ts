// Insta360-Datei-Anhang lesen (am Ende jeder .insv/.lrv): Kalibrierung, Bewegungsdaten (Gyro + Beschleunigung) und
// Zeitraffer-Zeitstempel. Aufbau nach dem freien telemetry-parser (MIT/Apache, github.com/AdrianEddy/telemetry-parser).
import fs from 'node:fs';

const MAGIC = '8db42d694ccc418790edff439fe026bf';
const HEADER = 32 + 4 + 4 + 32;

export interface InstaImu {
  model: string;
  t: Float64Array;        // Sekunden relativ zum ersten Videobild
  gyro: Float64Array;     // je 3 Werte, Grad/s, Achsen der Kamera-Elektronik
  acc: Float64Array;      // je 3 Werte, g
  timelapse?: number[];   // reale Zeitstempel je Bild (Zeitraffer), Sekunden
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}

/** Minimaler Protobuf-Leser: Feldnummer → Liste von Werten (Zahl oder Bytes). */
function protobuf(b: Buffer): Map<number, Array<number | Buffer>> {
  const out = new Map<number, Array<number | Buffer>>();
  let i = 0;
  const varint = (): number => { let r = 0, s = 1; for (;;) { const c = b[i++]; r += (c & 0x7f) * s; s *= 128; if (!(c & 0x80)) return r; } };
  while (i < b.length) {
    const key = varint(); const f = Math.floor(key / 8), wt = key % 8;
    let v: number | Buffer;
    if (wt === 0) v = varint();
    else if (wt === 1) { v = b.readDoubleLE(i); i += 8; }
    else if (wt === 2) { const l = varint(); v = b.subarray(i, i + l); i += l; }
    else if (wt === 5) { v = b.readFloatLE(i); i += 4; }
    else break;
    if (!out.has(f)) out.set(f, []);
    out.get(f)!.push(v);
  }
  return out;
}

export function readInstaImu(file: string, opts: { gyro?: boolean } = {}): InstaImu | null {
  const wantGyro = opts.gyro !== false;
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < HEADER + 16) return null;
    const head = readAt(fd, size - HEADER, HEADER);
    if (head.subarray(HEADER - 32).toString('latin1') !== MAGIC) return null;
    const extra = head.readUInt32LE(32);
    const start = size - extra;
    // erster Datensatz (von hinten): Inhaltsverzeichnis id 0 → Lage aller Datensätze
    const desc = readAt(fd, size - HEADER - 6, 6);
    const records = new Map<number, { off: number; size: number }>();
    if (desc[1] === 0) {
      const tsize = desc.readUInt32LE(2);
      const tbl = readAt(fd, size - HEADER - 6 - tsize, tsize);
      for (let k = 0; k + 10 <= tbl.length; k += 10) {
        const id = tbl[k], s = tbl.readUInt32LE(k + 2), o = tbl.readUInt32LE(k + 6);
        if (id) records.set(id, { off: o, size: s });
      }
    } else {
      // ältere Kameras: Datensätze hintereinander, jeweils mit 6-Byte-Kennung dahinter
      let pos = size - HEADER;
      while (pos - 6 > start) {
        const d = readAt(fd, pos - 6, 6);
        const id = d[1], s = d.readUInt32LE(2);
        if (s <= 0 || s > pos - 6 - start) break;
        records.set(id, { off: pos - 6 - s - start, size: s });
        pos = pos - 6 - s;
      }
    }
    const rec = (id: number) => { const r = records.get(id); return r ? readAt(fd, start + r.off, r.size) : null; };
    const metaBuf = rec(1);
    if (!metaBuf) return null;
    const meta = protobuf(metaBuf);
    const num = (f: number, d = 0) => { const v = meta.get(f)?.[0]; return typeof v === 'number' ? v : d; };
    const model = (meta.get(2)?.[0] as Buffer | undefined)?.toString('utf8') ?? 'Insta360';
    const fft = num(24);                 // erstes Videobild (µs bzw. ms je nach Kamera)
    const gts = num(28);                 // Gyro-Versatz
    const raw = num(62) === 1;
    let gyroRange = 2000, accRange = 16;
    const cfg = meta.get(65)?.[0];
    if (Buffer.isBuffer(cfg)) { const c = protobuf(cfg); accRange = Number(c.get(1)?.[0] ?? 16); gyroRange = Number(c.get(2)?.[0] ?? 2000); }
    const g = wantGyro ? rec(3) : Buffer.alloc(0);
    if (!g) return null;
    const item = raw ? 8 + 12 : 8 + 48;
    const n = Math.floor(g.length / item);
    const t = new Float64Array(n), gyro = new Float64Array(n * 3), acc = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * item;
      const ts = Number(g.readBigUInt64LE(o)) / 1000;
      if (raw) {
        t[i] = (ts - fft / 1000) / 1000 - gts / 1000;
        for (let k = 0; k < 3; k++) {
          acc[i * 3 + k] = (g.readUInt16LE(o + 8 + k * 2) - 32768) / (32768 / accRange);
          gyro[i * 3 + k] = (g.readUInt16LE(o + 14 + k * 2) - 32768) / (32768 / gyroRange);
        }
      } else {
        t[i] = ts - fft / 1000 - gts / 1000;
        for (let k = 0; k < 3; k++) {
          acc[i * 3 + k] = g.readDoubleLE(o + 8 + k * 8);
          gyro[i * 3 + k] = (g.readDoubleLE(o + 32 + k * 8) * 180) / Math.PI;
        }
      }
    }
    let timelapse: number[] | undefined;
    const tl = rec(6);
    if (tl && tl.length >= 16) {
      timelapse = [];
      for (let o = 0; o + 8 <= tl.length; o += 8) timelapse.push(Number(tl.readBigUInt64LE(o)) / 1000);
    }
    return { model, t, gyro, acc, timelapse };
  } catch {
    return null;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}
