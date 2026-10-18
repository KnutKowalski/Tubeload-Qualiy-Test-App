import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright-core";

import { ProcessMonitor } from "../src/processMonitor";
import { SessionRunner } from "../src/session";
import type { Sample, SessionConfig } from "../src/types";
import { launchTestBrowser } from "./helpers";

/**
 * End-to-End-Tests der Session-Logik gegen einen echten Chromium und ein lokales
 * 8-Sekunden-Video (kein Zugriff auf YouTube nötig). Gibt es keinen Browser,
 * werden die Tests übersprungen.
 */

const VIDEO = fs.readFileSync(path.join(__dirname, "fixtures", "test.webm"));

const PAGE_WITH_VIDEO =
  '<!doctype html><meta charset="utf-8"><body style="margin:0">' +
  '<video src="/test.webm" autoplay muted playsinline width="320" height="240"></video>';

const PAGE_WITHOUT_VIDEO = '<!doctype html><meta charset="utf-8"><p>kein Video hier</p>';

interface MediaServer {
  url: (p: string) => string;
  pageHits: () => number;
  close: () => Promise<void>;
}

/** failFrom: ab dem n-ten Seitenaufruf wird die Verbindung hart getrennt. */
function startMediaServer(failFrom = Infinity): Promise<MediaServer> {
  let hits = 0;

  const server = http.createServer((req, res) => {
    if (req.url === "/page.html") {
      hits++;

      if (hits >= failFrom) {
        req.socket.destroy();
        return;
      }

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(PAGE_WITH_VIDEO);
      return;
    }

    if (req.url === "/empty.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(PAGE_WITHOUT_VIDEO);
      return;
    }

    if (req.url === "/test.webm") {
      res.setHeader("Content-Type", "video/webm");
      res.setHeader("Accept-Ranges", "bytes");

      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));

      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), VIDEO.length - 1) : VIDEO.length - 1;

        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${VIDEO.length}`);
        res.setHeader("Content-Length", end - start + 1);
        res.end(VIDEO.subarray(start, end + 1));
        return;
      }

      res.setHeader("Content-Length", VIDEO.length);
      res.end(VIDEO);
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;

      resolve({
        url: (p) => `http://127.0.0.1:${port}${p}`,
        pageHits: () => hits,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}

let browser: Browser | null = null;
let monitor: ProcessMonitor;
let counter = 0;

before(async () => {
  browser = await launchTestBrowser();
  monitor = new ProcessMonitor(() => browser);
});

after(async () => {
  monitor?.dispose();
  await browser?.close();
});

function config(url: string, over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: `e2e-${++counter}`,
    url,
    kind: "video",
    quality: "auto",
    repeat: false,
    maxLoops: 1,
    maxRuntimeSec: 120,
    startTimeoutSec: 15,
    mute: true,
    consentMode: "none",
    ...over,
  };
}

