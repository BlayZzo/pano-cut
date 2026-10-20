## PanoCut 0.7.2 – Schneller importieren, mit Fortschrittsanzeige

**Installieren**
- Mac mit Apple-Chip (M1–M4): `PanoCut-0.7.2-mac-arm64.dmg`
- Mac mit Intel: `PanoCut-0.7.2-mac-x64.dmg`
- Windows 10/11: `PanoCut-0.7.2-win-x64.exe`

Wenn PanoCut schon installiert ist, wird das Update beim Start angeboten.

**Neu in 0.7.2**
- **Fortschritt mit Restzeit**: Jede Datei in der Mediathek zeigt, was gerade passiert („Vorschau 42 % · ~1:23 min“, „360° …“, „Wartet …“). Oben in der Leiste steht, wie viele Dateien noch vorbereitet werden, der Gesamtfortschritt und wie lange es noch ungefähr dauert.
- **Viel schnellerer Import**: Normale Full-HD-Videos (Handy, Kamera, H.264) brauchen keine eigene Vorschau-Datei mehr – sie sind sofort fertig. Vorschau-Dateien werden nur noch für 4K, HEVC/H.265, 10-Bit- und 360°-Videos erstellt. (Einstellungen → „Vorschau-Dateien: Immer“, wer lieber immer welche möchte.)
- **Auf dem Mac zwei Dateien gleichzeitig** über den Grafikchip, auch beim 360°-Zusammensetzen.
- Die Tonwelle wird aus der kleinen Vorschau-Datei berechnet statt aus dem riesigen Original.
- **Flüssiger auf dem MacBook Air**: Die Vorschau zeichnet beim Abspielen nur noch so oft wie das Video Bilder hat (z. B. 30× statt 60–120× pro Sekunde) – spart Akku und Rechenzeit.
- Abgebrochene Vorbereitungen hinterlassen keine kaputten Vorschau-Dateien mehr.
- Ein automatischer Test auf einem echten Mac prüft jetzt auch 4K-HEVC-Videos und die Fortschrittsanzeige.

## PanoCut 0.7.1 – Vorschau repariert, Bereiche verschiebbar, Ansicht-Einstellungen

**Installieren**
- Mac mit Apple-Chip (M1–M4): `PanoCut-0.7.1-mac-arm64.dmg`
- Mac mit Intel: `PanoCut-0.7.1-mac-x64.dmg`
- Windows 10/11: `PanoCut-0.7.1-win-x64.exe`

Wenn PanoCut schon installiert ist, wird das Update beim Start angeboten.

**Neu in 0.7.1**
- **Vorschau zeigt wieder das Bild**: Eine unsichtbare Ebene (für den Auswahlrahmen) hatte einen schwarzen Hintergrund und lag über dem Bild. Behoben – und ab jetzt prüft ein automatischer Test auf einem echten Mac und unter Linux bei jeder Änderung, dass die Vorschau ein Bild zeigt.
- **Bereiche verschiebbar**: Die Trennlinien zwischen Mediathek, Vorschau, Inspektor und Timeline lassen sich mit der Maus ziehen. Ganz zusammenschieben blendet eine Seite aus, Doppelklick stellt die Standardgröße wieder her. Die Größen werden gemerkt.
- **⚙ Ansicht (Vorschau)**: Qualität (Automatisch / Voll / Halb / Viertel), Hilfslinien (Drittel-Raster, sicherer Bereich für Social Media), Auswahlrahmen (immer / nur mit Maus über der Vorschau / nie), Karomuster-Hintergrund, Mediathek/Inspektor ein- und ausblenden.
- **⚙ Ansicht (Timeline)**: Spurhöhe klein/mittel/groß, Vorschaubilder und Tonwellen ein/aus, Mitscrollen beim Abspielen, Einrasten. Viel weiter herauszoomen (über 2 Stunden auf einen Blick); Tasten **+** / **−** zoomen, **Z** zeigt alles.
- **Schnellerer Import**: Mehrere Dateien werden gleichzeitig eingelesen; 360°-Rohdateien zeigen sofort ein Vorschaubild, das Zusammensetzen läuft im Hintergrund. Ein kleines Symbol auf der Karte zeigt, dass noch eine Vorschau-Datei erstellt wird – die Datei kann trotzdem schon benutzt werden.
- **Nichts läuft mehr ungefragt**: Der Takt von Musik wird nur noch auf Knopfdruck erkannt; KI-Erkennung lief schon bisher nur über den Knopf „Objekte erkennen“. Der Rahmen um den ausgewählten Clip erscheint nur noch, wenn die Maus über der Vorschau ist.
- KI, Bild-Assistent, Masken und 3D-Texturen dürfen die Medien jetzt sicher lesen (vorher konnten sie im fertigen Programm blockiert sein).

## PanoCut 0.7.0 – Untertitel für Social Media, neue Effekte, flüssiger

**Installieren**
- Mac mit Apple-Chip (M1–M4): `PanoCut-0.7.0-mac-arm64.dmg`
- Mac mit Intel: `PanoCut-0.7.0-mac-x64.dmg`
- Windows 10/11: `PanoCut-0.7.0-win-x64.exe`
- Elgato Stream Deck: `PanoCut.streamDeckPlugin` laden und doppelt anklicken

