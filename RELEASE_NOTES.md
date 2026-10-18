## PanoCut 0.2.0 – 360°, Übergänge, Titel, Untertitel

**Installieren**
- Mac mit Apple-Chip (M1–M4): `PanoCut-0.2.0-mac-arm64.dmg`
- Mac mit Intel: `PanoCut-0.2.0-mac-x64.dmg`
- Windows 10/11: `PanoCut-0.2.0-win-x64.exe`

Beim ersten Start auf dem Mac: Systemeinstellungen → Datenschutz & Sicherheit → „Trotzdem öffnen“ (siehe README). Unter Windows beim SmartScreen-Hinweis „Weitere Informationen → Trotzdem ausführen“.

**Neu in 0.2**
- **360°-Videos**: Insta360-Rohdateien (`.insv`, `.lrv`) werden automatisch zusammengesetzt (Stitching). Drei Ansichten pro Clip: *Ausschnitt* (normales Video – in der Vorschau mit der Maus umschauen, Mausrad zoomt), *Ganzes Panorama* und *Little Planet*. Kamerafahrten mit Keyframes, weich oder linear. Export als normales Video oder als echtes 360°-Video mit Metadaten für YouTube/Facebook.
- **Übergänge**: 20 Arten (Überblenden, Wischen, Schieben, Kreis, Zoom, Pixel, Unschärfe …) – aus der Mediathek auf einen Clip ziehen, Dauer im Inspektor.
- **Titel**: Vorlagen (Einfach, Kasten, Bauchbinde, Meme, Social-Media, Schreibmaschine), frei einstellbar in Schrift, Größe, Farbe, Position, Kasten, Schatten, Umrandung, Animation.
- **Automatische Untertitel**: Sprache wird lokal erkannt (whisper.cpp, Modell wird einmalig geladen – kein Abo, nichts geht ins Internet außer dem Modell-Download). Kurze Einblendungen im Social-Media-Stil, Text und Zeiten bearbeitbar, Aussehen frei wählbar.
- **Stabilisierung** für wacklige Aufnahmen (Stärke und Zuschnitt einstellbar).
- **Export mit maximaler Dateigröße** (z. B. 16 MB für WhatsApp) – die Qualität wird passend berechnet.
- **Kleinere Installer**: FFprobe entfernt, Mac-Download ohne ZIP-Duplikat, stärkere Kompression.
- Fehlerschutz: Die Oberfläche bleibt bedienbar, auch wenn intern etwas schiefgeht.
