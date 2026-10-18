// Fügt 360°-Metadaten (Spherical Video V1, wie Googles "spatial-media") in eine MP4/MOV-Datei ein,
// damit YouTube, Facebook & Co. das Video als Panorama erkennen.
import fs from 'node:fs';

const UUID = Buffer.from('ffcc8263f8554a938814587a02521fdd', 'hex');
const XML = '<?xml version="1.0"?><rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">'
  + '<GSpherical:Spherical>true</GSpherical:Spherical><GSpherical:Stitched>true</GSpherical:Stitched>'
  + '<GSpherical:StitchingSoftware>PanoCut</GSpherical:StitchingSoftware><GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>'
  + '</rdf:SphericalVideo>';

interface Box { type: string; start: number; size: number; headerSize: number }

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < headerSize) break;
    boxes.push({ type, start: p, size, headerSize });
    p += size;
  }
  return boxes;
}

function findAll(buf: Buffer, start: number, end: number, type: string, out: Box[] = []): Box[] {
  for (const b of readBoxes(buf, start, end)) {
    if (b.type === type) out.push(b);
    if (CONTAINERS.has(b.type)) findAll(buf, b.start + b.headerSize, b.start + b.size, type, out);
  }
  return out;
}

function trakIsVideo(buf: Buffer, trak: Box): boolean {
  const hdlr = findAll(buf, trak.start + trak.headerSize, trak.start + trak.size, 'hdlr')[0];
  if (!hdlr) return false;
  const handler = buf.toString('latin1', hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12);
  return handler === 'vide';
}

/** Schreibt die Datei mit eingefügten Metadaten neu (in-place über eine temporäre Datei). */
export async function injectSphericalMetadata(filePath: string): Promise<void> {
  const fd = fs.openSync(filePath, 'r');
  const fileSize = fs.fstatSync(fd).size;
  let tmpReady: string | null = null;
  try {
    // Top-Level-Boxen finden
    const header = Buffer.alloc(16);
    let p = 0;
    let moov: Box | null = null;
    const top: Box[] = [];
    while (p + 8 <= fileSize) {
      fs.readSync(fd, header, 0, 16, p);
      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (size === 1) { size = Number(header.readBigUInt64BE(8)); headerSize = 16; }
      else if (size === 0) size = fileSize - p;
      const box = { type, start: p, size, headerSize };
      top.push(box);
      if (type === 'moov') moov = box;
      p += size;
    }
    if (!moov) throw new Error('Keine moov-Box gefunden');
    const moovBuf = Buffer.alloc(moov.size);
    fs.readSync(fd, moovBuf, 0, moov.size, moov.start);

    // Bereits vorhanden?
    if (moovBuf.includes(UUID)) return;

    const traks = readBoxes(moovBuf, moov.headerSize, moov.size).filter((b) => b.type === 'trak');
    const videoTrak = traks.find((t) => trakIsVideo(moovBuf, t));
    if (!videoTrak) throw new Error('Keine Videospur gefunden');

    // uuid-Box bauen
    const xml = Buffer.from(XML, 'utf8');
    const uuidBox = Buffer.alloc(8 + 16 + xml.length);
    uuidBox.writeUInt32BE(uuidBox.length, 0);
    uuidBox.write('uuid', 4, 'latin1');
    UUID.copy(uuidBox, 8);
    xml.copy(uuidBox, 24);
    const delta = uuidBox.length;

    // Neue moov zusammensetzen: uuid ans Ende der Videospur anhängen
    const insertAt = videoTrak.start + videoTrak.size;
    const newMoov = Buffer.concat([moovBuf.subarray(0, insertAt), uuidBox, moovBuf.subarray(insertAt)]);
    // Größen anpassen (trak + moov); 32-Bit-Größen angenommen (bei 64-Bit-Größen Offset 8)
    const bump = (buf: Buffer, box: Box) => {
      if (box.headerSize === 8) buf.writeUInt32BE(box.size + delta, box.start);
      else buf.writeBigUInt64BE(BigInt(box.size + delta), box.start + 8);
    };
    bump(newMoov, videoTrak);
    bump(newMoov, { ...moov, start: 0 });

    // Chunk-Offsets korrigieren, wenn moov vor mdat liegt (faststart)
    const mdat = top.find((b) => b.type === 'mdat');
    if (mdat && mdat.start > moov.start) {
      for (const trak of readBoxes(newMoov, moov.headerSize, newMoov.length).filter((b) => b.type === 'trak')) {
        for (const stco of findAll(newMoov, trak.start + trak.headerSize, trak.start + trak.size, 'stco')) {
          const count = newMoov.readUInt32BE(stco.start + stco.headerSize + 4);
          let q = stco.start + stco.headerSize + 8;
          for (let i = 0; i < count; i++, q += 4) newMoov.writeUInt32BE(newMoov.readUInt32BE(q) + delta, q);
        }
        for (const co64 of findAll(newMoov, trak.start + trak.headerSize, trak.start + trak.size, 'co64')) {
          const count = newMoov.readUInt32BE(co64.start + co64.headerSize + 4);
          let q = co64.start + co64.headerSize + 8;
          for (let i = 0; i < count; i++, q += 8) newMoov.writeBigUInt64BE(newMoov.readBigUInt64BE(q) + BigInt(delta), q);
        }
      }
    }

    // Datei neu schreiben
    const tmp = filePath + '.sph.tmp';
    const out = fs.createWriteStream(tmp);
    const writeChunk = (chunk: Buffer) => new Promise<void>((res, rej) => out.write(chunk, (e) => (e ? rej(e) : res())));
    const copyRange = (start: number, end: number) => new Promise<void>((res, rej) => {
      if (end <= start) return res();
      const rs = fs.createReadStream(filePath, { start, end: end - 1 });
      rs.on('data', (d) => { if (!out.write(d)) { rs.pause(); out.once('drain', () => rs.resume()); } });
      rs.on('end', () => res());
      rs.on('error', rej);
    });
    await copyRange(0, moov.start);
    await writeChunk(newMoov);
    await copyRange(moov.start + moov.size, fileSize);
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    tmpReady = tmp;
  } finally {
    fs.closeSync(fd);
  }
  if (tmpReady) fs.renameSync(tmpReady, filePath);
}
