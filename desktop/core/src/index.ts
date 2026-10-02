import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright-core";

import { SessionManager } from "./manager";
import { SummaryStore } from "./aggregator";
import { CsvWriter } from "./csv";
import { Scheduler } from "./scheduler";
import { startServer } from "./server";

const HEADLESS = process.env.TB_HEADLESS !== "0";

async function launchBrowser() {
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

  const browser = await launchBrowser();

  const manager = new SessionManager(browser);
  const csv = new CsvWriter(path.join(dataDir, "samples.csv"));
  const summaries = new SummaryStore();
  const scheduler = new Scheduler(
    manager,
    path.join(dataDir, "schedules.json")
  );

  scheduler.start();

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
      await browser.close();
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
