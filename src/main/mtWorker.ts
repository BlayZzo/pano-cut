// Übersetzungs-Thread: Bergamot (die Übersetzungs-Technik von Firefox, freie Software) als WebAssembly.
// Läuft komplett auf diesem Rechner. Nachrichten: { type: 'translate', id, texts } → { id, ok, result | error }.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

interface WorkerSetup {
  engineJs: string;      // bergamot-translator-worker.js
  engineWasm: string;    // bergamot-translator-worker.wasm
  model: string;         // model.*.intgemm.alphas.bin
  lex: string | null;    // Kurzliste (beschleunigt)
  vocabs: string[];      // ein gemeinsames oder zwei getrennte Vokabulare
  alphas: boolean;       // Modell mit „alphas“ (Firefox-Modelle) → andere Rechengenauigkeit
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Bergamot = any;

const setup = workerData as WorkerSetup;
let ready: Promise<{ M: Bergamot; service: Bergamot; model: Bergamot }> | null = null;

function loadEngine(): Promise<Bergamot> {
  return new Promise((resolve, reject) => {
    const code = fs.readFileSync(setup.engineJs, 'utf8');
    const Module: Record<string, unknown> = {
      wasmBinary: fs.readFileSync(setup.engineWasm),
      print: () => undefined,
      printErr: () => undefined,
      onAbort: (e: unknown) => reject(new Error(`Übersetzer abgebrochen: ${String(e)}`)),
    };
    Module.onRuntimeInitialized = () => resolve(Module);
    const req = createRequire(setup.engineJs);
    // Der Emscripten-Code erwartet eine globale Variable „Module“ – in eine Funktion einbetten
    const factory = new Function('Module', 'require', '__dirname', '__filename', `${code}\nreturn Module;`);
    try {
      factory(Module, req, path.dirname(setup.engineJs), setup.engineJs);
    } catch (e) {
      reject(e);
    }
  });
}

function aligned(M: Bergamot, bytes: Uint8Array, alignment: number): Bergamot {
  const mem = new M.AlignedMemory(bytes.byteLength, alignment);
  mem.getByteArrayView().set(bytes);
  return mem;
}

async function init(): Promise<{ M: Bergamot; service: Bergamot; model: Bergamot }> {
  const M = await loadEngine();
  const config = [
    'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0', 'max-length-break: 128', 'mini-batch-words: 1024',
    'workspace: 128', 'max-length-factor: 2.0', 'skip-cost: true', 'cpu-threads: 0', 'quiet: true', 'quiet-translation: true',
    `gemm-precision: ${setup.alphas ? 'int8shiftAlphaAll' : 'int8shift'}`, 'alignment: soft',
  ].join('\n') + '\n';
  const modelMem = aligned(M, fs.readFileSync(setup.model), 256);
  const lexMem = setup.lex ? aligned(M, fs.readFileSync(setup.lex), 64) : null;
  const vocabs = new M.AlignedMemoryList();
  for (const v of setup.vocabs) vocabs.push_back(aligned(M, fs.readFileSync(v), 64));
  const model = new M.TranslationModel(config, modelMem, lexMem, vocabs, null);
  const service = new M.BlockingService({ cacheSize: 0 });
  return { M, service, model };
}

async function translate(texts: string[]): Promise<string[]> {
  if (!ready) ready = init();
  const { M, service, model } = await ready;
  const input = new M.VectorString();
  const options = new M.VectorResponseOptions();
  for (const t of texts) {
    input.push_back(t);
    options.push_back({ qualityScores: false, alignment: false, html: false });
  }
  const responses = service.translate(model, input, options);
  const out: string[] = [];
  for (let i = 0; i < responses.size(); i++) out.push(responses.get(i).getTranslatedText());
  input.delete(); options.delete(); responses.delete();
  return out;
}

parentPort?.on('message', (msg: { type: string; id: number; texts?: string[] }) => {
  if (msg.type !== 'translate') return;
  translate(msg.texts ?? []).then(
    (result) => parentPort?.postMessage({ id: msg.id, ok: true, result }),
    (e) => parentPort?.postMessage({ id: msg.id, ok: false, error: (e as Error).message ?? String(e) }),
  );
});
