// Übersetzung Deutsch ↔ Englisch ohne Server und ohne Abo: Bergamot (Übersetzer aus Firefox, freie Software).
// Programm (WebAssembly, 5 MB) und Sprachmodelle (je ca. 15–35 MB) werden beim ersten Gebrauch geladen und
// liegen danach in userData/models/translate. Die Rechnung läuft in einem eigenen Thread (mtWorker).
import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import log from 'electron-log';

export type MtLang = 'de' | 'en';
export interface MtProgress { percent: number; message: string }

const ENGINE_VERSION = 'v0.4.5';
const ENGINE_URL = (f: string) => `https://github.com/browsermt/bergamot-translator/releases/download/${ENGINE_VERSION}/${f}`;
const ENGINE_FILES = ['bergamot-translator-worker.js', 'bergamot-translator-worker.wasm'];
// Firefox verteilt seine Übersetzungsmodelle über „Remote Settings“ (öffentlich, ohne Anmeldung)
const RS_BASE = 'https://firefox.settings.services.mozilla.com/v1';
const RS_RECORDS = `${RS_BASE}/buckets/main/collections/translations-models/records`;
// Ersatzquelle: Modelle des Bergamot-Projekts (Universität Edinburgh)
const STATMT = (pair: string) => `https://data.statmt.org/bergamot/models/deen/${pair}.student.tiny11.tar.gz`;

function dir(...p: string[]): string {
  const d = path.join(app.getPath('userData'), 'models', 'translate', ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function download(url: string, dest: string, onBytes?: (got: number, total: number) => void, sha256?: string): Promise<void> {
  if (fs.existsSync(dest)) return;
  const ctrl = new AbortController();
  let idle = setTimeout(() => ctrl.abort(), 60_000);
  const res = await net.fetch(url, { signal: ctrl.signal });
  if (!res.ok || !res.body) { clearTimeout(idle); throw new Error(`Download fehlgeschlagen (${res.status}): ${url}`); }
  const total = Number(res.headers.get('content-length') ?? 0);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), 60_000);
      got += value.byteLength;
      hash.update(value);
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()));
      onBytes?.(got, total);
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    if (sha256 && hash.digest('hex') !== sha256) throw new Error('Download beschädigt (Prüfsumme stimmt nicht)');
    fs.renameSync(tmp, dest);
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    clearTimeout(idle);
  }
}

interface ModelFiles { model: string; lex: string | null; vocabs: string[]; alphas: boolean }

interface RsRecord {
  name: string; fromLang: string; toLang: string; version: string; fileType: string;
  attachment?: { location: string; hash: string; size: number; filename?: string };
}

function versionKey(v: string): number[] {
  return v.split(/[.a-z]+/i).filter(Boolean).map(Number);
}

