import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright-core";

import { ProcessMonitor } from "../src/processMonitor";
import { SessionRunner } from "../src/session";
import { parseInteractionScript } from "../src/interactions";
import type { InteractionResult, Sample, SessionConfig } from "../src/types";
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
  const hung: http.ServerResponse[] = [];

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

    if (req.url === "/hang.html") {
      // antwortet nie: simuliert einen hängenden Server beim Seitenladen
      hung.push(res);
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
    interactions: [],
    ...over,
  };
}

function e2e(name: string, fn: () => Promise<void>): void {
  test(name, { timeout: 90_000 }, async (t) => {
    if (!browser) {
      // In der CI (TB_REQUIRE_BROWSER=1) ist ein fehlender Browser ein Fehler und kein stilles Überspringen.
      if (process.env.TB_REQUIRE_BROWSER) assert.fail("Kein Chromium/Chrome verfügbar, aber TB_REQUIRE_BROWSER ist gesetzt");

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

e2e("Interaktionsskript: Pause und Sprung zurück laufen, Erholzeit wird gemessen, Einzelvideo-'next' wird übersprungen", async () => {
  const media = await startMediaServer();

  try {
    const results: InteractionResult[] = [];
    const samples: Sample[] = [];
    const steps = parseInteractionScript("2 pause 2\n6 seek -3\n9 next", 1800);

    const runner = new SessionRunner(
      config(media.url("/page.html"), { interactions: steps }),
      browser!,
      monitor,
      (s) => samples.push(s),
      (r) => results.push(r)
    );

    await runner.run();

    assert.equal(runner.endReason, "completed");
    assert.equal(results.length, 3, JSON.stringify(results));

    const [pause, seek, next] = results;

    assert.equal(pause.action, "pause");
    assert.equal(pause.status, "ok", JSON.stringify(pause));
    assert.ok(pause.recoveryMs >= 0 && pause.recoveryMs < 5000, `Pause-Erholung ${pause.recoveryMs} ms`);
    assert.ok(Math.abs(pause.startedAtSec - 2) <= 2, `Pause gestartet bei ${pause.startedAtSec} s`);

    assert.equal(seek.action, "seek");
    assert.equal(seek.value, -3);
    assert.equal(seek.status, "ok", JSON.stringify(seek));
    assert.ok(seek.recoveryMs >= 0 && seek.recoveryMs < 5000, `Sprung-Erholung ${seek.recoveryMs} ms`);

    assert.equal(next.status, "skipped");
    assert.match(next.note ?? "", /Einzelvideo/);
    assert.equal(next.recoveryMs, -1);

    // Die Pause war wirklich sichtbar: das Video stand, Samples zeigen "paused".
    assert.ok(samples.some((s) => s.state === "paused"), "pausiert-Sample erwartet");
    // Zurückspulen verlängert die Wiedergabe: mehr als die reine Videolänge (8 s) plus Pause (2 s).
    assert.ok(samples.filter((s) => s.state === "playing").length >= 8);
    // Ein Sprung/Pause ist kein Stall.
    assert.ok(samples.every((s) => s.stalls === 0), "Pause und Sprung dürfen nicht als Stall zählen");
  } finally {
    await media.close();
  }
});

e2e("Interaktionsskript: Schritt hinter dem Videoende wird als übersprungen gemeldet, Session endet normal", async () => {
  const media = await startMediaServer();

  try {
    const results: InteractionResult[] = [];
    const runner = new SessionRunner(
      config(media.url("/page.html"), { interactions: parseInteractionScript("60 pause 5", 1800) }),
      browser!,
      monitor,
      () => {},
      (r) => results.push(r)
    );

    const t0 = Date.now();
    await runner.run();

    assert.equal(runner.endReason, "completed");
    assert.ok(Date.now() - t0 < 40_000, "darf nicht auf den Schritt bei 60 s warten");
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "skipped");
    assert.match(results[0].note ?? "", /Video war vorher zu Ende/);
  } finally {
    await media.close();
  }
});

e2e("Interaktionsskript: läuft in jedem Wiederholungsdurchlauf erneut, identisch", async () => {
  const media = await startMediaServer();

  try {
    const results: InteractionResult[] = [];
    const runner = new SessionRunner(
      config(media.url("/page.html"), {
        repeat: true,
        maxLoops: 2,
        interactions: parseInteractionScript("2 seek 1", 1800),
      }),
      browser!,
      monitor,
      () => {},
      (r) => results.push(r)
    );

    await runner.run();

    assert.equal(runner.endReason, "completed");
    assert.deepEqual(
      results.map((r) => [r.loop, r.action, r.value, r.status]),
      [
        [1, "seek", 1, "ok"],
        [2, "seek", 1, "ok"],
      ]
    );
  } finally {
    await media.close();
  }
});

e2e("Interaktionsskript: stop() beendet auch eine laufende Pause sofort", async () => {
  const media = await startMediaServer();

  try {
    const results: InteractionResult[] = [];
    const samples: Sample[] = [];
    const runner = new SessionRunner(
      config(media.url("/page.html"), { interactions: parseInteractionScript("2 pause 100", 1800) }),
      browser!,
      monitor,
      (s) => samples.push(s),
      (r) => results.push(r)
    );

    const done = runner.run();

    await until(() => samples.some((s) => s.state === "paused"), 20_000, "Pause beginnt");

    const t0 = Date.now();
    runner.stop();
    await done;

    assert.ok(Date.now() - t0 < 8_000, "Stopp muss auch während der Pause zügig wirken");
    assert.equal(runner.endReason, "stopped");
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "skipped");
  } finally {
    await media.close();
  }
});

e2e("Stopp wirkt sofort, auch wenn die Seite gerade lädt (hängender Server)", async () => {
  const media = await startMediaServer();

  try {
    const runner = new SessionRunner(
      config(media.url("/hang.html"), { maxRuntimeSec: 3600 }),
      browser!,
      monitor,
      () => {}
    );

    const done = runner.run();

    await new Promise((r) => setTimeout(r, 2000));

    const t0 = Date.now();
    runner.stop();
    await done;

    assert.equal(runner.endReason, "stopped");
    // Früher wartete run() hier bis zum Ablauf des 60-s-Ladetimeouts.
    assert.ok(Date.now() - t0 < 8_000, `Stopp dauerte ${Date.now() - t0} ms`);
  } finally {
    await media.close();
  }
});

e2e("Der echte Laufzeit-Timer beendet die Session mit max_runtime (ohne stop() von außen)", async () => {
  const media = await startMediaServer();

  try {
    const runner = new SessionRunner(
      config(media.url("/page.html"), { repeat: true, maxLoops: 10, maxRuntimeSec: 3 }),
      browser!,
      monitor,
      () => {}
    );

    const t0 = Date.now();
    await runner.run();

    assert.equal(runner.endReason, "max_runtime");
    assert.ok(Date.now() - t0 < 12_000, `endete erst nach ${Date.now() - t0} ms`);
  } finally {
    await media.close();
  }
});

e2e("Nach dem Ende einer Session werden keine Messwerte mehr gemeldet (langsamer Prozess-Monitor)", async () => {
  const media = await startMediaServer();

  // Ein Monitor, der länger als eine Sekunde braucht (z. B. Windows): die Messung läuft beim Stopp noch.
  const slowMonitor = {
    snapshot: async () => {
      await new Promise((r) => setTimeout(r, 700));

      return { cpu: 0, memBytes: 0 };
    },
  } as unknown as ProcessMonitor;

  try {
    const samples: Sample[] = [];
    const runner = new SessionRunner(
      config(media.url("/page.html"), { repeat: true, maxLoops: 10 }),
      browser!,
      slowMonitor,
      (s) => samples.push(s)
    );

    const done = runner.run();

    await until(() => samples.some((s) => s.state === "playing"), 20_000, "Wiedergabe startet");

    runner.stop();
    await done;

    const n = samples.length;

    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(samples.length, n, "nach run() darf kein Sample mehr eintreffen");
  } finally {
    await media.close();
  }
});
