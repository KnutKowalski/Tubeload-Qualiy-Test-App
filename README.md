# TubeLoad QA

Misst, wie gut YouTube-Videos über die **eigene Netzwerkverbindung** abgespielt werden:
Bandbreite, Puffer, Startzeit, Stalls (Ruckler), tatsächliche Auflösung, verworfene Frames
sowie CPU- und RAM-Last des Browsers. Die Ergebnisse erscheinen in einem lokalen Dashboard
und lassen sich als CSV exportieren.

> **Hinweis:** Die App ist ein Messwerkzeug. Sie ist nicht dafür gedacht, Aufrufzahlen,
> Wiedergabezeit oder andere Kennzahlen zu beeinflussen. Es gelten die
> [Nutzungsbedingungen von YouTube](https://www.youtube.com/t/terms). Deshalb sind Sessions
> bewusst begrenzt (siehe [Grenzwerte](#grenzwerte)) und es gibt keine Funktion, die
> Zuschauerverhalten simuliert.

## Bestandteile

| Teil | Ordner | Beschreibung |
| --- | --- | --- |
| Desktop-App | `desktop/` | Electron-Fenster mit lokalem Dashboard. Linux, macOS, Windows. |
| Core | `desktop/core/` | Node.js/TypeScript. Steuert per Playwright einen installierten Chrome/Chromium/Edge, misst, speichert, bedient Dashboard und API. |
| Android-App | `android/` | Einfacher Abspieltest über die YouTube-IFrame-API in einer WebView. |

## Fertige Programme bauen (GitHub Actions)

1. Auf GitHub: **Actions → Build Apps → Run workflow** (Branch wählen) – oder ein Tag `v…` pushen.
2. Nach Ende des Laufs unter **Artifacts** herunterladen:
   - `desktop-ubuntu-latest`: `.AppImage` und `.deb`
   - `desktop-macos-latest`: `.dmg` und `.zip`
   - `desktop-windows-latest`: Installer (`…-setup.exe`) und portable `.exe`
   - `android-debug-apk`: `.apk`

Die Builds sind **nicht signiert**:

- **macOS:** Beim ersten Start Rechtsklick → *Öffnen*, oder `xattr -dr com.apple.quarantine "TubeLoad QA.app"`.
- **Windows:** SmartScreen zeigt „Unbekannter Herausgeber“ → *Weitere Informationen → Trotzdem ausführen*.
- **Android:** Es ist ein Debug-APK. Installation erfordert „Apps aus unbekannten Quellen“.
- **Linux (AppImage):** `chmod +x TubeLoad-QA-*.AppImage`, dann starten.

**Voraussetzung (Desktop):** Google Chrome, Chromium oder Microsoft Edge muss installiert sein.
Liegt der Browser an einem ungewöhnlichen Ort, hilft `TB_CHROME_PATH`.

## Lokal entwickeln

```bash
cd desktop/core
npm ci
npm run typecheck
npm test            # Unit- und E2E-Tests (E2E gegen lokales Testvideo, ohne YouTube)
npm run build

cd ..
npm ci
npm run build:core  # baut den Core (einmalig bzw. nach Änderungen im Core)
npm start           # startet die Electron-App; sie nutzt den gebauten Core
```

Core ohne Electron (z. B. auf einem Server):

```bash
cd desktop/core
npm run dev         # im Terminal wird die vollständige Adresse samt ?token=… ausgegeben
```

Das Dashboard liefert der Core nur mit gültigem Token aus (`/?token=…`, siehe *Sicherheit*). In
Electron macht die App das selbst; beim Betrieb ohne Electron die ausgegebene Adresse verwenden
oder mit `TB_TOKEN` ein eigenes Token setzen.

## Bedienung

- **Session starten:** YouTube-Video-, Playlist- oder Kanal-URL eintragen, optional Auflösung,
  Laufzeit in Minuten und Wiederholungen wählen, *Start*.
- **Gespeicherte URLs:** Jede eingegebene (gültige) URL wird sofort dauerhaft gespeichert – beim
  Verlassen des Feldes, beim Start und beim Anlegen eines Zeitplans, auch wenn der Start am Limit
  scheitert. Sie erscheinen als Vorschlag im Eingabefeld und in der Liste *Gespeicherte URLs*
  (*URL entfernen* löscht den gewählten Eintrag). Es werden bis zu 50 URLs gemerkt.
- **Einstellungen:** Im Abschnitt *Einstellungen* des Dashboards lassen sich parallele Sessions,
  Standard-Läufe, Standard-Laufzeit und der Mindestabstand der Zeitplan-Läufe ändern
  (siehe [Grenzwerte](#grenzwerte)).
- **Scheduler:** Cron-Ausdruck (z. B. `0 2 * * *`) plus Session-Einstellungen. Zeitpläne lassen
  sich ein- und ausschalten. Läuft der vorherige Lauf eines Plans noch, wird der nächste
  übersprungen.
- **Interaktionsskript (optional):** Im Ausklappfeld des Session- und Zeitplan-Formulars gibst du
  eine feste Abfolge von Steuerschritten vor, z. B.

  ```text
  30 pause 5        # nach 30 s: 5 s pausieren, dann fortsetzen
  1:00 seek +30     # 30 s vorspulen
  1:30 seek -15     # 15 s zurückspulen
  2:00 next         # nächstes Video (Playlist/Kanal)
  2:30 previous     # vorheriges Video (Playlist/Kanal)
  ```

  Vorlagen (Spulen, Pausen, gemischter Ablauf, Videowechsel) füllen das Feld. Die Zeit zählt ab
  Beginn des Durchlaufs; bei Wiederholungen läuft das Skript in jedem Durchlauf erneut, immer
  identisch. Gemessen wird pro Schritt, wie lange die Wiedergabe danach bis zum erneuten Laufen
  braucht (Erholzeit; Pause: Zeit nach dem Fortsetzen). Schritte, die nicht möglich sind, werden
  als *übersprungen* gemeldet (z. B. `next` bei einem Einzelvideo oder ein Schritt hinter dem
  Videoende), Schritte ohne Erholung innerhalb von 20 s als *fehlgeschlagen*. Pausen und Sprünge
  zählen nicht als Stall. Die Ergebnisse stehen in der Spalte *Interaktionen* der Zusammenfassung
  (Tooltip: jeder Schritt) und im Export *Interaktionen CSV*. Es gibt **bewusst keinen Zufallsmodus**:
  Zufällige Aktionen machen Messungen unvergleichbar und dienen nur dazu, automatisiertes Abspielen
  wie menschliches Zuschauen aussehen zu lassen, was nicht Zweck der App ist.
  Die Interaktionen gibt es nur in der Desktop-App.
- **Export:** *Samples CSV* (Messwert pro Sekunde und Session), *Summaries CSV* (eine Zeile pro Session,
  mit Anzahl und Ø/max. Erholzeit der Interaktionen) und *Interaktionen CSV* (eine Zeile pro Schritt).

### Was gemessen wird

Startzeit bis zum ersten Bild, Stalls (Anzahl, Dauer, Rebuffer-Anteil – Seeks und Anfangspuffern
zählen nicht), Bandbreite (Ø, Peak, P95), Puffer, **tatsächliche Auflösung** (`videoWidth`×`videoHeight`),
verworfene Frames sowie CPU/RAM aller Browser-Prozesse (100 % = ein Kern).

Die Auflösung wird über die Fenstergröße und das Einstellungsmenü des Players angefordert. YouTube
kann davon abweichen (Auto-Qualität, Gerät, Netz); gewertet wird deshalb immer die **gemessene**
Auflösung. Playlists und Kanäle werden Video für Video abgespielt; ein
„Durchlauf“ ist beendet, wenn das letzte Video zu Ende ist.

Die **Android-App** kann nur das messen, was die IFrame-API liefert (Zustand, Position, Puffer);
Auflösung, Bandbreite und Stall-Dauer stehen dort nicht zur Verfügung.

**Qualität auf Android:** Der eingebettete Player zeigt seine Steuerelemente; über das Zahnrad lässt
sich die Qualität wie in der YouTube-App wählen (Auto, 144p bis 1080p, 4K – je nach Video und
Gerät). Per Programm lässt sie sich über die IFrame-API nicht setzen: `setPlaybackQuality` ist laut
Google-Dokumentation seit dem 24.10.2019 wirkungslos. Die App bietet deshalb keine eigene
Auswahlliste an, sondern nutzt die des Players. Eingaben (URL, Minuten, Läufe, *Wiederholen*) und
die zuletzt verwendeten URLs (Liste per Antippen des URL-Feldes) bleiben nach dem Schließen erhalten.

## Sicherheit

- Der Core lauscht nur auf `127.0.0.1`.
- Jede Anfrage braucht ein zufälliges **Token** (`x-tb-token`-Header bzw. `?token=` beim WebSocket).
  Auch das Dashboard selbst (`GET /`) wird nur mit gültigem Token ausgeliefert (`?token=` oder
  Header) und bekommt es dann eingesetzt; ohne Token antwortet der Core mit 401. Zusätzlich werden `Host` und `Origin` geprüft
  (Schutz vor DNS-Rebinding und fremden Webseiten). Es gibt bewusst keine CORS-Freigabe.
- Erlaubt sind nur `https`-URLs von `youtube.com`, `www./m./music.youtube.com` und `youtu.be`.
- Eingaben werden streng validiert, Request-Größe ist begrenzt, das Dashboard läuft unter
  einer Content-Security-Policy mit Nonce.
- Electron: `sandbox`, `contextIsolation`, keine Navigation weg vom Dashboard, keine Berechtigungsfreigaben.
- Android: kein Klartext-Verkehr, kein Backup, Navigation des Hauptframes gesperrt, Statusmeldungen
  über einen an den Ursprung gebundenen Kanal (`addWebMessageListener`).

Sicherheitsprobleme bitte per GitHub-Issue (ohne Exploit-Details) oder direkt an den Maintainer melden.

## Grenzwerte

Die Werte der ersten vier Zeilen lassen sich im Dashboard unter *Einstellungen* ändern. Sie gelten
für neue Sessions und Zeitpläne (laufende Sessions ändern sich nicht), werden in `settings.json`
gespeichert und bleiben nach einem Neustart erhalten. *Zurücksetzen* stellt die Standardwerte
wieder her. Die **festen Obergrenzen** schützen den Rechner und lassen sich nicht überschreiten;
nur die Zahl paralleler Sessions hat keine feste Obergrenze (siehe unten).

| Einstellung | Standard | Einstellbar von … bis (feste Obergrenze) |
| --- | --- | --- |
| Parallele Sessions | 3 (Startwert per `TB_MAX_SESSIONS`) | ab 1, **keine feste Obergrenze** |
| Wiederholungen („Läufe“) | 3 (nur wenn *Wiederholen* aktiv) | 1 – 10 |
| Laufzeit pro Session | 30 min | 1 – 240 min |
| Mindestabstand zwischen Zeitplan-Läufen | 5 min | 1 – 60 min |
| Zeitpläne | – | 50 (fest) |
| Interaktionsskript | – | 50 Schritte, mind. 2 s Abstand (Pausen zählen mit), Pause 1–120 s, Sprung ±600 s (fest) |
| Android: Wiederholungen / Laufzeit | 3 / 30 min (Felder in der App) | 1 – 10 / 1 – 240 min |

**Parallele Sessions:** Du legst die Zahl selbst fest und kannst sie je nach Auslastung jederzeit im
Dashboard ändern (gilt für neue Starts, laufende Sessions bleiben unberührt). Jede Session ist ein
eigener Browser-Kontext mit Video-Wiedergabe und braucht Arbeitsspeicher und CPU; bei hohen Werten
den Rechner beobachten. YouTube kann viele gleichzeitige Sitzungen von einer Adresse als
Bot-Verkehr einstufen – dann meldet die Session `blocked` (es gibt keine Umgehung).

Zeitpläne dürfen nie häufiger als im Minutentakt laufen (Sekunden-Crons werden abgelehnt). Wird der
Mindestabstand später erhöht, bleiben bestehende Zeitpläne erhalten; er gilt für neue.

## Konfiguration (Umgebungsvariablen des Cores)

| Variable | Bedeutung |
| --- | --- |
| `PORT` | Port des Dashboards (Standard `7777`; Electron wählt automatisch einen freien). |
| `TB_TOKEN` | Eigenes API-Token (mind. 16 Zeichen). Ohne Angabe wird pro Start ein zufälliges erzeugt. |
| `TB_CHROME_PATH` | Pfad zu Chrome/Chromium/Edge. |
| `TB_HEADLESS` | `0` zeigt das Browserfenster (Fehlersuche). |
| `TB_DATA_DIR` | Datenordner (`samples.csv`, `summaries.json`, `schedules.json`, `settings.json`, `recent-urls.json`). |
| `TB_MAX_SESSIONS` | Startwert für parallele Sessions (ganze Zahl ab 1, keine Obergrenze); der Wert in den Einstellungen hat Vorrang, sobald er gespeichert wurde. |
| `TB_LOG_LEVEL` | `debug`, `info`, `warn`, `error`. |

`samples.csv` wird ab einer Größe von 50 MB rotiert; Zusammenfassungen, Zeitpläne, Einstellungen und
gespeicherte URLs bleiben über Neustarts erhalten. (Die URLs liegen bewusst im Datenordner und nicht im
Browser-Speicher des Dashboards: der gilt pro Adresse samt Port, und Electron startet auf einem
anderen Port.)

## Bekannte Grenzen

- Die App hängt an YouTube-Interna (Player-Elemente, Cookie-Banner, Bot-Prüfung) und kann
  nach YouTube-Änderungen Anpassungen brauchen. Bei einer Bot-/Anmeldeprüfung bricht die Session ab
  und meldet `blocked`; es gibt keine Umgehung.
- Die Builds sind unsigniert (siehe oben); ein Auto-Update gibt es nicht.
- Das geordnete Beenden des Cores beim Schließen der App läuft über einen IPC-Kanal. Unter Windows,
  macOS und Linux ist er vorgesehen, getestet wurde das Verhalten aber nur unter Linux; bei Hängern
  beendet die App den Core nach 25 s hart.
- Die Interaktionsschritte *next* und *previous* hängen vom YouTube-Player ab; bei Einzelvideos ohne
  Playlist werden sie übersprungen und als „skipped“ im Protokoll vermerkt.
- Der Android-Build ist ein Debug-APK und nicht für den Play Store vorbereitet.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
