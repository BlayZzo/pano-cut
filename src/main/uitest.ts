// Automatischer Oberflächen-Test im echten Programm (`electron . --ui-test`, läuft in der CI auf Linux und Mac):
// Videos importieren, auf die Timeline legen und prüfen, ob die Vorschau wirklich ein Bild zeigt.
import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from './ffmpeg';

function out(...a: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[ui-test]', ...a);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mittlere Helligkeit eines Bereichs im Fenster-Screenshot (unabhängig davon, was die Seite selbst lesen darf). */
async function meanOf(win: BrowserWindow, r: { x: number; y: number; width: number; height: number }): Promise<number> {
  const img = await win.webContents.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
  const bmp = img.toBitmap();
  let s = 0, n = 0;
  for (let i = 0; i + 3 < bmp.length; i += 16) { s += (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3; n++; }
  return n ? s / n : 0;
}

export async function runUiTest(win: BrowserWindow): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panocut-ui-'));
  const failures: string[] = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) out('Konsole:', message.slice(0, 300)); });
  try {
    out('Testdateien erzeugen …');
    const video = path.join(dir, 'a_video.mp4');
    const pano = path.join(dir, 'b_pano360.mp4');
    const image = path.join(dir, 'c_bild.png');
    const uhd = path.join(dir, 'd_4k_hevc.mp4');
    // wie ein Handy-Video: Full HD, 60 Bilder/s, lange Abstände zwischen Schlüsselbildern, hohe Datenrate (keine Vorschau-Datei)
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=1920x1080:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '240', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=2048x1024:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', pano]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720', '-frames:v', '1', image]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=3840x2160:rate=30', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', uhd]);

    await win.webContents.executeJavaScript('new Promise((r) => { const w = () => window.__pcTest ? r(true) : setTimeout(w, 100); w(); })');
    const t0 = Date.now();
    const imported = await win.webContents.executeJavaScript(`(async () => {
      const T = window.__pcTest;
      const t0 = performance.now();
      await T.importFiles(${JSON.stringify([video, pano, image, uhd])});
      const importMs = Math.round(performance.now() - t0);
      let firstThumbMs = 0;
      const seen = new Set();
      let indicator = '';
      for (let i = 0; i < 2400; i++) {
        const ms = Object.values(T.useProject.getState().project.media);
        for (const m of ms) if (m.prep && m.prep.percent > 0 && m.prep.percent < 100) seen.add(m.name + ':' + m.prep.stage);
        const ind = document.querySelector('.prep-indicator-btn'); if (ind && !indicator) indicator = ind.textContent;
        if (!firstThumbMs && ms.length === 4 && ms.every((m) => m.thumb || m.status === 'error')) firstThumbMs = Math.round(performance.now() - t0);
        if (ms.length === 4 && ms.every((m) => m.status === 'ready' || m.status === 'error')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const media = Object.values(T.useProject.getState().project.media).sort((a, b) => a.name.localeCompare(b.name));
      let at = 0;
      for (const m of media) { T.addMediaToTimeline(m, at); at += m.type === 'image' ? 5 : m.info.duration; }
      return { importMs, firstThumbMs, progressSeen: [...seen], indicator, readyMs: Math.round(performance.now() - t0), media: media.map((m) => ({ name: m.name, status: m.status, error: m.error, proxy: !!m.proxy, thumb: !!m.thumb, is360: m.info.is360 })) };
    })()`);
    out('Import:', JSON.stringify(imported), `(${Date.now() - t0} ms)`);
    for (const m of imported.media) if (m.status !== 'ready') failures.push(`${m.name}: ${m.status} ${m.error ?? ''}`);
    if (imported.importMs > 5000) failures.push(`Import dauert zu lange (${imported.importMs} ms)`);
    const byName = (n: string) => imported.media.find((m: { name: string }) => m.name.startsWith(n));
    if (byName('a_video')?.proxy) failures.push('Full-HD-H.264 bekam unnötig eine Vorschau-Datei');
    if (!byName('d_4k')?.proxy) failures.push('4K-HEVC bekam keine Vorschau-Datei');
    if (!imported.progressSeen.some((x: string) => x.startsWith('d_4k'))) failures.push('Kein Fortschritt für die 4K-Vorschau-Datei sichtbar');
    if (!imported.indicator) failures.push('Keine Fortschrittsanzeige oben');

    // Vorschau an mehreren Stellen prüfen: normales Video, 360°-Video, Bild
    for (const [label, t] of [['Video', 1.2], ['360°', 5.5], ['Bild', 8.5]] as const) {
      const res = await win.webContents.executeJavaScript(`(async () => {
        const T = window.__pcTest;
        T.useUi.getState().setPlayhead(${t});
        T.engine.seek(${t});
        await new Promise((r) => setTimeout(r, 1800));
        T.engine.seek(${t});
        await new Promise((r) => setTimeout(r, 400));
        const c = document.querySelector('.preview-stage canvas');
        const r = c.getBoundingClientRect();
        let readable = true, mean = -1;
        try {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let s = 0, n = 0; for (let i = 0; i < d.length; i += 64) { s += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
          mean = s / n;
        } catch (e) { readable = false; }
        return { rect: { x: r.x + r.width * 0.1, y: r.y + r.height * 0.1, width: r.width * 0.8, height: r.height * 0.8 }, size: c.width + 'x' + c.height, css: Math.round(r.width) + 'x' + Math.round(r.height), readable, mean: Math.round(mean) };
      })()`);
      const shown = await meanOf(win, res.rect);
      out(`Vorschau ${label} bei ${t} s: sichtbar ${shown.toFixed(0)}, Canvas ${res.size} (${res.css}), lesbar ${res.readable}, Mittel ${res.mean}`);
      if (shown < 25) failures.push(`Vorschau ${label} ist schwarz`);
      if (!res.readable) failures.push(`Vorschau ${label}: Bild für KI/Farbe nicht lesbar (gesperrt)`);
    }

    // Einzelbild für KI / Bild-Assistent holen
    const grab = await win.webContents.executeJavaScript(`(async () => {
      const T = window.__pcTest;
      const p = T.useProject.getState().project;
      const clip = Object.values(p.clips).sort((a, b) => a.start - b.start)[0];
      try {
        const img = await T.engine.grabFrame(clip, p.media[clip.mediaId], 1, 320);
        if (!img) return { ok: false, msg: 'kein Bild' };
        let s = 0; for (let i = 0; i < img.data.length; i += 4) s += img.data[i];
        return { ok: true, mean: Math.round(s / (img.data.length / 4)), size: img.width + 'x' + img.height };
      } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
    })()`);
    out('Einzelbild für KI:', JSON.stringify(grab));
    if (!grab.ok || grab.mean < 20) failures.push(`Einzelbild für KI fehlgeschlagen: ${grab.msg ?? grab.mean}`);

    // Wiedergabe: läuft das Bild gleichmäßig weiter (kein Zurückspringen, keine schwarzen Bilder, kaum Nachstellen)?
    const play = await win.webContents.executeJavaScript(`(async () => {
      const T = window.__pcTest;
      const e = T.engine;
      let seeks = 0;
      // Clip in Stücke teilen (wie nach Tempo-Rampe/Grobschnitt) – die Übergänge dürfen nicht flackern
      const P = T.useProject.getState();
      const first = Object.values(P.project.clips).sort((a, b) => a.start - b.start)[0];
      let id = first.id;
      for (const at of [0.9, 1.6, 2.3]) { const nid = T.useProject.getState().splitClipAt(id, at); if (nid) id = nid; }
      await new Promise((r) => setTimeout(r, 300));
      e.seek(0.2);
      await new Promise((r) => setTimeout(r, 400));
      const els = [...e.slots.values()].map((s) => s.el).filter((el) => el instanceof HTMLVideoElement);
      const onSeek = () => seeks++;
      e.seek(0.2);
      await new Promise((r) => setTimeout(r, 600));
      for (const el of els) el.addEventListener('seeking', onSeek);
      e.play();
      const c = document.querySelector('.preview-stage canvas');
      const x = c.getContext('2d');
      let back = 0, black = 0, n = 0, last = e.time;
      const t0 = performance.now();
      while (performance.now() - t0 < 2500) {
        await new Promise((r) => setTimeout(r, 50));
        const now = e.time;
        if (now < last - 0.02) back++;
        last = now;
        const d = x.getImageData(c.width / 2 - 20, c.height / 2 - 20, 40, 40).data;
        let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
        if (s / (d.length / 4) / 3 < 12) black++;
        n++;
      }
      const at = e.time; e.pause();
      for (const el of els) el.removeEventListener('seeking', onSeek);
      return { at, back, black, samples: n, seeks };
    })()`);
    if (play.back > 0) failures.push(`Wiedergabe springt zurück (${play.back}×)`);
    if (play.black > 1) failures.push(`Schwarze Bilder beim Abspielen (${play.black}×)`);
    if (play.seeks > 2) failures.push(`Video wird beim Abspielen ständig nachgestellt (${play.seeks}×)`);
    if (play.at < 1.8) failures.push(`Wiedergabe zu langsam (bei ${play.at.toFixed(2)} s statt ~2,7 s)`);
    out('Wiedergabe:', JSON.stringify(play));
    // v0.8: Sound einfügen (echte Berechnung im Hauptprozess) und Werkzeug-Fenster öffnen
    const sfx = await win.webContents.executeJavaScript(`(async () => {
      const T = window.__pcTest;
      const id = await T.insertSfx('boom', {}, 1);
      const p = T.useProject.getState().project;
      const m = Object.values(p.media).find((x) => x.name.startsWith('Boom'));
      T.useUi.getState().openTools('hook');
      await new Promise((r) => setTimeout(r, 500));
      const tools = document.querySelectorAll('.side-item').length;
      T.useUi.getState().openDialog('none');
      return { clip: !!id && !!p.clips[id], dur: m ? m.info.duration : 0, tools };
    })()`);
    out('Sound & Werkzeuge:', JSON.stringify(sfx));
    if (!sfx.clip || Math.abs(sfx.dur - 1.8) > 0.2) failures.push('Sound-Effekt wurde nicht eingefügt');
    if (sfx.tools < 7) failures.push('Werkzeug-Fenster unvollständig');
    await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(os.tmpdir(), 'panocut-ui-test.png'), img.toPNG()));
  } catch (e) {
    failures.push(`Abbruch: ${(e as Error).stack ?? e}`);
  }
  if (failures.length) {
    out('❌ Fehler:');
    for (const f of failures) out('  -', f);
    return 1;
  }
  out('✅ Oberflächen-Test bestanden');
  return 0;
}

export async function waitForLoad(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoading()) return;
  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  await sleep(500);
}
