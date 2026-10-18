# PanoCut – Hinweise für die Arbeit am Code

PanoCut ist ein deutschsprachiger Desktop-Videoeditor (Electron + React + FFmpeg) für Mac und Windows.
Der Besitzer (BlayZzo) ist kein Entwickler: Erklärungen auf Deutsch, ohne Fachjargon, Ergebnisse als
fertige Installer über GitHub Releases.

## Architektur

- `src/main/` – Hauptprozess. `ffmpeg.ts` führt FFmpeg/ffprobe aus; `media.ts` erzeugt Thumbnail, Hover-Sprite,
  Wellenform und Proxy (540p H.264, `-g 15`) in `userData/cache/<hash>/`; `exporter.ts` baut aus der Timeline einen
  `filter_complex`-Graphen (Overlay-Kette pro Clip, `amix` für Ton); `reverse.ts` kehrt Videos stückweise um
  (nie `reverse` auf lange Clips – Speicher!); `protocol.ts` liefert Dateien unter `pcmedia://` mit Range-Support;
  `updater.ts` (Windows: electron-updater, Mac: GitHub-Releases-Abfrage + DMG-Download, da unsigniert);
  `smoke.ts` ist der CI-Selbsttest (`electron . --smoke-test`).
- `src/renderer/` – React-Oberfläche. `store/project.ts` (zustand + zundo: Rückgängig; `beginTransaction/endTransaction`
  für Schieberegler, `untracked` für Status-Updates), `store/ui.ts` (Auswahl, Abspielkopf, Zoom, Drag-Zustand, Dialoge),
  `engine/playback.ts` (Canvas-Compositor, spielt Proxys synchron, CSS-Filter ≈ FFmpeg `eq`/`hue`),
  `components/Timeline.tsx` (Drag/Trim/Split/Snap), `i18n/de.ts` (alle Texte).
- `src/shared/` – Typen (`types.ts`), Timeline-Mathematik (`timeline.ts`: `clipDuration = (out-in)/speed`,
  `sourceTimeAt` berücksichtigt `reverse`), Export-Presets.

## Regeln

- Vorschau (Engine) und Export (FFmpeg) müssen dieselbe Mathematik benutzen – Änderungen an Clip-Eigenschaften immer an
  beiden Stellen umsetzen.
- Keine Menü-Accelerator ohne Modifier (würden Tastatureingaben in Textfeldern schlucken); Einzeltasten in `useKeyboard.ts`.
- Alle Texte nach `i18n/de.ts`.
- Version in `package.json` erhöhen und auf `main` pushen → `release.yml` baut und veröffentlicht Mac + Windows (Tags/API-Writes sind aus der Cloud-Umgebung nicht möglich; `gh workflow run release.yml` geht).
  `ci.yml` läuft bei jedem Push auf `main` (Typecheck, Build, Selbsttest, Linux-Paket).
- Der Cloud-Arbeitsplatz erreicht npm nicht; prüfen mit `tools/offline-typecheck/run.sh` und über die CI (`gh run list`).

## Fahrplan

0.2: 360°-Stitching (.insv, zwei Fisheye-Streams → Equirectangular, FFmpeg `v360`), Neuausrichtung/Keyframes, Reframing;
Übergänge (`xfade`/`acrossfade`); Titel; Stabilisierung (`vidstabdetect/vidstabtransform`); Untertitel (whisper.cpp).
0.3: Tracking (OpenCV), Chroma Key (`chromakey`/`colorkey`), KI-Masken (Segmentierung), Freistellen.
0.4: Effekt-/Animations-Bibliothek, eigene Effekte, Audio-Ducking.

## Lokale Prüfung ohne npm

`tools/offline-typecheck/run.sh` prüft beide TypeScript-Projekte ohne `node_modules` (globales `tsc`, Typquellen per git,
Electron-Stub). Für den FFmpeg-Teil lässt sich `src/main/smoke.ts` mit esbuild bündeln (Alias `electron` → kleiner Shim
mit `app.getPath`, `electron-log` → console) und mit `PANOCUT_FFMPEG=/usr/bin/ffmpeg PANOCUT_FFPROBE=/usr/bin/ffprobe`
direkt unter Node ausführen. Vollständige CI-Logs sind aus der Cloud nicht abrufbar (`gh run view <id> --json jobs`
zeigt nur den Schritt-Status).
