# Anja – 360°-Videos im Browser, auch offline

Kleine Web-App in einem Docker-Container: zeigt 360°-Videos (equirektangular) im Browser an –
per Ziehen, Bewegungssensor am Handy oder mit VR-Brille (WebXR). Jedes Video lässt sich per
Knopf **offline speichern** und läuft danach ohne Internet weiter, inklusive Spulen.

## Starten

```sh
docker run -d --name anja -p 8080:80 -v "$PWD/videos:/videos" ghcr.io/l8tenever/anja:latest
```

oder mit `compose.example.yaml`. Danach `http://localhost:8080` öffnen.

Videos (`.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv`) einfach in den Ordner `videos/` legen. Ein gleichnamiges
`.jpg` daneben wird als Vorschaubild genutzt. Für Handys am besten H.264-MP4, z. B.:

```sh
ffmpeg -i quelle.webm -vf scale=3840:1920 -c:v libx264 -preset slow -crf 23 \
       -pix_fmt yuv420p -movflags +faststart -c:a aac video.mp4
```

> Hinweis: Offline-Speichern braucht HTTPS (oder `localhost`), sonst gibt es keinen Service Worker.

## Videos hochladen

Oben auf den lila Pfeil tippen (oder am PC ein Video ins Fenster ziehen). Erlaubt sind `.mp4`,
`.m4v`, `.webm` und `.mov`. Vor dem Hochladen prüft die App:

- ob das Gerät das Video abspielen kann (Warnung z. B. bei HEVC/H.265),
- ob es ein 360°-Format ist: 2:1 normal, 1:1 = 3D übereinander, 4:1 = 3D nebeneinander –
  sonst kommt eine Warnung,
- und macht aus einem Bild des Videos automatisch das Vorschaubild (`.jpg`).

Große Videos gehen in 16-MB-Stücken hoch, drei gleichzeitig (schneller, und es passt durch
Cloudflare). Bricht die Verbindung ab oder geht das Handy schlafen, wird automatisch neu
versucht. Wird die Seite geschlossen, merkt sich die App den Upload: beim nächsten Öffnen
steht er als „pausiert“ da, und wählt man dieselbe Datei nochmal, geht es genau dort weiter.
Halbfertiges liegt in `videos/.parts` und wird nach 7 Tagen weggeräumt.

Der Dateiname wird bereinigt (Umlaute → ae/oe/ue, Sonderzeichen raus), gleiche Namen bekommen
`-2`, `-3` … Fortschritt, Tempo und Restzeit werden angezeigt, der Bildschirm bleibt dabei an.

Die Dateien landen im Video-Ordner auf dem Server (Volume `/videos`). **Updates ändern daran
nichts** – ein Video ist erst weg, wenn man es löscht: über das Papierkorb-Symbol auf dem
Vorschaubild (mit Rückfrage) oder direkt im Ordner auf dem Server.

Hochladen geht nur, wenn das Volume beschreibbar ist (ohne `:ro`). Mit `:ro` ist der Knopf
einfach ausgeblendet. Achtung: Jeder, der die App erreicht, kann hochladen und löschen –
also nur im eigenen Netz/VPN oder hinter einer Anmeldung betreiben.

3D-360°-Videos (übereinander/nebeneinander) werden erkannt: in der VR-Brille sieht jedes Auge
sein eigenes Bild, sonst wird das linke Bild gezeigt.

## Alle 360°-Formate

Die App erkennt das Format selbst und rechnet es auf der Grafikkarte richtig um
(Formeln wie ffmpeg `v360`, siehe `public/projection.js`):

