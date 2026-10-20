// Sound-Effekte als WAV-Dateien bereitstellen (einmal berechnet, dann aus dem Zwischenspeicher).
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { encodeWav, renderSfx, sfxDef, type SfxParams } from '@shared/sfx';

export function sfxDir(): string {
  const d = path.join(app.getPath('userData'), 'sounds');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Berechnet einen Sound (falls noch nicht vorhanden) und gibt den Dateipfad zurück. */
export function renderSfxFile(id: string, params: Partial<SfxParams>): string {
  const def = sfxDef(id);
  if (!def) throw new Error(`Unbekannter Sound: ${id}`);
  const p = { length: 1, pitch: 0, intensity: 1, seed: 1, ...params };
  const key = `${id}_${p.length.toFixed(2)}_${p.pitch.toFixed(1)}_${p.intensity.toFixed(2)}_${Math.round(p.seed)}`;
  const dir = path.join(sfxDir(), key);
  const file = path.join(dir, `${def.name.replace(/[\\/:*?"<>|()]+/g, '').trim()}.wav`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const { L, R, sr } = renderSfx(id, p);
  fs.writeFileSync(file, encodeWav(L, R, sr));
  return file;
}
