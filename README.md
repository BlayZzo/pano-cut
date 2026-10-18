<p align="center">
  <img src="build/icon.png" width="128" alt="PanoCut" />
</p>

<h1 align="center">PanoCut</h1>

<p align="center">Videoschnitt für 360°-, Kamera- und Drohnenvideos – alles in einem Programm.<br/>Für Mac und Windows. Auf Deutsch. Kostenlos.</p>

---

## Installieren

Die fertigen Installer liegen unter **[Releases](https://github.com/BlayZzo/pano-cut/releases/latest)**.

| System | Datei | Hinweis |
|---|---|---|
| **Mac mit Apple-Chip** (M1–M4) | `PanoCut-x.y.z-mac-arm64.dmg` | DMG öffnen, PanoCut in „Programme“ ziehen |
| **Mac mit Intel** | `PanoCut-x.y.z-mac-x64.dmg` | wie oben |
| **Windows 10/11** | `PanoCut-x.y.z-win-x64.exe` | Installer starten (Desktop-Icon wird angelegt) |

**Erster Start auf dem Mac:** PanoCut ist (noch) nicht bei Apple registriert. Beim ersten Öffnen sagt macOS deshalb, die App könne nicht geprüft werden. So geht es trotzdem:

1. PanoCut einmal doppelklicken (es erscheint die Warnung – „Fertig“ klicken).
2. **Systemeinstellungen → Datenschutz & Sicherheit** öffnen, nach unten scrollen und bei PanoCut auf **„Trotzdem öffnen“** klicken.

Das ist nur beim allerersten Start nötig. Alternativ im Terminal: `xattr -dr com.apple.quarantine /Applications/PanoCut.app`

**Windows:** Beim ersten Start kann der SmartScreen-Filter warnen („Unbekannter Herausgeber“). Auf **„Weitere Informationen“ → „Trotzdem ausführen“** klicken.

### Deinstallieren

- **Mac:** Menü **PanoCut → PanoCut deinstallieren …** (legt die App in den Papierkorb und löscht Cache und Einstellungen).
- **Windows:** Startmenü → **PanoCut deinstallieren**, oder über „Apps & Features“. Der Deinstaller entfernt auch Cache und Einstellungen.

Deine Videos und Projektdateien (`.panocut`) bleiben in beiden Fällen erhalten.

### Updates

PanoCut prüft beim Start, ob es eine neue Version gibt, und zeigt dann oben eine Leiste.
- **Windows:** Update herunterladen → installieren (automatisch).
- **Mac:** Update herunterladen → der Installer öffnet sich; PanoCut neu in „Programme“ ziehen.

Außerdem: **Hilfe → Nach Updates suchen …**

---

## So funktioniert's

1. **Importieren** – Videos, Bilder und Musik per Drag & Drop in die Mediathek ziehen (oder „Importieren“). PanoCut erzeugt im Hintergrund kleine Vorschau-Dateien, damit alles flüssig läuft – auch bei 4K und 360°.
2. **Hover-Vorschau** – mit der Maus über eine Kachel fahren, um den Clip grob durchzuspulen.
3. **In die Timeline ziehen** – Clips auf die Video- oder Audiospuren ziehen. Sie rasten an anderen Clips und am Abspielkopf ein.
4. **Schneiden** – Abspielkopf setzen und **S** drücken (oder die Schere). Ränder ziehen zum Trimmen.
5. **Bearbeiten** – im Inspektor rechts: **Tempo** (Zeitlupe/Zeitraffer), **Rückwärts**, **Lautstärke** mit Ein-/Ausblenden, **Position & Größe**, **Deckkraft**, **Helligkeit/Kontrast/Sättigung/Farbton**.
6. **Exportieren** – **⌘/Strg + E**: Preset wählen (Handy 9:16, Quadrat, Full HD, 4K, WhatsApp, ProRes, GIF), Qualität einstellen, fertig. Auf dem Mac danach direkt **„In Fotos importieren“** – und von dort per WhatsApp teilen.

**Rückgängig** mit ⌘/Strg + Z, so oft du willst. Alle Tastenkürzel unter **Hilfe → Tastenkürzel**.

### Unterstützte Dateien

- **Video:** MP4, MOV, M4V, MKV, AVI, WebM, MTS/M2TS, MXF, Insta360 `.insv`/`.lrv`, GoPro `.360`
- **Audio:** MP3, WAV, AAC/M4A, FLAC, OGG, AIFF
- **Bilder:** JPG, PNG, WebP, GIF, BMP, TIFF, HEIC, Insta360 `.insp`

> **Blackmagic:** ProRes- und H.264/H.265-Aufnahmen funktionieren. **Blackmagic RAW (.braw)** braucht ein eigenes SDK und ist noch nicht dabei.
> **Insta360:** `.insv`-Rohdateien werden derzeit mit einer Linse angezeigt; das vollständige Zusammenfügen (Stitching) und die 360°-Neuausrichtung kommen in Version 0.2.

---

## Fahrplan

| Version | Inhalt |
|---|---|
| **0.1** ✅ | Mediathek mit Hover-Vorschau, Timeline (Spuren, Schneiden, Trimmen, Einrasten), Tempo/Zeitlupe/Zeitraffer, Rückwärts, Bild- und Tonbearbeitung, Export-Presets, Fotos-Import (Mac), Auto-Update, Installer/Deinstaller |
| **0.2** | 360°: Stitching der Insta360-Rohdateien, Neuausrichtung mit Keyframes, Reframing auf 16:9/9:16 · Übergänge · Titel/Text · Stabilisierung · automatische Untertitel |
| **0.3** | Tracking · Green Screen / Chroma Key · KI-Masken für Personen und Objekte · Freistellen und Überlagern |
| **0.4** | Effekt- und Animations-Bibliothek · eigene Effekte · Audio-Ducking · Mehrkamera |

---

## Für Entwickler

```bash
npm install          # Abhängigkeiten (lädt FFmpeg für dein System)
npm run dev          # Entwicklung mit Live-Reload
npm run typecheck    # TypeScript prüfen
npm run package      # Installer für das aktuelle System bauen (→ release/)
```

**Neue Version veröffentlichen:** Version in `package.json` erhöhen, committen und auf `main` pushen – GitHub Actions erkennt die neue Version, baut die Mac- und Windows-Installer und veröffentlicht sie als Release. (Alternativ: Tag setzen oder den Release-Workflow manuell starten.)

```bash
npm version patch --no-git-tag-version   # z. B. 0.1.0 → 0.1.1
git commit -am "Version 0.1.1" && git push
```

Installierte PanoCut-Versionen finden das Update automatisch.

### Aufbau

```
src/main/      Electron-Hauptprozess: FFmpeg, Medien-Import, Export, Projektdateien, Updates
src/renderer/  Oberfläche (React): Mediathek, Vorschau-Engine, Timeline, Inspektor, Dialoge
src/shared/    Gemeinsame Typen und Timeline-Logik
build/         Icon, Installer-Texte
```

PanoCut basiert auf [Electron](https://www.electronjs.org/) und [FFmpeg](https://ffmpeg.org/). Lizenz: MIT.
