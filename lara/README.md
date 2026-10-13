# Lara – Bowling in Mixed Reality

Eigene Website (unabhängig von Anja): Kegel in den echten Raum stellen und mit der Hand oder dem
Controller bowlen – auf der Meta Quest im Passthrough, am Android-Handy in AR, sonst in VR oder am
Bildschirm zum Ausprobieren.

## Starten

```sh
docker run -d --name lara -p 8081:80 ghcr.io/l8tenever/lara:latest
```

oder mit `compose.example.yaml`. WebXR (Brille/Handy) braucht **HTTPS**, also z. B. hinter einen
Cloudflare-Tunnel oder Reverse-Proxy hängen. Das Image baut GitHub Actions bei jedem Push auf `main`,
der etwas unter `lara/` ändert (`.github/workflows/lara.yml`).

## Spielen

- **Kegel aufstellen:** „Kegel hier“ und auf den Boden zielen – dort steht der Kopfkegel, das
  Dreieck (10 Kegel, Originalabstand 30,5 cm) zeigt von dir weg. Beim ersten Start ist das
  Aufstellen schon aktiv.
- **Werfen (Brille):** Kugel greifen – mit der Hand (Daumen + Zeigefinger zusammen) oder dem
  Controller (Grifftaste oder Abzug, auch per Strahl aus der Ferne). Arm schwingen und loslassen:
  Richtung und Tempo kommen aus den letzten ~90 ms der Handbewegung. Nur loslassen ohne Schwung
  legt die Kugel zurück.
- **Handy:** auf den Boden tippen zum Aufstellen, dann nach oben wischen – je schneller, desto
  schneller die Kugel, seitlich wischen lenkt.
- **Bildschirm:** mit der Maus nach oben wischen.
- Werkzeugleiste (Brille, schwebt unten): Kegel hier, Neu aufstellen, Neues Spiel, Kugel holen,
  Beenden. Die Kugel schwebt nach jedem Wurf wieder rechts vor dir.

## Technik

| Datei | Inhalt |
|---|---|
| `public/lara.js` | Start, WebXR, Eingaben (Hände, Controller, Wischen), Werkzeugleiste, Ablauf |
| `public/bowling.js` | Physik (cannon-es): Kugel 6 kg/21,6 cm, Kegel 1,55 kg/38 cm aus 5 Formen, Erkennen umgefallener Kegel |
| `public/score.js` | Bowling-Wertung (Strike, Spare, 10. Frame) und Anzeigetafel |
| `public/sound.js` | Klacken, Rollen, Jubel – alles per WebAudio erzeugt |
| `public/vendor/` | three.js, cannon-es (lokal, läuft offline) |

- Physik mit 240 Schritten pro Sekunde (schnelle Kugel tunnelt nicht), Kegel werden vor dem Aufprall
  aufgeweckt, Kugel bekommt Vorwärtsdrall.
- Ein Kegel gilt als gefallen, wenn er mehr als ~37° kippt oder 12 cm vom Platz rutscht. Nach dem
  ersten Wurf eines Frames verschwinden gefallene Kegel, danach wird neu aufgestellt.
- Erkannte Wände der Quest-Raumeinrichtung bremsen die Kugel, der Boden kommt aus `local-floor`.
- Schatten von Kegeln und Kugel fallen auf den echten Boden (Schattenfänger).
- Offline: Service Worker cacht alles je Version.