/** Modelle über Firefox Remote Settings: die neueste Version 1.x eines Sprachpaars (passend zur Bergamot-Version). */
async function modelsFromFirefox(from: MtLang, to: MtLang, onProgress: (p: MtProgress) => void): Promise<ModelFiles> {
  const target = dir(`${from}${to}`);
  const done = path.join(target, 'files.json');
  if (fs.existsSync(done)) return JSON.parse(fs.readFileSync(done, 'utf8')) as ModelFiles;
  const info = await (await net.fetch(`${RS_BASE}/`)).json() as { capabilities?: { attachments?: { base_url?: string } } };
  const base = info.capabilities?.attachments?.base_url;
  if (!base) throw new Error('Firefox-Modellverzeichnis nicht erreichbar');
  const all = (await (await net.fetch(RS_RECORDS)).json() as { data: RsRecord[] }).data
    .filter((r) => r.fromLang === from && r.toLang === to && r.attachment);
  // Version wählen: höchste 1.x (neuere Hauptversionen brauchen eine neuere Übersetzungs-Technik)
  const versions = [...new Set(all.map((r) => r.version))].sort((a, b) => {
    const x = versionKey(a), y = versionKey(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
  const v1 = versions.filter((v) => versionKey(v)[0] === 1 && !/[a-z]/i.test(v));
  const version = v1[v1.length - 1] ?? versions[0];
  const recs = all.filter((r) => r.version === version);
  log.info(`Übersetzung ${from}→${to}: Firefox-Modell ${version}`, recs.map((r) => `${r.fileType}:${r.name}`).join(', '));
  const model = recs.find((r) => r.fileType === 'model');
  const vocabRecs = recs.filter((r) => r.fileType === 'vocab' || r.fileType === 'srcvocab' || r.fileType === 'trgvocab')
    .sort((a, b) => (a.fileType === 'trgvocab' ? 1 : 0) - (b.fileType === 'trgvocab' ? 1 : 0));
  const lex = recs.find((r) => r.fileType === 'lex');
  if (!model || vocabRecs.length === 0) throw new Error('Kein passendes Sprachmodell gefunden');
  const files = [model, ...vocabRecs, ...(lex ? [lex] : [])];
  const totalBytes = files.reduce((s, r) => s + (r.attachment?.size ?? 0), 0);
  let before = 0;
  const local: Record<string, string> = {};
  for (const r of files) {
    const dest = path.join(target, r.name.replace(/[^\w.-]/g, '_'));
    await download(`${base.replace(/\/$/, '')}/${r.attachment!.location.replace(/^\//, '')}`, dest, (got) => {
      onProgress({ percent: Math.round(((before + got) / Math.max(1, totalBytes)) * 100), message: `Sprachmodell ${from.toUpperCase()}→${to.toUpperCase()} wird geladen … ${Math.round((before + got) / 1048576)} / ${Math.round(totalBytes / 1048576)} MB` });
    }, r.attachment!.hash);
    before += r.attachment!.size;
    local[r.name] = dest;
  }
  const out: ModelFiles = {
    model: local[model.name],
    lex: lex ? local[lex.name] : null,
    vocabs: vocabRecs.map((r) => local[r.name]),
    alphas: /alphas/.test(model.name),
  };
  fs.writeFileSync(done, JSON.stringify(out));
  return out;
}

/** Ersatz: Bergamot-Modell als .tar.gz von data.statmt.org (mit dem System-Programm „tar“ entpackt). */
async function modelsFromStatmt(from: MtLang, to: MtLang, onProgress: (p: MtProgress) => void): Promise<ModelFiles> {
  const pair = `${from}${to}`;
  const target = dir(`${pair}-statmt`);
  const done = path.join(target, 'files.json');
  if (fs.existsSync(done)) return JSON.parse(fs.readFileSync(done, 'utf8')) as ModelFiles;
  const archive = path.join(target, 'model.tar.gz');
  await download(STATMT(pair), archive, (got, total) => onProgress({ percent: total ? Math.round((got / total) * 100) : 0, message: `Sprachmodell wird geladen … ${Math.round(got / 1048576)} MB` }));
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xzf', archive, '-C', target], { windowsHide: true });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`Entpacken fehlgeschlagen (${c})`))));
  });
  const found: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else found.push(p); } };
  walk(target);
  const model = found.find((f) => /model.*\.bin$/.test(path.basename(f)));
  let lex = found.find((f) => /lex.*s2t(\.bin)?$/.test(path.basename(f))) ?? null;
  const lexGz = found.find((f) => /lex.*s2t(\.bin)?\.gz$/.test(path.basename(f)));
  if (!lex && lexGz) {
    const zlib = await import('node:zlib');
    lex = lexGz.replace(/\.gz$/, '');
    fs.writeFileSync(lex, zlib.gunzipSync(fs.readFileSync(lexGz)));
  }
  const vocabs = found.filter((f) => /vocab.*\.spm$/.test(path.basename(f)));
  if (!model || vocabs.length === 0) throw new Error('Sprachmodell unvollständig');
  const out: ModelFiles = { model, lex, vocabs: vocabs.slice(0, 2), alphas: /alphas/.test(model) };
  fs.writeFileSync(done, JSON.stringify(out));
  fs.rmSync(archive, { force: true });
  return out;
}

async function ensureEngine(onProgress: (p: MtProgress) => void): Promise<{ js: string; wasm: string }> {
  const d = dir('engine', ENGINE_VERSION);
  for (const f of ENGINE_FILES) {
    await download(ENGINE_URL(f), path.join(d, f), (got, total) => onProgress({ percent: total ? Math.round((got / total) * 100) : 0, message: `Übersetzer wird geladen … ${Math.round(got / 1048576)} MB` }));
  }
  return { js: path.join(d, ENGINE_FILES[0]), wasm: path.join(d, ENGINE_FILES[1]) };
}

