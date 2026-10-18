import { test } from "node:test";
import assert from "node:assert/strict";

import { SummaryStore } from "../src/aggregator";
import type { Sample } from "../src/types";

let t = 1_000_000;

function s(over: Partial<Sample>): Sample {
  t += 1000;

  return {
    ts: t,
    sessionId: "a",
    kind: "video",
    queueIndex: 0,
    url: "u",
    state: "playing",
    currentTime: 0,
    duration: 0,
    bufferedSec: 0,
    quality: "720p",
    width: 1280,
    height: 720,
    bandwidthMBps: 1,
    cpuPercent: 0,
    ramMb: 0,
    rendererCpuPercent: 0,
    jsHeapMb: 0,
    stalls: 0,
    stallSec: 0,
    startupMs: -1,
    droppedFrames: 0,
    totalFrames: 0,
    ...over,
  };
}

test("Zähler, die bei einer neuen Seite auf 0 springen, werden korrekt aufsummiert", () => {
  const store = new SummaryStore();

  store.add(s({ stalls: 1, stallSec: 2, droppedFrames: 5, totalFrames: 100 }));
  store.add(s({ stalls: 2, stallSec: 3, droppedFrames: 10, totalFrames: 200 }));
  // neue Seite (Video 2): Zähler starten wieder bei 0
  store.add(s({ stalls: 0, stallSec: 0, droppedFrames: 0, totalFrames: 0 }));
  store.add(s({ stalls: 1, stallSec: 1, droppedFrames: 2, totalFrames: 100 }));

  const sum = store.finish("a", "completed")!;

  assert.equal(sum.stalls, 3);
  assert.equal(sum.stallSeconds, 4);
  assert.ok(Math.abs(sum.droppedFrameRatio - 12 / 300) < 1e-9);
  assert.equal(sum.endReason, "completed");
});

test("Rebuffer-Quote, Startzeit, dominante Qualität", () => {
  const store = new SummaryStore();

  store.add(s({ startupMs: 1500, quality: "480p" }));
  for (let i = 0; i < 8; i++) store.add(s({ quality: "720p", stallSec: 0 }));
  store.add(s({ state: "buffering", quality: "720p", stalls: 1, stallSec: 2 }));

  const sum = store.finish("a")!;

  assert.equal(sum.startupMs, 1500);
  assert.equal(sum.dominantQuality, "720p");
  assert.ok(sum.rebufferRatio > 0.15 && sum.rebufferRatio < 0.35, String(sum.rebufferRatio));
});

test("Diagnose-Samples fließen nicht in die Messwerte ein, die Notiz bleibt erhalten", () => {
  const store = new SummaryStore();

  store.add(s({ state: "blocked", note: "YouTube blockiert", bandwidthMBps: 0 }));

  const sum = store.finish("a", "blocked")!;

  assert.equal(sum.note, "YouTube blockiert");
  assert.equal(sum.avgBandwidthMBps, 0);
  assert.equal(sum.endReason, "blocked");
});

test("Speicher ist begrenzt (Reservoir) und p95 plausibel", () => {
  const store = new SummaryStore();

  for (let i = 0; i < 25_000; i++) store.add(s({ bandwidthMBps: i % 100 }));

  const sum = store.finish("a")!;

  assert.ok(sum.p95BandwidthMBps >= 90 && sum.p95BandwidthMBps <= 99, String(sum.p95BandwidthMBps));
  assert.equal(sum.peakBandwidthMBps, 99);
});