| Format | Typisch |
|---|---|
| 360° equirektangular (2:1) | die meisten 360°-Kameras/Exporte |
| 180° / VR180 | VR180-Kameras, viele VR-Filme – auch auf 2:1 gestreckt (erkannt an der nicht passenden Naht) |
| 3D übereinander / nebeneinander (auch Augen vertauscht) | 3D-360° und 3D-180° |
| Fischauge (180–220°, mono oder 3D) | VR180-Rohmaterial, `_MKX200`, `_FISHEYE190` |
| Doppel-Fischauge 360° | Rohdateien von 360°-Kameras |
| YouTube-Würfel (EAC), Würfel 3×2 / 6×1 / 1×6 | YouTube-Downloads, Cubemaps |
| Flach | normale Videos als Kino-Leinwand |

Erkennung in dieser Reihenfolge: für alle gespeichert (`<name>.json` neben dem Video) →
auf dem Gerät gemerkt → Dateiname (`_180_LR`, `_TB`, `_360`, `_EAC` …) → Metadaten im
Video (Google Spatial Media in MP4, StereoMode/Projection in MKV/WebM) → Bildanalyse
(Seitenverhältnis, Vergleich der Bildhälften, schwarze Fischaugen-Ecken). Im Player
(Globus-Symbol) lässt sich alles von Hand umstellen und „für alle speichern“.
Beim Hochladen wird das Format gleich erkannt, mitgespeichert und das Vorschaubild
in jedem Format richtig erzeugt.

## Greenscreen & Durchsicht (dein Zimmer hinter dem Video)

Im Player oben auf das Ebenen-Symbol tippen:

- **Hintergrund durchsichtig** – ausgestanzt wird nach Farbton, Farbstärke und Helligkeit,
  so klappt auch blasses/helles Grün, Haut, Weiß und Grau bleiben stehen. Videos mit
  „green“, „gruen“, „chroma“ oder „keying“ im Namen starten automatisch mit Greenscreen.
- **Auto** sucht die Hintergrundfarbe selbst, **Pipette**: einmal ins Video aufs Grün tippen.
- **Farbton-Bereich, Mindest-Sättigung, Weiche Kante, Kante schrumpfen, Grünstich weg,
  Helligkeit ab/bis** – Feinabstimmung. **Maske zeigen** (weiß bleibt, schwarz weg) hilft
  beim Einstellen. Gemerkt pro Video und Gerät, „Für alle speichern“ legt es auf den Server.
- **Handy-Kamera dahinter** – am Handy läuft das Bild der Rückkamera hinter dem Video,
  der Bewegungssensor geht dabei mit an.
- **Durchsicht** (Knopf oben, nur wenn das Gerät WebXR-AR kann, z. B. Meta Quest oder
  Android-Chrome) – startet die Brille im Passthrough: die grünen Stellen zeigen dein Zimmer.
  Greenscreen schaltet sich dabei automatisch ein.

Im VR-Menü der Brille schaltet „Grün weg“ den Greenscreen an und aus.
Kamera und Durchsicht brauchen HTTPS.

## Position, Größe und Zoom

Im Player unten das Pfeilkreuz: **Größe** (kleiner = Video weiter weg, auch in der Brille),
**Drehen**, **Neigen**, **Kippen** und der Bildschirm-**Zoom** (20–140°, auch per Mausrad
oder zwei Fingern). Wird pro Video gemerkt. In der Brille: **Grifftaste halten und
Controller bewegen** dreht das Video mit; kurz drücken öffnet das Menü.

## Hände

Im Player unten die Hand:
- **Hand-Tracking** – in der Brille (VR oder Durchsicht) zeigt der Browser deine Hände.
  In VR als Hände im Bild, in der Durchsicht werden sie aus dem Video ausgeschnitten,
  damit man die echten Hände durch die Kamera sieht. Controller einfach ablegen.
  Im VR-Menü schaltet „Hände“ das an und aus.
- **Rotes Band** – am Handy: ein rotes Band (z. B. ums Handgelenk) wird von der Kamera
  gesucht, und das Video wird um die Hand herum durchsichtig. Loch-Größe und
  Rot-Empfindlichkeit einstellbar, „Erkanntes Rot markieren“ zeigt, was gefunden wurde.