function e2e(name: string, fn: () => Promise<void>): void {
  test(name, { timeout: 90_000 }, async (t) => {
    if (!browser) {
      t.skip("Kein Chromium/Chrome verfügbar");
      return;
    }

    await fn();
  });
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;

  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`Zeitüberschreitung: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

e2e("Video wird einmal durchgespielt und die Session endet mit 'completed'", async () => {
  const media = await startMediaServer();

  try {
    const samples: Sample[] = [];
    const runner = new SessionRunner(
      config(media.url("/page.html")),
      browser!,
      monitor,
      (s) => samples.push(s)
    );

    const t0 = Date.now();
    await runner.run();
    const elapsed = Date.now() - t0;

    assert.equal(runner.endReason, "completed");
    assert.equal(media.pageHits(), 1, "ohne Wiederholung genau ein Seitenaufruf");
    assert.ok(elapsed < 40_000, `dauerte ${elapsed} ms`);

    const playing = samples.filter((s) => s.state === "playing");
    assert.ok(playing.length >= 3, "mehrere 'playing'-Samples erwartet");

    // Die gemessene Auflösung kommt aus dem Video-Element.
    assert.ok(playing.every((s) => s.height === 120 && s.width === 160));
    assert.ok(playing.every((s) => s.quality === "120p"));

    assert.ok(samples.some((s) => s.startupMs > 0), "Startzeit gemessen");
    assert.ok(samples.some((s) => s.bandwidthMBps > 0), "Datenverkehr gemessen");
    assert.ok(samples.some((s) => s.state === "ended"), "Ende erkannt");
    assert.ok(samples.every((s) => s.stalls === 0), "lokal darf nichts stallen");
  } finally {
    await media.close();
  }
});

e2e("Wiederholung ist begrenzt: maxLoops=2 ergibt genau zwei Durchläufe", async () => {
  const media = await startMediaServer();

  try {
    const runner = new SessionRunner(
      config(media.url("/page.html"), { repeat: true, maxLoops: 2 }),
      browser!,
      monitor,
      () => {}
    );

    const t0 = Date.now();
    await runner.run();
    const elapsed = Date.now() - t0;

    assert.equal(runner.endReason, "completed");
    assert.equal(media.pageHits(), 2, "genau zwei Seitenaufrufe");
    assert.ok(elapsed >= 14_000, `zwei Durchläufe à 8 s, war ${elapsed} ms`);
  } finally {
    await media.close();
  }
});

e2e("stop() beendet auch eine Wiederholungsschleife sofort", async () => {
  const media = await startMediaServer();

  try {
    const samples: Sample[] = [];
    const runner = new SessionRunner(
      config(media.url("/page.html"), { repeat: true, maxLoops: 10 }),
      browser!,
      monitor,
      (s) => samples.push(s)
    );

    const done = runner.run();

    await until(() => samples.some((s) => s.state === "playing"), 20_000, "Wiedergabe startet");

    const t0 = Date.now();
    runner.stop();
    await done;

    assert.equal(runner.endReason, "stopped");
    assert.ok(Date.now() - t0 < 8_000, "Stopp muss zügig wirken");
  } finally {
    await media.close();
  }
});

e2e("max_runtime beendet die Session, auch wenn das Video noch läuft", async () => {
  const media = await startMediaServer();

  try {
    const runner = new SessionRunner(
      config(media.url("/page.html"), { repeat: true, maxLoops: 10, maxRuntimeSec: 30 }),
      browser!,
      monitor,
      () => {}
    );

    // Laufzeit künstlich verkürzen, ohne 30 s zu warten.
    const t = setTimeout(() => runner.stop("max_runtime"), 4_000);

    await runner.run();
    clearTimeout(t);

    assert.equal(runner.endReason, "max_runtime");
  } finally {
    await media.close();
  }
});

e2e("Fehlgeschlagener Start hängt nicht bis maxRuntime (früherer sleep()-Fehler)", async () => {
  const media = await startMediaServer();

  try {
    const samples: Sample[] = [];
    const runner = new SessionRunner(
      config(media.url("/empty.html"), { startTimeoutSec: 5, maxRuntimeSec: 3600 }),
      browser!,
      monitor,
      (s) => samples.push(s)
    );

    const t0 = Date.now();
    await runner.run();
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 30_000, `endete erst nach ${elapsed} ms (maxRuntime wäre 3600 s)`);
    assert.equal(runner.endReason, "error");
    assert.ok(samples.some((s) => s.state === "no_video"), "Diagnose-Sample erwartet");
  } finally {
    await media.close();
  }
});

e2e("Netzwerkfehler beim Neuladen beendet nur die Session, nicht den Prozess", async () => {
  // Der zweite Seitenaufruf (Wiederholung) wird hart getrennt. Früher war das eine
  // unbehandelte Promise-Rejection und beendete den gesamten Core.
  const media = await startMediaServer(2);

  try {
    const runner = new SessionRunner(
      config(media.url("/page.html"), { repeat: true, maxLoops: 3 }),
      browser!,
      monitor,
      () => {}
    );

    await assert.rejects(runner.run());

    assert.equal(runner.endReason, "error");
    // Chromium wiederholt einen GET nach einem Verbindungsabbruch teils selbst.
    assert.ok(media.pageHits() >= 2, "die Wiederholung hat den Server erreicht");
  } finally {
    await media.close();
  }
});
