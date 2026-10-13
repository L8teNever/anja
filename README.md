# Anja – 360°-Videos im Browser, auch offline

Kleine Web-App in einem Docker-Container: zeigt 360°-Videos (equirektangular) im Browser an –
per Ziehen, Bewegungssensor am Handy oder mit VR-Brille (WebXR). Jedes Video lässt sich per
Knopf **offline speichern** und läuft danach ohne Internet weiter, inklusive Spulen.

## Starten

```sh
docker run -d --name anja -p 8080:80 -v "$PWD/videos:/videos:ro" ghcr.io/l8tenever/anja:latest
```

oder mit `compose.example.yaml`. Danach `http://localhost:8080` öffnen.

Videos (`.mp4`, `.m4v`, `.webm`) einfach in den Ordner `videos/` legen. Ein gleichnamiges
`.jpg` daneben wird als Vorschaubild genutzt. Für Handys am besten H.264-MP4, z. B.:

```sh
ffmpeg -i quelle.webm -vf scale=3840:1920 -c:v libx264 -preset slow -crf 23 \
       -pix_fmt yuv420p -movflags +faststart -c:a aac video.mp4
```

> Hinweis: Offline-Speichern braucht HTTPS (oder `localhost`), sonst gibt es keinen Service Worker.

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
| `public/index.html`, `style.css`, `app.js` | Oberfläche, Videoliste, Offline-Knopf, Update-Werkzeug |
| `public/viewer.js` | 360°-Viewer mit three.js (Ziehen, Pinch-Zoom, Sensor, WebXR) |
| `public/vr-menu.js` | Steuer-Menü im VR-Modus (Controller-Strahl, Hand-Pinch) |
| `public/sw.js` | Service Worker: App-Cache pro Version, Video-Cache mit Range-Antworten |
| `public/vendor/` | three.js (MIT), lokal mitgeliefert, damit alles offline geht |
| `nginx.conf` | Auslieferung, Cache-Header, Videoliste als JSON (`/videos/`) |
| `docker-entrypoint.sh` | setzt die Version beim Start |

Lizenz der Beispielvideos: siehe jeweilige Quelle. three.js © three.js authors, MIT.