async function ensureModel(from: MtLang, to: MtLang, onProgress: (p: MtProgress) => void): Promise<ModelFiles> {
  try {
    return await modelsFromFirefox(from, to, onProgress);
  } catch (e) {
    log.warn(`Firefox-Modell ${from}→${to} nicht verfügbar, versuche Ersatzquelle`, (e as Error).message);
    return modelsFromStatmt(from, to, onProgress);
  }
}

/** Ist das Paar schon heruntergeladen (dann geht es offline sofort)? */
export function mtReady(from: MtLang, to: MtLang): boolean {
  const base = path.join(app.getPath('userData'), 'models', 'translate');
  const engine = ENGINE_FILES.every((f) => fs.existsSync(path.join(base, 'engine', ENGINE_VERSION, f)));
  const model = fs.existsSync(path.join(base, `${from}${to}`, 'files.json')) || fs.existsSync(path.join(base, `${from}${to}-statmt`, 'files.json'));
  return engine && model;
}

// ---- Thread je Sprachrichtung (bleibt geladen, solange PanoCut läuft) ----

interface Pending { resolve: (r: string[]) => void; reject: (e: Error) => void }
const workers = new Map<string, { worker: Worker; pending: Map<number, Pending>; next: number }>();

function workerFile(): string | null {
  const f = path.join(__dirname, 'mtWorker.js');
  return fs.existsSync(f) ? f : null;
}

async function getWorker(from: MtLang, to: MtLang, onProgress: (p: MtProgress) => void) {
  const key = `${from}${to}`;
  const existing = workers.get(key);
  if (existing) return existing;
  const engine = await ensureEngine(onProgress);
  const files = await ensureModel(from, to, onProgress);
  const file = workerFile();
  if (!file) throw new Error('Übersetzungs-Modul fehlt');
  const worker = new Worker(file, { workerData: { engineJs: engine.js, engineWasm: engine.wasm, model: files.model, lex: files.lex, vocabs: files.vocabs, alphas: files.alphas } });
  const entry = { worker, pending: new Map<number, Pending>(), next: 1 };
  worker.on('message', (m: { id: number; ok: boolean; result?: string[]; error?: string }) => {
    const p = entry.pending.get(m.id);
    if (!p) return;
    entry.pending.delete(m.id);
    if (m.ok) p.resolve(m.result ?? []); else p.reject(new Error(m.error ?? 'Übersetzung fehlgeschlagen'));
  });
  const fail = (e: Error) => {
    for (const p of entry.pending.values()) p.reject(e);
    entry.pending.clear();
    workers.delete(key);
  };
  worker.on('error', fail);
  worker.on('exit', (c) => fail(new Error(`Übersetzer beendet (${c})`)));
  workers.set(key, entry);
  return entry;
}

/** Texte lokal übersetzen (Deutsch ↔ Englisch). Leere Zeilen bleiben leer. */
export async function translateLocal(texts: string[], from: MtLang, to: MtLang, onProgress: (p: MtProgress) => void = () => undefined): Promise<string[]> {
  if (from === to) return texts.slice();
  const w = await getWorker(from, to, onProgress);
  onProgress({ percent: 100, message: 'Wird übersetzt …' });
  const idx = texts.map((t, i) => (t.trim() ? i : -1)).filter((i) => i >= 0);
  const out = texts.map(() => '');
  for (let i = 0; i < idx.length; i += 40) {
    const chunk = idx.slice(i, i + 40);
    const res = await new Promise<string[]>((resolve, reject) => {
      const id = w.next++;
      w.pending.set(id, { resolve, reject });
      w.worker.postMessage({ type: 'translate', id, texts: chunk.map((k) => texts[k]) });
    });
    chunk.forEach((k, j) => { out[k] = res[j] ?? ''; });
    onProgress({ percent: Math.round(((i + chunk.length) / idx.length) * 100), message: 'Wird übersetzt …' });
  }
  return out;
}

export function stopTranslators(): void {
  for (const w of workers.values()) void w.worker.terminate();
  workers.clear();
}
