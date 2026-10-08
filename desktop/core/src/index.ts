import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";

import { SessionManager } from "./manager";
import { SummaryStore } from "./aggregator";
import { CsvWriter } from "./csv";
import { Scheduler } from "./scheduler";
import { startServer } from "./server";

const HEADLESS = process.env.TB_HEADLESS !== "0";

async function launchBrowserOnce(): Promise<Browser> {
  const args = [
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1400,900",
  ];

  const candidates: any[] = [];

  if (process.env.TB_CHROME_PATH) {
    candidates.push({
      executablePath: process.env.TB_CHROME_PATH,
      args,
    });
  }

  candidates.push({
    channel: "chrome",
    args,
  });

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
    if (fs.existsSync(p)) {
      candidates.push({
        executablePath: p,
        args,
      });
    }
  }

  candidates.push({
    args,
  });

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await chromium.launch({
        headless: HEADLESS,
        ...candidate,
      });
    } catch (e) {
      const label =
        candidate.executablePath ?? candidate.channel ?? "Chromium-Standard";
      console.error(`Browser-Kandidat fehlgeschlagen: ${label}`);
      console.error(e);
      lastError = e;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Kein kompatibler Browser gefunden.");
}

async function launchBrowser(): Promise<Browser> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const browser = await launchBrowserOnce();
      console.log(`Browser gestartet (Versuch ${attempt}).`);
      return browser;
    } catch (e) {
      lastError = e;
      console.error(`Browser-Start fehlgeschlagen (Versuch ${attempt}/3).`);
      await new Promise((r) => setTimeout(r, 2000));
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

  let browser: Browser | null = null;

  // Manager startet OHNE Browser: Bis der Browser bereit ist, werden
  // Session-Starts mit einer klaren Fehlermeldung abgelehnt.
  const manager = new SessionManager(null);
  const csv = new CsvWriter(path.join(dataDir, "samples.csv"));
  const summaries = new SummaryStore();
  const scheduler = new Scheduler(
    manager,
    path.join(dataDir, "schedules.json")
  );

  scheduler.start();

  // HTTP-Server ZUERST: /api/health antwortet sofort, unabhängig davon,
  // ob/wann der Browser startet. Die Electron-App kann also nie wieder an
  // einem Browser-Problem "ganz unten" hängen bleiben.
  const server = startServer({
    manager,
    csv,
    summaries,
    scheduler,
    dataDir,
    dashboardPath,
    port,
  });

  console.log(`TubeLoad QA Core ready on http://127.0.0.1:${port}`);

  // Browser im Hintergrund nachziehen (bis zu 3 Versuche).
  launchBrowser()
    .then((b) => {
      browser = b;
      manager.setBrowser(b);
      console.log("Browser bereit – Sessions können starten.");
    })
    .catch((e) => {
      console.error("Browser konnte nicht gestartet werden:");
      console.error(e);
      console.error(
        "Session-Starts schlagen mit Fehlermeldung fehl, bis ein Browser verfügbar ist."
      );
    });

  const close = async () => {
    try {
      scheduler.stop();
    } catch {}

    try {
      csv.close();
    } catch {}

    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {}

    try {
      await browser?.close();
    } catch {}
  };

  process.on("SIGINT", () => {
    close().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    close().finally(() => process.exit(0));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
