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
- FFmpeg-Versionen: ffmpeg-static liefert für Mac/Windows 6.1, für Linux (CI) 7.0 ohne `drawtext`. Keine `scale2ref`
  (hängt in FFmpeg 7 im großen Export-Graphen) – Größen vorher mit einem 1-Bild-Durchlauf messen (`prepareCutoutSizes`).
  Neue Filter immer mit beiden Versionen testen (Binärdateien liegen unter github.com/eugeneware/ffmpeg-static/releases).
- Version in `package.json` erhöhen und auf `main` pushen → `release.yml` baut und veröffentlicht Mac + Windows (Tags/API-Writes sind aus der Cloud-Umgebung nicht möglich; `gh workflow run release.yml` geht).
  `ci.yml` läuft bei jedem Push auf `main` (Typecheck, Build, Selbsttest, Linux-Paket).
- Der Cloud-Arbeitsplatz erreicht npm nicht; prüfen mit `tools/offline-typecheck/run.sh` und über die CI (`gh run list`).

## Fahrplan

0.2 ✅: 360° (`stitch.ts`, `panogl.ts` = WebGL-Spiegel von v360, Keyframes via `sendcmd`), Übergänge (xfade auf einem
Fenster um den Schnitt, Vorschau-Näherung im Canvas), Titel (drawtext / Canvas-Text), Untertitel (whisper.cpp als
extraResource, Modell-Download nach `userData/models`; Export via ASS/libass), Stabilisierung (vidstab 2-Pass, Proxy-
Variante für die Vorschau), Export-Größenlimit (2-Pass x264/x265), 360°-Metadaten (`spherical.ts`).
0.3 ✅: KI lokal mit onnxruntime-node (`src/main/ai.ts`): YOLOX (Erkennung, BGR 0–255, Letterbox 114, Gitter 8/16/32)
und U²-Net/ISNet (rembg-Modelle, Masken); Modelle werden nach `userData/models` geladen. Tracking im Renderer
(`renderer/ai/tracking.ts`: pro Abtastzeit neu erkennen, IoU-Zuordnung), Masken als PNG im Medien-Cache, Freistellen
im Export per concat-Bildsequenz + alphamerge, in der Vorschau per Canvas `destination-in`. Green Screen: FFmpeg
`chromakey` ↔ `chromagl.ts`. Anheften: Export per Stützstellen-Ausdrücken (drawtext) bzw. ASS `\move`. Objekte als
VP9-WebM mit Alpha (`objects.ts`), Cloud per WebDAV (`cloud.ts`). Test lokal: Python-onnxruntime als Shim für
onnxruntime-node (siehe Scratch-Tests), CI prüft mit YOLOX-`dog.jpg`.
0.4 ✅: Farbe als eine Mathematik (`shared/color.ts`: `gradePixel` → 3D-LUT; Export `lut3d` mit .cube-Datei 33³,
Vorschau `colorgl.ts` mit LUT-Textur 25³), Looks, eigene .cube-LUTs, „Natürlich schön“ (`frameStats`/`autoEnhance` aus
`engine.grabFrame`). Bild-Effekte/Zuschnitt (`ImageFx`, `Crop`). Animationen (`shared/effects.ts`: Keyframes + Schwingung
`osc`; Export per `perspective`-Filter mit transparentem Rand, `motionExpr.ts`, Deckkraft per `sendcmd`/`colorchannelmixer`).
Effekt-Bibliothek (`EFFECT_BLOCKS`, eigene Effekte in den Einstellungen `userEffects`). Ducking (`sidechaincompress`,
Vorschau ≈ Pegelabsenkung). Übersetzung: whisper `-tr` (nur Englisch) bzw. eigener LibreTranslate-Server (`translate.ts`).
Fernsteuerung `remote.ts` (127.0.0.1:51888, nur POST ohne Origin) + Stream-Deck-Plugin `streamdeck/` (SDK 2, Node ohne
Abhängigkeiten, `generate.py` erzeugt Manifest + Symbole; Release-Job packt `PanoCut.streamDeckPlugin`).
0.5 ✅: Effekt-Studio (`shared/vfx.ts`: Arten, Beschreibung verstehen `parseVfxPrompt`, `matchToScene`, `shakeKeyframes`;
`renderer/vfx/shaders.ts` GLSL je Art, `render.ts` rendert Bild für Bild per WebGL → IPC `vfxBegin/vfxFrame/vfxEnd` →
`main/vfx.ts` kodiert über stdin zu VP9-WebM mit Alpha; Lichtschein als eigenes WebM, verknüpfter Clip mit Mischmodus
„screen“, Größe ×3 (`LIGHT_SCALE`)). Ganzbild-Effekte sind mit ihrer Dauer periodisch (nahtlos aneinanderreihbar).
Ebenen (`shared/layers.ts`): Mischmodi (Canvas `globalCompositeOperation` ↔ FFmpeg `blend` auf gbrp + alphamerge über
transparente Vollbild-Fläche), Schlagschatten (Canvas shadowBlur = 2σ ↔ `gblur=sigma`), verknüpfte Clips `link`
(Store-Setter führt sie per `syncLinkedClips` nach). Objekt nach vorne = verknüpfte Kopie mit Freistellen auf neuer
oberster Spur. Masken-Pinsel in der Vorschau (`components/previewTools.ts`), Masken sind Graustufen-PNGs (Vorschau rechnet
Helligkeit → Alpha). Ziehen/Mausrad in der Vorschau verschiebt/skaliert den ausgewählten Clip.
0.6 ✅: Bild-Assistent (`shared/rescue.ts`: `analyzeClip`/`rescueGrade`; Belichtungskurve `exposureCurve` = Faktor vor der LUT,
Export per `sendcmd`/`colorchannelmixer` in rgb48le), Kamera-Profile (`decodeLog` in `color.ts`). Takt (`shared/beats.ts`: Mel-Onset,
Tempo per Autokorrelation, DP-Beat-Tracking; Rechnung im Worker `main/audioWorker.ts` → `dist/main/audioWorker.js`), Auto-Schnitt
`shared/beatcut.ts`. Clip-Teilen über `shared/clipslice.ts` (verschiebt alle Clip-lokalen Zeiten). Dynamische Übergänge
(`shared/transitions.ts` `dynTransitionAt` ↔ Export `exporter.dynamicTransition`: perspective-Ecken pro Bild + sendcmd für
gblur/dblur/rgbashift/Deckkraft/Blitz; `perspective`-Variable `in` zählt ab 1!). 360°-Fahrten/Tempo-Rampen `shared/cameraMoves.ts`.
Auftritte `entranceKeyframes` (effects.ts) + VFX-Art `impact`. Mehrkamera `shared/multicam.ts` (Kreuzkorrelation der
Onset-Hüllkurven, `project.multicam`, Stücke mit `clip.mc`, stabile IDs). 3D: three.js 0.170 (devDependency, per `import()`
nachgeladen) `renderer/three/` → Bilder über die VFX-Jobs (`vfxBegin` mit `model`) zu VP9-Alpha; Draco-Dekoder in
`renderer/public/draco` (im fertigen Programm über `pcmedia:` geladen, CSP `wasm-unsafe-eval`, `worker-src blob:`).
0.7: Übersetzung in weitere Sprachen ohne Server, weitere Effekte, Mehrkamera-Winkel in der Timeline; bei Bedarf zweites
Programm für Bild/Objekte (gleiche Codebasis `src/shared`).
Leistung: muss auf einem MacBook Air (M-Serie, 2024) flüssig laufen – Proxys, WebGL, Hintergrund-Jobs mit niedriger Priorität.

## Lokale Prüfung ohne npm

`tools/offline-typecheck/run.sh` prüft beide TypeScript-Projekte ohne `node_modules` (globales `tsc`, Typquellen per git,
Electron-Stub, three.js-Typen aus three-ts-types r170). Für den FFmpeg-Teil lässt sich `src/main/smoke.ts` mit esbuild bündeln (Alias `electron` → kleiner Shim
mit `app.getPath`, `electron-log` → console) und mit `PANOCUT_FFMPEG=/usr/bin/ffmpeg PANOCUT_FFPROBE=/usr/bin/ffprobe`
direkt unter Node ausführen. Vollständige CI-Logs sind aus der Cloud nicht abrufbar (`gh run view <id> --json jobs`
zeigt nur den Schritt-Status).
