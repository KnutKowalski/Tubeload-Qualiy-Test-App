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
npm start           # Electron-App (baut vorher: npm run build:core)
```

Core ohne Electron (z. B. auf einem Server):

```bash
cd desktop/core
npm run dev         # gibt http://127.0.0.1:7777 aus; Token siehe unten
```

## Bedienung

- **Session starten:** YouTube-Video-, Playlist- oder Kanal-URL eintragen, optional Auflösung,
  Laufzeit in Minuten und Wiederholungen wählen, *Start*.
- **Scheduler:** Cron-Ausdruck (z. B. `0 2 * * *`) plus Session-Einstellungen. Zeitpläne lassen
  sich ein- und ausschalten. Läuft der vorherige Lauf eines Plans noch, wird der nächste
  übersprungen.
- **Export:** *Samples CSV* (Messwert pro Sekunde und Session) und *Summaries CSV* (eine Zeile pro Session).

### Was gemessen wird

Startzeit bis zum ersten Bild, Stalls (Anzahl, Dauer, Rebuffer-Anteil – Seeks und Anfangspuffern
zählen nicht), Bandbreite (Ø, Peak, P95), Puffer, **tatsächliche Auflösung** (`videoWidth`×`videoHeight`),
verworfene Frames sowie CPU/RAM aller Browser-Prozesse (100 % = ein Kern).

Die Auflösung wird über die Fenstergröße und das Einstellungsmenü angefordert. YouTube kann davon
abweichen (die Qualitäts-API des Players ist seit 2019 abgekündigt); gewertet wird deshalb immer
die **gemessene** Auflösung. Playlists und Kanäle werden Video für Video abgespielt; ein
„Durchlauf“ ist beendet, wenn das letzte Video zu Ende ist.

Die **Android-App** kann nur das messen, was die IFrame-API liefert (Zustand, Position, Puffer);
Auflösung, Bandbreite und Stall-Dauer stehen dort nicht zur Verfügung.

## Sicherheit

- Der Core lauscht nur auf `127.0.0.1`.
- Jede Anfrage braucht ein zufälliges **Token** (`x-tb-token`-Header bzw. `?token=` beim WebSocket).
  Das Dashboard bekommt es beim Laden eingesetzt. Zusätzlich werden `Host` und `Origin` geprüft
  (Schutz vor DNS-Rebinding und fremden Webseiten). Es gibt bewusst keine CORS-Freigabe.
- Erlaubt sind nur `https`-URLs von `youtube.com`, `www./m./music.youtube.com` und `youtu.be`.
- Eingaben werden streng validiert, Request-Größe ist begrenzt, das Dashboard läuft unter
  einer Content-Security-Policy mit Nonce.
- Electron: `sandbox`, `contextIsolation`, keine Navigation weg vom Dashboard, keine Berechtigungsfreigaben.
- Android: kein Klartext-Verkehr, kein Backup, Navigation des Hauptframes gesperrt, Statusmeldungen
  über einen an den Ursprung gebundenen Kanal (`addWebMessageListener`).

Sicherheitsprobleme bitte per GitHub-Issue (ohne Exploit-Details) oder direkt an den Maintainer melden.

## Grenzwerte

| Einstellung | Standard | Maximum |
| --- | --- | --- |
| Parallele Sessions | 3 (`TB_MAX_SESSIONS`) | 10 |
| Wiederholungen („Läufe“) | 3 (nur wenn *Wiederholen* aktiv) | 10 |
| Laufzeit pro Session | 30 min | 4 h |
| Abstand zwischen Zeitplan-Läufen | – | mind. 5 min |
| Zeitpläne | – | 50 |
| Android: Wiederholungen / Laufzeit | – | 3 / 4 h |

## Konfiguration (Umgebungsvariablen des Cores)

| Variable | Bedeutung |
| --- | --- |
| `PORT` | Port des Dashboards (Standard `7777`; Electron wählt automatisch einen freien). |
| `TB_TOKEN` | Eigenes API-Token (mind. 16 Zeichen). Ohne Angabe wird pro Start ein zufälliges erzeugt. |
| `TB_CHROME_PATH` | Pfad zu Chrome/Chromium/Edge. |
| `TB_HEADLESS` | `0` zeigt das Browserfenster (Fehlersuche). |
| `TB_DATA_DIR` | Datenordner (`samples.csv`, `summaries.json`, `schedules.json`). |
| `TB_MAX_SESSIONS` | Parallele Sessions (1–10). |
| `TB_LOG_LEVEL` | `debug`, `info`, `warn`, `error`. |

`samples.csv` wird ab einer Größe von 50 MB rotiert; die Zusammenfassungen und Zeitpläne bleiben
über Neustarts erhalten.

## Bekannte Grenzen

- Die App hängt an YouTube-Interna (Player-Elemente, Cookie-Banner, Bot-Prüfung) und kann
  nach YouTube-Änderungen Anpassungen brauchen. Bei einer Bot-/Anmeldeprüfung bricht die Session ab
  und meldet `blocked`; es gibt keine Umgehung.
- Die Builds sind unsigniert (siehe oben); ein Auto-Update gibt es nicht.
- Der Android-Build ist ein Debug-APK und nicht für den Play Store vorbereitet.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
