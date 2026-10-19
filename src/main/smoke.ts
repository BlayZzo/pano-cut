// Selbsttest ohne Oberfläche: `electron . --smoke-test`
// Erzeugt Testvideos, importiert sie, baut eine Timeline mit allen Funktionen und exportiert sie.
// Wird in der CI ausgeführt, damit Import- und Export-Pipeline auf jedem System geprüft sind.
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClip, createProject, createTitleClip } from '@shared/timeline';
import { defaultSubtitleStyle, defaultTitle } from '@shared/pano';
import { createMotion } from '@shared/effects';
import { syncLinkedClips } from '@shared/layers';
import type { ExportOptions, MediaItem } from '@shared/types';
import { availableFilters, probeFile, runFfmpeg } from './ffmpeg';
import { prepareMedia, probeMedia } from './media';
import { ExportJob } from './exporter';
import { aiAvailable, detectObjects, segmentObject } from './ai';

export async function runSmokeTest(): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panocut-smoke-'));
  const log = (...a: unknown[]) => console.log('[smoke]', ...a);
  // Wächter: hängt ein Schritt, bricht der Test mit einer klaren Meldung ab (statt die CI stundenlang zu blockieren)
  let stage = 'Start';
  const step = (name: string) => { stage = name; log(name); };
  const watchdog = setTimeout(() => {
    console.error(`[smoke] ❌ Zeitüberschreitung bei: ${stage}`);
    app.exit(2);
  }, Number(process.env.PANOCUT_SMOKE_TIMEOUT ?? 12 * 60) * 1000);
  try {
    const video = path.join(dir, 'test.mp4');
    const image = path.join(dir, 'test.png');
    const music = path.join(dir, 'music.wav');
    const pano = path.join(dir, 'pano.mp4');
    step('Testdateien erzeugen …');
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

    step('Import …');
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

    step('Timeline bauen …');
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
    step('Export …');
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
    step('360°-Export mit Größenlimit …');
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
    step('GIF-Export …');
    const gif = path.join(dir, 'export.gif');
    await new ExportJob(project, { ...options, outputPath: gif, format: 'gif', codec: 'gif', width: 320, height: 180, fps: 10, range: { start: 0, end: 1 } }, () => {}).run();
    if (!fs.existsSync(gif) || fs.statSync(gif).size < 1000) throw new Error('GIF-Export fehlgeschlagen');
    log('GIF ok');

    // v0.4: Farb-Look + eigene LUT, Bild-Effekte, Zuschnitt, Animation (Bewegung + Deckkraft), Ducking, Übersetzung
    step('Effekt-Export (Looks, LUT, Animation, Ducking) …');
    const lutFile = path.join(dir, 'test.cube');
    fs.writeFileSync(lutFile, 'LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n'); // invertiert
    const fxProject = createProject('SmokeFx', 640, 360, 30);
    for (const it of [vid, img, mus]) fxProject.media[it.id] = it;
    const fv = fxProject.tracks.filter((t) => t.kind === 'video');
    const fa = fxProject.tracks.filter((t) => t.kind === 'audio');
    const e1 = createClip(vid, fv[1].id, 0); e1.out = 2;
    e1.color = { ...e1.color, look: 'cinema', exposure: 0.3, temperature: 20, lut: lutFile, lutStrength: 0.5 };
    e1.fx = { vignette: 0.6, sharpen: 0.4, denoise: 0.3, blur: 0, grain: 0.3, mirror: true, flip: false };
    e1.crop = { left: 5, right: 5, top: 5, bottom: 5 };
    e1.motion = createMotion('kenburns', 2, 1);
    e1.subtitles = { enabled: true, style: defaultSubtitleStyle(), showTranslation: true, segments: [{ id: 't1', start: 0.1, end: 1.9, text: 'Hallo', translation: 'Hello' }] };
    const e2 = createClip(img, fv[0].id, 0); e2.out = 2; e2.transform = { x: 25, y: 0, scale: 0.4, rotation: 0 };
    e2.motion = createMotion('slidein-left', 2, 1); e2.motion.keyframes[0].opacity = 0;
    const e3 = createClip(mus, fa[0].id, 0); e3.out = 2; e3.ducking = { enabled: true, amount: 0.8 };
    for (const c of [e1, e2, e3]) fxProject.clips[c.id] = c;
    const outFx = path.join(dir, 'export_fx.mp4');
    await new ExportJob(fxProject, { ...options, outputPath: outFx }, (p) => { if (p.phase === 'error') log(' Fehler:', p.message); }).run();
    const probeFx = await probeFile(outFx);
    if (Math.abs((probeFx.format.duration ?? 0) - 2) > 0.2) throw new Error(`Effekt-Export: falsche Länge ${probeFx.format.duration}`);
    // Das rote Bild muss nach dem Hereinschieben rechts der Mitte stehen (x = 50 % + 25 %), am Anfang noch nicht
    const pixelAt = async (t: number, x: number, y: number): Promise<number[]> => {
      const rawPx = path.join(dir, `px_${t}.rgb`);
      await runFfmpeg(['-ss', String(t), '-i', outFx, '-frames:v', '1', '-vf', `crop=4:4:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPx]);
      return [...fs.readFileSync(rawPx).subarray(0, 3)];
    };
    const late = await pixelAt(1.2, 478, 178);
    const early = await pixelAt(0.03, 478, 178);
    log(`Animation: Pixel bei 1,2 s = ${late.join(',')}, bei 0 s = ${early.join(',')}`);
    if (!(late[0] > 150 && late[1] < 90 && late[2] < 90)) throw new Error('Animation: Bild steht nicht an der Zielposition');
    if (early[0] > 150 && early[1] < 90 && early[2] < 90) throw new Error('Animation: Bild ist am Anfang schon sichtbar');
    log('Effekte ok');

    // v0.5: Ebenen – Effekt mit Transparenz (WebM/VP9), Schlagschatten, Lichtschein im Mischmodus „Negativ multiplizieren“
    step('Ebenen-Export (Transparenz, Schatten, Mischmodus) …');
    const fxWebm = path.join(dir, 'fx_alpha.webm'), lightWebm = path.join(dir, 'fx_light.webm'), grey = path.join(dir, 'grey.mp4');
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x606060:s=640x360:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', grey]);
    await runFfmpeg(['-f', 'lavfi', '-i', "color=c=red:s=160x160:d=2:r=30,format=rgba,geq=r='255':g='0':b='0':a='255*lt(hypot(X-80\\,Y-80)\\,50)'", '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '20', fxWebm]);
    await runFfmpeg(['-f', 'lavfi', '-i', "nullsrc=s=80x80:d=2:r=30,format=gray,geq=lum='255*exp(-(pow(X-40\\,2)+pow(Y-40\\,2))/300)'", '-vf', 'format=yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '20', lightWebm]);
    const layerItems: MediaItem[] = [];
    for (const f of [grey, fxWebm, lightWebm]) {
      const it = await probeMedia(f);
      let latest = it;
      await prepareMedia(it, (u) => { latest = u; }, 360);
      layerItems.push(latest);
    }
    const [greyM, fxM, lightM] = layerItems;
    fxM.hasAlpha = true;
    let layProject = createProject('SmokeLayers', 640, 360, 30);
    for (const it of layerItems) layProject.media[it.id] = it;
    const lv = layProject.tracks.filter((t) => t.kind === 'video');
    layProject.tracks = [{ id: 'trk_fx', kind: 'video', name: 'Effekt', muted: false, locked: false, hidden: false }, { id: 'trk_light', kind: 'video', name: 'Licht', muted: false, locked: false, hidden: false }, ...layProject.tracks];
    const lb = createClip(greyM, lv[1].id, 0); lb.out = 2;
    const lf = createClip(fxM, 'trk_fx', 0); lf.out = 2; lf.transform = { x: 0, y: 0, scale: 0.5, rotation: 0 };
    lf.shadow = { enabled: true, opacity: 0.8, blur: 0, distance: 10, angle: 0 };
    const ll = createClip(lightM, 'trk_light', 0); ll.out = 2; ll.blend = 'screen'; ll.link = { clipId: lf.id, mode: 'light', scale: 3 };
    for (const c of [lb, lf, ll]) layProject.clips[c.id] = c;
    layProject = syncLinkedClips(layProject);
    if (Math.abs(layProject.clips[ll.id].transform.scale - 1.5) > 1e-6) throw new Error('Verknüpfter Lichtschein folgt dem Effekt nicht');
    const outLay = path.join(dir, 'export_layers.mp4');
    await new ExportJob(layProject, { ...options, outputPath: outLay }, (p) => { if (p.phase === 'error') log(' Fehler:', p.message); }).run();
    const layPx = async (x: number, y: number): Promise<number[]> => {
      const raw = path.join(dir, `lay_${x}_${y}.rgb`);
      await runFfmpeg(['-ss', '1', '-i', outLay, '-frames:v', '1', '-vf', `crop=4:4:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
      return [...fs.readFileSync(raw).subarray(0, 3)];
    };
    const disc = await layPx(318, 178), shadowPx = await layPx(393, 178), lit = await layPx(318, 70), plain = await layPx(20, 20);
    log(`Ebenen: Effekt ${disc.join(',')} · Schatten ${shadowPx.join(',')} · Licht ${lit.join(',')} · Hintergrund ${plain.join(',')}`);
    if (!(disc[0] > 180 && disc[1] < 90)) throw new Error('Ebenen: Effekt mit Transparenz fehlt');
    if (!(shadowPx[1] < plain[1] - 40)) throw new Error('Ebenen: Schlagschatten fehlt');
    if (!(lit[1] > plain[1] + 25)) throw new Error('Ebenen: Lichtschein (Negativ multiplizieren) fehlt');
    log('Ebenen ok');

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
      step('KI: Erkennungsmodell laden und ausführen …');
      let lastPct = -1;
      const aiLog = (p: { phase: string; percent: number; message?: string }) => { if (p.percent !== lastPct && p.percent % 25 === 0) { lastPct = p.percent; log(`  ${p.phase} ${p.percent} %`); } };
      const dets = await detectObjects(frame, 'yolox-nano', aiLog, 0.3);
      log(`KI-Erkennung (${Date.now() - t0} ms): ${dets.map((d) => `${d.labelDe} ${Math.round(d.score * 100)}%`).join(', ') || 'nichts'}`);
      const target = dets.find((d) => d.label === 'dog') ?? dets[0] ?? null;
      if (testImage && fs.existsSync(testImage) && !dets.some((d) => d.label === 'dog')) throw new Error('KI hat den Hund im Testbild nicht erkannt');
      step('KI: Maskenmodell laden und ausführen …');
      lastPct = -1;
      const mask = await segmentObject(frame, 'u2netp', target, aiLog);
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
    clearTimeout(watchdog);
    fs.rmSync(dir, { recursive: true, force: true });
    void app;
  }
}
