// PanoCut – Stream-Deck-Plugin.
// Die Stream-Deck-App startet dieses Skript mit Node.js und den Argumenten
//   -port <n> -pluginUUID <id> -registerEvent <name> -info <json>
// Tastendrücke werden als HTTP-POST an PanoCut weitergegeben (nur auf diesem Rechner, 127.0.0.1).
// Ohne Abhängigkeiten: kleiner WebSocket-Client direkt auf `net`.
'use strict';
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');

const PANOCUT_PORT = Number(process.env.PANOCUT_PORT) || 51888;
const ACTION_PREFIX = 'de.blayzzo.panocut.';

const args = {};
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i].startsWith('-')) args[process.argv[i].replace(/^-+/, '')] = process.argv[i + 1];
}

/** Aktion an PanoCut senden. */
function sendToPanoCut(action) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PANOCUT_PORT, path: `/action/${action}`, method: 'POST', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Minimaler WebSocket-Client (RFC 6455, nur Text-Nachrichten). */
function connect(port, onOpen, onMessage) {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
  let buf = Buffer.alloc(0);
  let open = false;
  let fragments = [];

  const sendFrame = (opcode, data) => {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    sock.write(Buffer.concat([header, mask, masked]));
  };
  const send = (obj) => sendFrame(0x1, JSON.stringify(obj));

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 101/.test(head)) { sock.destroy(); return; }
      open = true;
      buf = buf.subarray(end + 4);
      onOpen(send);
    }
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (b1 & 0x80) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) { const text = Buffer.concat(fragments).toString('utf8'); fragments = []; onMessage(text); }
      } else if (opcode === 0x9) sendFrame(0xA, payload);   // Ping → Pong
      else if (opcode === 0x8) { sock.end(); }
    }
  });
  sock.on('error', () => process.exit(1));
  sock.on('close', () => process.exit(0));
}

if (!args.port || !args.pluginUUID || !args.registerEvent) {
  console.error('Dieses Skript wird von der Stream-Deck-App gestartet.');
  process.exit(1);
}

connect(Number(args.port), (send) => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  globalThis.__send = send;
}, async (text) => {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.event !== 'keyDown' || typeof msg.action !== 'string' || !msg.action.startsWith(ACTION_PREFIX)) return;
  const action = msg.action.slice(ACTION_PREFIX.length);
  const ok = await sendToPanoCut(action);
  const send = globalThis.__send;
  // Kurze Rückmeldung auf der Taste: Häkchen bei Speichern/Export, Warnsymbol wenn PanoCut nicht läuft
  if (!ok) send({ event: 'showAlert', context: msg.context });
  else if (action === 'save' || action === 'export') send({ event: 'showOk', context: msg.context });
});
