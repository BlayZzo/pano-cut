// Selbsttest ohne Oberfläche: `electron . --smoke-test`
// Erzeugt Testvideos, importiert sie, baut eine Timeline mit allen Funktionen und exportiert sie.
// Wird in der CI ausgeführt, damit Import- und Export-Pipeline auf jedem System geprüft sind.
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClip, createProject, createTitleClip } from '@shared/timeline';
import { defaultSubtitleStyle, defaultTitle } from '@shared/pano';
import type { ExportOptions, MediaItem } from '@shared/types';
import { availableFilters, probeFile, runFfmpeg } from './ffmpeg';
import { prepareMedia, probeMedia } from './media';
import { ExportJob } from './exporter';
import { aiAvailable, detectObjects, segmentObject } from './ai';

export async function runSmokeTest(): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panocut-smoke-'));
  const log = (...a: unknown[]) => console.log('[smoke]', ...a);
  try {
    const video = path.join(dir, 'test.mp4');
    const image = path.join(dir, 'test.png');
    const music = path.join(dir, 'music.wav');
    const pano = path.join(dir, 'pano.mp4');
    log('Testdateien erzeugen …');
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
    ]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-frames:v', '1', image]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'pcm_s16le', music]);
    // 2:1-Video → wird als Equirectangular-360°-Video erkannt
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=2048x1024:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', pano]);

    const filters = await availableFilters();
    log(`Filter: v360=${filters.has('v360')} xfade=${filters.has('xfade')} drawtext=${filters.has('drawtext')} subtitles=${filters.has('subtitles')} vidstab=${filters.has('vidstabdetect')} sendcmd=${filters.has('sendcmd')}`);

    log('Import …');
    const items: MediaItem[] = [];
    for (const f of [video, image, music, pano]) {
      const item = await probeMedia(f);
      if (item.status === 'error') throw new Error(`Probe fehlgeschlagen: ${item.error}`);
      let latest = item;
      await prepareMedia(item, (u) => { latest = u; }, 360);
      if (latest.status !== 'ready') throw new Error(`Vorbereitung fehlgeschlagen: ${latest.error}`);
      items.push(latest);
      log(` ${path.basename(f)}: ${latest.type} ${latest.info.width}x${latest.info.height} ${latest.info.duration.toFixed(2)}s proxy=${!!latest.proxy} sprite=${!!latest.sprite} wave=${!!latest.waveform} 360=${latest.info.is360}`);
    }
    const [vid, img, mus, pan] = items;
    if (!pan.info.is360 || pan.stitch?.mode !== 'equirect') throw new Error('360°-Erkennung fehlgeschlagen');

    log('Timeline bauen …');
    const project = createProject('Smoke', 640, 360, 30);
    for (const it of items) project.media[it.id] = it;
    const vTracks = project.tracks.filter((t) => t.kind === 'video');
    const aTracks = project.tracks.filter((t) => t.kind === 'audio');
    const c1 = createClip(vid, vTracks[1].id, 0); c1.out = 2; c1.stabilize = { enabled: true, strength: 5, zoom: 0 };
    c1.subtitles = { enabled: true, style: defaultSubtitleStyle(), segments: [{ id: 's1', start: 0.2, end: 1.0, text: 'Hallo Welt' }, { id: 's2', start: 1.1, end: 1.9, text: 'Zweite Zeile: 100 % Test' }] };
    const c2 = createClip(vid, vTracks[1].id, 2); c2.in = 1; c2.out = 2; c2.speed = 2; c2.reverse = true; // 2–2.5 s rückwärts, doppelt schnell
    c2.transition = { type: 'wipeleft', duration: 0.4 };
    const c3 = createClip(img, vTracks[1].id, 2.5); c3.out = 1; c3.transition = { type: 'fade', duration: 0.4 }; // Bild 2.5–3.5 s
    const c4 = createClip(vid, vTracks[0].id, 1); c4.out = 1; c4.opacity = 0.5; c4.transform = { x: 20, y: -20, scale: 0.5, rotation: 15 }; c4.color = { brightness: 0.1, contrast: 1.2, saturation: 0.5, hue: 30 };
    const c5 = createClip(mus, aTracks[0].id, 0); c5.out = 3.5; c5.fadeIn = 0.5; c5.fadeOut = 0.5; c5.volume = 0.5;
    const c6 = createTitleClip(vTracks[0].id, 2.2, { ...defaultTitle('Titel: Test, 50%'), animation: 'slideup', background: '#000000' }, 1.3);
    const c7 = createClip(pan, vTracks[1].id, 3.5); c7.out = 1.5;
    c7.pano = { mode: 'flat', smooth: true, keyframes: [{ t: 0, yaw: -40, pitch: 0, roll: 0, fov: 100 }, { t: 1.5, yaw: 40, pitch: 10, roll: 0, fov: 70 }] };
    // Freistellen mit synthetischer Maske + Green Screen + angehefteter Titel
    const mask1 = path.join(dir, 'mask1.png'), mask2 = path.join(dir, 'mask2.png');
    await runFfmpeg(['-f', 'lavfi', '-i', "nullsrc=s=640x360,geq=lum='255*lt(hypot(X-220,Y-180),110)':cb=128:cr=128", '-frames:v', '1', mask1]);
    await runFfmpeg(['-f', 'lavfi', '-i', "nullsrc=s=640x360,geq=lum='255*lt(hypot(X-420,Y-180),110)':cb=128:cr=128", '-frames:v', '1', mask2]);
    const c8 = createClip(vid, vTracks[0].id, 3.6); c8.in = 2; c8.out = 3.2; c8.transform = { x: 0, y: 0, scale: 0.8, rotation: 0 };
    c8.objects = [{ id: 'trk1', label: 'person', labelDe: 'Person', color: '#f00', boxes: [{ t: 0, x: 0.2, y: 0.2, w: 0.3, h: 0.6 }, { t: 1.2, x: 0.5, y: 0.2, w: 0.3, h: 0.6 }], masks: [{ t: 0, path: mask1 }, { t: 0.6, path: mask2 }] }];
    c8.cutout = { enabled: true, trackId: 'trk1', feather: 4, grow: 2, invert: false };
    c8.chroma = { enabled: true, color: '#ff0000', similarity: 0.2, blend: 0.1, despill: true };
    const c9 = createTitleClip(vTracks[0].id, 4.9, { ...defaultTitle('Angeheftet'), size: 6, animation: 'none' }, 0.1);
    c9.attach = { clipId: c8.id, trackId: 'trk1', anchor: 'above', dx: 0, dy: 0 };
    for (const c of [c1, c2, c3, c4, c5, c6, c7, c8, c9]) project.clips[c.id] = c;

    const out = path.join(dir, 'export.mp4');
    const options: ExportOptions = { outputPath: out, width: 640, height: 360, fps: 30, format: 'mp4', codec: 'h264', quality: 'medium', hardware: false, audioBitrate: 128 };
    log('Export …');
    let lastPercent = -1;
    const job = new ExportJob(project, options, (p) => {
      if (p.phase === 'rendering' && p.percent !== lastPercent && p.percent % 25 === 0) { lastPercent = p.percent; log(` ${p.percent} %`); }
      if (p.phase === 'preparing' && p.message) log(' ' + p.message);
      if (p.phase === 'error') log(' Fehler:', p.message);
    });
    await job.run();
    const probe = await probeFile(out);
    const dur = probe.format.duration ?? 0;
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    log(`Ergebnis: ${dur.toFixed(2)} s, ${v?.width}x${v?.height} ${v?.codec_name}, Audio: ${a?.codec_name}`);
    if (Math.abs(dur - 5.0) > 0.2) throw new Error(`Falsche Länge: ${dur}`);
    if (!v || v.width !== 640 || v.height !== 360) throw new Error('Falsche Videogröße');
    if (!a) throw new Error('Keine Tonspur');

    // Größenlimit (zwei Durchgänge) + 360°-Panorama-Export mit Metadaten
    const panoProject = createProject('Smoke360', 1024, 512, 30);
    panoProject.settings.is360 = true;
    panoProject.media[pan.id] = pan;
    const p1 = createClip(pan, panoProject.tracks.filter((t) => t.kind === 'video')[1].id, 0); p1.out = 2;
    p1.pano = { mode: 'equirect', smooth: false, keyframes: [{ t: 0, yaw: 30, pitch: 0, roll: 0, fov: 100 }] };
    panoProject.clips[p1.id] = p1;
    const out360 = path.join(dir, 'export360.mp4');
    await new ExportJob(panoProject, { outputPath: out360, width: 1024, height: 512, fps: 30, format: 'mp4', codec: 'h264', quality: 'high', hardware: false, audioBitrate: 128, maxSizeMB: 1, spherical: true }, () => {}).run();
    const size360 = fs.statSync(out360).size;
    const raw = fs.readFileSync(out360);
    const hasMeta = raw.includes(Buffer.from('GSpherical:Spherical'));
    log(`360°-Export: ${(size360 / 1048576).toFixed(2)} MB, Metadaten: ${hasMeta}`);
    if (!hasMeta) throw new Error('360°-Metadaten fehlen');
    if (size360 > 1.3 * 1048576) throw new Error(`Größenlimit nicht eingehalten: ${size360}`);
    const probe360 = await probeFile(out360);
    if ((probe360.format.duration ?? 0) < 1.8) throw new Error('360°-Datei nach Metadaten-Einbau beschädigt');

    // GIF-Export kurz prüfen
    const gif = path.join(dir, 'export.gif');
    await new ExportJob(project, { ...options, outputPath: gif, format: 'gif', codec: 'gif', width: 320, height: 180, fps: 10, range: { start: 0, end: 1 } }, () => {}).run();
    if (!fs.existsSync(gif) || fs.statSync(gif).size < 1000) throw new Error('GIF-Export fehlgeschlagen');
    log('GIF ok');

    // KI: Erkennung und Maske. In der CI liegt ein Testbild (Hund, Fahrrad, Auto) unter PANOCUT_TEST_IMAGE.
    if (aiAvailable()) {
      const testImage = process.env.PANOCUT_TEST_IMAGE;
      const W = 768, H = 576;
      let frame = { data: new Uint8Array(W * H * 4), width: W, height: H };
      if (testImage && fs.existsSync(testImage)) {
        const raw = path.join(dir, 'test.rgba');
        await runFfmpeg(['-i', testImage, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
        frame = { data: new Uint8Array(fs.readFileSync(raw)), width: W, height: H };
      }
      const t0 = Date.now();
      const dets = await detectObjects(frame, 'yolox-nano', () => {}, 0.3);
      log(`KI-Erkennung (${Date.now() - t0} ms): ${dets.map((d) => `${d.labelDe} ${Math.round(d.score * 100)}%`).join(', ') || 'nichts'}`);
      const target = dets.find((d) => d.label === 'dog') ?? dets[0] ?? null;
      if (testImage && fs.existsSync(testImage) && !dets.some((d) => d.label === 'dog')) throw new Error('KI hat den Hund im Testbild nicht erkannt');
      const mask = await segmentObject(frame, 'u2netp', target, () => {});
      let fg = 0;
      for (const a of mask.alpha) if (a > 128) fg++;
      log(`KI-Maske: ${mask.width}x${mask.height}, ${(100 * fg / mask.alpha.length).toFixed(1)} % Vordergrund`);
      if (testImage && fs.existsSync(testImage) && fg < mask.alpha.length * 0.03) throw new Error('KI-Maske ist leer');
    } else {
      log('KI-Modul nicht verfügbar (onnxruntime-node fehlt)');
      if (process.env.PANOCUT_REQUIRE_AI) throw new Error('KI-Modul fehlt');
    }

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
