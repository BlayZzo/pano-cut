// Selbsttest ohne Oberfläche: `electron . --smoke-test`
// Erzeugt ein Testvideo, importiert es, baut eine kleine Timeline und exportiert sie.
// Wird in der CI ausgeführt, damit Import- und Export-Pipeline auf jedem System geprüft sind.
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClip, createProject } from '@shared/timeline';
import type { ExportOptions, MediaItem } from '@shared/types';
import { probeFile, runFfmpeg } from './ffmpeg';
import { prepareMedia, probeMedia } from './media';
import { ExportJob } from './exporter';

export async function runSmokeTest(): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panocut-smoke-'));
  const log = (...a: unknown[]) => console.log('[smoke]', ...a);
  try {
    const video = path.join(dir, 'test.mp4');
    const image = path.join(dir, 'test.png');
    const music = path.join(dir, 'music.wav');
    log('Testdateien erzeugen …');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
    ]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-frames:v', '1', image]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'pcm_s16le', music]);

    log('Import …');
    const items: MediaItem[] = [];
    for (const f of [video, image, music]) {
      const item = await probeMedia(f);
      if (item.status === 'error') throw new Error(`Probe fehlgeschlagen: ${item.error}`);
      let latest = item;
      await prepareMedia(item, (u) => { latest = u; }, 360);
      if (latest.status !== 'ready') throw new Error(`Vorbereitung fehlgeschlagen: ${latest.error}`);
      items.push(latest);
      log(` ${path.basename(f)}: ${latest.type} ${latest.info.width}x${latest.info.height} ${latest.info.duration.toFixed(2)}s proxy=${!!latest.proxy} sprite=${!!latest.sprite} wave=${!!latest.waveform}`);
    }

    log('Timeline bauen …');
    const project = createProject('Smoke', 640, 360, 30);
    for (const it of items) project.media[it.id] = it;
    const vTracks = project.tracks.filter((t) => t.kind === 'video');
    const aTracks = project.tracks.filter((t) => t.kind === 'audio');
    const [vid, img, mus] = items;
    const c1 = createClip(vid, vTracks[1].id, 0); c1.out = 2;                       // 0–2 s normal
    const c2 = createClip(vid, vTracks[1].id, 2); c2.in = 1; c2.out = 2; c2.speed = 2; c2.reverse = true; // 2–2.5 s rückwärts, doppelt schnell
    const c3 = createClip(img, vTracks[1].id, 2.5); c3.out = 1;                     // Bild 2.5–3.5 s
    const c4 = createClip(vid, vTracks[0].id, 1); c4.out = 1; c4.opacity = 0.5; c4.transform = { x: 20, y: -20, scale: 0.5, rotation: 15 }; c4.color = { brightness: 0.1, contrast: 1.2, saturation: 0.5, hue: 30 };
    const c5 = createClip(mus, aTracks[0].id, 0); c5.out = 3.5; c5.fadeIn = 0.5; c5.fadeOut = 0.5; c5.volume = 0.5;
    for (const c of [c1, c2, c3, c4, c5]) project.clips[c.id] = c;

    const out = path.join(dir, 'export.mp4');
    const options: ExportOptions = { outputPath: out, width: 640, height: 360, fps: 30, format: 'mp4', codec: 'h264', quality: 'medium', hardware: false, audioBitrate: 128 };
    log('Export …');
    let lastPercent = -1;
    const job = new ExportJob(project, options, (p) => {
      if (p.phase === 'rendering' && p.percent !== lastPercent && p.percent % 25 === 0) { lastPercent = p.percent; log(` ${p.percent} %`); }
      if (p.phase === 'error') log(' Fehler:', p.message);
    });
    await job.run();
    const probe = await probeFile(out);
    const dur = probe.format.duration ?? 0;
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    log(`Ergebnis: ${dur.toFixed(2)} s, ${v?.width}x${v?.height} ${v?.codec_name}, Audio: ${a?.codec_name}`);
    if (Math.abs(dur - 3.5) > 0.2) throw new Error(`Falsche Länge: ${dur}`);
    if (!v || v.width !== 640 || v.height !== 360) throw new Error('Falsche Videogröße');
    if (!a) throw new Error('Keine Tonspur');

    // GIF-Export kurz prüfen
    const gif = path.join(dir, 'export.gif');
    await new ExportJob(project, { ...options, outputPath: gif, format: 'gif', codec: 'gif', width: 320, height: 180, fps: 10, range: { start: 0, end: 1 } }, () => {}).run();
    if (!fs.existsSync(gif) || fs.statSync(gif).size < 1000) throw new Error('GIF-Export fehlgeschlagen');
    log('GIF ok');

    log('✅ Selbsttest bestanden');
    return 0;
  } catch (err) {
    console.error('[smoke] ❌', (err as Error).message);
    return 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    void app;
  }
}