Wenn PanoCut schon installiert ist, wird das Update beim Start angeboten.

**Neu in 0.7**
- **Untertitel für Social Media**: Viele schauen ohne Ton – jetzt leuchtet das gerade gesprochene Wort farbig auf. Vier Vorlagen: „Social Media“ (groß, Wort leuchtet), „Wort für Wort“ (wenige Wörter, sehr groß, Großbuchstaben), „Kasten“ und „Klassisch“. Farbe, Wörter gleichzeitig und Großbuchstaben einstellbar. Vorschau und Export sehen gleich aus.
- **Deutsch ↔ Englisch übersetzen – ohne Server, ohne Abo**: Gesprochen wird Deutsch oder Englisch, darunter steht die andere Sprache (oder nur die Übersetzung). Der Übersetzer stammt aus Firefox und läuft komplett auf deinem Rechner; beim ersten Mal werden ca. 40 MB geladen. Nach Textänderungen: „Übersetzung neu erzeugen“.
- **Sechs neue Effekte** im Effekt-Studio: 🌞 Linsenreflex, 🔆 Bokeh-Lichter, 🏎️ Speed-Linien, 🎞️ Lichtlecks (Film-Look), 💖 Herzen, 🌟 Glitzer – alle nahtlos wiederholbar; Licht-Effekte hellen das Bild auf wie echtes Licht.
- **Flüssiger**: Die Vorschau rechnet nur noch in der Größe, in der sie angezeigt wird. Bedienfelder zeichnen sich während der Wiedergabe nicht mehr ständig neu. Beim Import vieler Dateien erscheinen erst alle Vorschaubilder, dann werden die Vorschau-Dateien erzeugt – auf dem Mac jetzt mit dem Grafikchip (schneller, schont den Akku). Vorschau-Streifen langer Videos sind bis zu 8× schneller fertig. Bei sehr vielen Clips wird Speicher freigegeben.

## PanoCut 0.6.0 – Musik-Schnitt, Mehrkamera, 3D-Objekte

**Installieren**
- Mac mit Apple-Chip (M1–M4): `PanoCut-0.6.0-mac-arm64.dmg`
- Mac mit Intel: `PanoCut-0.6.0-mac-x64.dmg`
- Windows 10/11: `PanoCut-0.6.0-win-x64.exe`
- Elgato Stream Deck: `PanoCut.streamDeckPlugin` laden und doppelt anklicken (neu: Tasten „Kamera 1–4“)

Wenn PanoCut schon installiert ist, wird das Update beim Start angeboten.

**Neu in 0.6**
- **✦ Bild-Assistent** (Knopf „✦ Bild“): erkennt zu dunkle, zu helle, flaue oder flackernde Aufnahmen und passt sie automatisch an – auch Helligkeit, die sich über die Zeit angleicht (Tunnel, Wolken). Histogramm vorher/nachher, „Vorher“ gedrückt halten zum Vergleichen. Kamera-Profile **Blackmagic Film** und **DJI D-Log**.
- **♫ Auto-Musik-Schnitt**: Der Takt der Musik wird erkannt, Taktmarken erscheinen in der Timeline, Clips rasten darauf ein. „Auf den Takt schneiden“ verteilt die Video-Clips auf die Schläge (jeder Schlag, jeder 2., jeder Takt oder nach Lautstärke) – mit Zoom-Stoß, Wackeln oder Blitz auf der Takt-Eins.
- **Dynamische Übergänge mit Stärke**: Zoom-Durchflug, Wisch-Schwenk (4 Richtungen), Drehung, Blitz, Wackeln, Glitch.
- **🎬 360°-Kamerafahrten**: Rundum-Schwenk, Peitschen-Schwenk 180°, Schulterblick, Planet → Normal und zurück, Zoom-Stoß, Drohnen-Aufstieg, Fassrolle, Pendel-Schwenk – mit Dauer und Stärke.
- **Tempo-Rampen**: Schnell → Zeitlupe → Schnell, Hero-Moment, Ausbremsen, Beschleunigen.
- **⤓ Objekte ins Video fallen lassen**: Freigestellte Objekte und 3D-Objekte fallen herab, schlagen auf oder rasen herein. Beim Aufprall: Staubwolke in der Farbe des Bodens, Druckwelle, Trümmer und Erschütterung – alles mit Stärke.
- **🎥 Mehrkamera**: Clips mehrerer Kameras werden über den Ton synchronisiert. Alle Kameras laufen unter der Vorschau mit; mit 1–9 (oder Stream Deck) umschneiden, auch live. Ton-Kamera wählbar, „Automatisch wechseln“ im Takt der Musik.
- **🧊 3D-Objekte**: glTF/GLB, OBJ, FBX, STL einfügen – mit Bewegung, eigenen Animationen der Datei, Licht passend zum Video und Bodenschatten.
- Verbessert: Animationen im Export liegen jetzt bildgenau auf der Vorschau (vorher ein Bild später). Beim Teilen eines Clips bleiben 360°-Blick, Animation und Untertitel an der richtigen Stelle.
- Blackmagic RAW (.braw): PanoCut erklärt beim Import, wie es geht (in DaVinci Resolve kostenlos als ProRes exportieren) – das RAW-Format selbst lässt sich nur mit Blackmagics nicht freier Software lesen.