## Raus aus VR / Durchsicht

- **Brille:** unten im Blickfeld schwebt immer ein kleiner Griff „Menü | Beenden“.
  Draufzeigen und Abzug/Pinch. Im großen Menü gibt es zusätzlich „Beenden“.
- **Handy im Durchsicht-Modus:** Bildschirm-Knöpfe über dem Kamerabild
  (Beenden, Pause, ±10 s, Grün, Ausrichten).
- **Überall:** Zurück-Taste/-Geste (bzw. Escape) beendet VR/Durchsicht; ein zweites
  Zurück schließt den Player.

## Steuerung in der VR-Brille

Im VR-Modus schwebt ein eigenes Menü vor dir: Abspielen/Pause, ±10 Sekunden, Fortschrittsbalken
zum Spulen (Strahl drauf, Abzug halten und ziehen), Ton an/aus, Ausrichten (Videomitte dorthin,
wo du gerade hinschaust), Ausblenden und VR beenden. Bedienung per Controller-Strahl, Hand-Pinch
oder Blick+Pinch. **Abzug/Pinch ins Leere** oder die Grifftaste blendet das Menü ein und aus;
beim Abspielen verschwindet es nach 8 Sekunden ohne Bedienung von selbst.

## Updates – nie auf altem Code hängen bleiben

- Jeder Build bekommt eine Versionsnummer (`1.0.<Build-Nummer>`). Sie steckt in `sw.js`,
  `app.js` und `/version.json`.
- Die App fragt beim Start, jede Minute und beim Zurückkehren in den Tab `/version.json`
  ohne Cache ab. Ist eine neue Version da, erscheint oben **„Neue Version verfügbar – Aktualisieren“**.
- „Aktualisieren“ löscht alle App-Caches, meldet den Service Worker ab und lädt frisch.
  **Offline gespeicherte Videos bleiben dabei erhalten.**
- Zusätzlich räumt der neue Service Worker beim Aktivieren alte App-Caches selbst weg,
  und `index.html`, `sw.js` und `version.json` werden nie aus dem HTTP-Cache geliefert.
- Im Menü (⋮) gibt es „Nach Updates suchen“, „App reparieren“ (Cache leeren, Videos bleiben)
  und „Alles zurücksetzen“.

### Server automatisch aktualisieren

Bei jedem Push auf `main` baut GitHub Actions das Image neu (`:latest` und `:1.0.N`).
`update.sh` holt es und startet den Container nur bei Änderungen neu – z. B. per Cron:

```
*/5 * * * * /pfad/zu/anja/update.sh >> /pfad/zu/anja/update.log 2>&1
```

## Aufbau

| Datei | Zweck |
|---|---|
| `public/index.html`, `style.css`, `app.js` | Oberfläche, Videoliste, Hochladen, Offline-Knopf, Update-Werkzeug |
| `public/viewer.js` | 360°-Viewer mit three.js (Ziehen, Pinch-Zoom, Sensor, WebXR) |
| `public/vr-menu.js` | Steuer-Menü im VR-Modus (Controller-Strahl, Hand-Pinch) |
| `public/sw.js` | Service Worker: App-Cache pro Version, Video-Cache mit Range-Antworten |
| `public/vendor/` | three.js (MIT), lokal mitgeliefert, damit alles offline geht |
| `public/projection.js` | Formate: Erkennung, Umrechnung, Vorschaubilder, Greenscreen-Auto |
| `upload.js` | Hochladen in Stücken mit Fortsetzen (nginx-njs) |
| `nginx.conf` | Auslieferung, Cache-Header, Videoliste als JSON (`/videos/`), Hochladen/Löschen (`/upload/`) |
| `docker-entrypoint.sh` | setzt die Version beim Start |

Lizenz der Beispielvideos: siehe jeweilige Quelle. three.js © three.js authors, MIT.
