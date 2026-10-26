import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright-core";
import type { Browser, LaunchOptions } from "playwright-core";

import { SummaryStore } from "./aggregator";
import { CsvWriter } from "./csv";
import { log } from "./log";
import { SessionManager } from "./manager";
import { ProcessMonitor } from "./processMonitor";
import { RecentUrls } from "./recentUrls";
import { Scheduler } from "./scheduler";
import { startServer, type RunningServer } from "./server";
import { SettingsStore } from "./settings";
import { errorMessage, sleep } from "./util";

const HEADLESS = process.env.TB_HEADLESS !== "0";

const BROWSER_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
];

async function launchBrowserOnce(): Promise<Browser> {
  const candidates: LaunchOptions[] = [];

  if (process.env.TB_CHROME_PATH) {
    candidates.push({ executablePath: process.env.TB_CHROME_PATH });
  }

  candidates.push({ channel: "chrome" });
  // Unter Windows ist Edge vorinstalliert; macOS/Linux-Installationen werden ebenfalls erkannt.
  candidates.push({ channel: "msedge" });

  const knownPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];

  for (const p of knownPaths) {
    if (fs.existsSync(p)) candidates.push({ executablePath: p });
  }

  // Zuletzt der von Playwright selbst installierte Chromium (falls vorhanden).
  candidates.push({});

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await chromium.launch({
        headless: HEADLESS,
        args: BROWSER_ARGS,
        ...candidate,
      });
    } catch (e) {
      const label =
        candidate.executablePath ?? candidate.channel ?? "Chromium-Standard";
      log.warn(`Browser-Kandidat fehlgeschlagen: ${label} (${errorMessage(e).split("\n")[0]})`);
      lastError = e;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Kein kompatibler Browser gefunden.");
}

async function main() {
  const dataDir = process.env.TB_DATA_DIR || path.resolve("data");
  const dashboardPath =
    process.env.TB_DASHBOARD || path.resolve("public/dashboard.html");
  const port = Number(process.env.PORT || 7777);

  fs.mkdirSync(dataDir, { recursive: true });

  const shutdownAbort = new AbortController();
  let browser: Browser | null = null;
  let shuttingDown = false;

  const monitor = new ProcessMonitor(() => browser);
  // Einstellungen und URL-Verlauf liegen im Datenordner und überleben Neustarts.
  const settings = new SettingsStore(path.join(dataDir, "settings.json"));
  const recent = new RecentUrls(path.join(dataDir, "recent-urls.json"));

  const manager = new SessionManager(monitor, () => settings.get().maxSessions);
  const csv = new CsvWriter(path.join(dataDir, "samples.csv"));
  const summaries = new SummaryStore(path.join(dataDir, "summaries.json"));
  const scheduler = new Scheduler(
    manager,
    path.join(dataDir, "schedules.json"),
    () => settings.get().minScheduleIntervalMin * 60
  );

  // HTTP-Server ZUERST: /api/health antwortet sofort, unabhängig davon,
  // ob/wann der Browser startet.
  let running: RunningServer;
  let boundPort = port;

  try {
    running = startServer({
      manager,
      csv,
      summaries,
      scheduler,
      dataDir,
      dashboardPath,
      port,
      settings,
      recent,
    });
    boundPort = await running.listening;
  } catch (e) {
    log.error(`HTTP-Server konnte nicht starten (Port ${port})`, e);
    process.exit(1);
  }

  // Der Scheduler startet Läufe erst, wenn der Browser bereit ist (manager.isReady()).
  scheduler.start();

  log.info(`TubeLoad QA Core ready on http://127.0.0.1:${boundPort}`);

  // Das Dashboard wird nur mit Token ausgeliefert. Für die Entwicklung im Terminal wird die
  // vollständige Adresse ausgegeben – bewusst nicht in Logdateien (nur bei interaktivem Terminal).
  if (process.stdout.isTTY) {
    console.log(`Dashboard öffnen: http://127.0.0.1:${boundPort}/?token=${running.token}`);
  }

  // Browser im Hintergrund starten und bei Verlust neu starten.
  void (async () => {
    let backoff = 3000;

    while (!shuttingDown) {
      try {
        const b = await launchBrowserOnce();
        browser = b;
        manager.setBrowser(b);
        backoff = 3000;
        log.info("Browser bereit – Sessions können starten.");

        await new Promise<void>((resolve) => b.once("disconnected", () => resolve()));

        browser = null;
        manager.setBrowser(null);

        if (!shuttingDown) log.warn("Browser wurde beendet – starte neu.");
      } catch (e) {
        log.error(
          "Browser konnte nicht gestartet werden (ist Google Chrome oder Chromium installiert? TB_CHROME_PATH setzen).",
          e
        );
      }

      if (shuttingDown) break;

      await sleep(backoff, shutdownAbort.signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  })();

  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownAbort.abort();

    // Harte Frist, falls etwas hängt.
    setTimeout(() => process.exit(code), 20_000).unref();

    try {
      scheduler.stop();
      await manager.stopAll();
      await csv.close();
      monitor.dispose();
      await running.close();
      await browser?.close();
    } catch (e) {
      log.error("Fehler beim Beenden", e);
    }

    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  // Von der Electron-App gestartet (IPC-Kanal): geordnet beenden, auch unter Windows, wo
  // kill("SIGTERM") den Prozess hart beendet und die Zusammenfassungen laufender Sessions
  // verloren gehen. Ist der Elternprozess weg, beendet sich der Core ebenfalls.
  process.on("message", (m) => {
    if (m === "shutdown") void shutdown(0);
  });
  process.on("disconnect", () => void shutdown(0));

  // Ein einzelner unbehandelter Promise-Fehler darf nicht alle Sessions beenden.
  process.on("unhandledRejection", (reason) => {
    log.error("Unbehandelte Promise-Rejection (wird ignoriert)", reason);
  });

  // Nach einer unerwarteten Exception ist der Zustand unsicher: geordnet beenden.
  // Die Electron-App startet den Core anschließend neu.
  process.on("uncaughtException", (err) => {
    log.error("Unerwarteter Fehler – Core wird beendet", err);
    void shutdown(1);
  });
}

main().catch((e) => {
  log.error("Core konnte nicht starten", e);
  process.exit(1);
});
