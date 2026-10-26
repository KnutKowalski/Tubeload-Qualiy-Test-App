import { test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";

import type { ProcessMonitor } from "../src/processMonitor";
import { SessionRunner } from "../src/session";
import type { SessionConfig } from "../src/types";

const cfg = (url: string, over: Partial<SessionConfig> = {}): SessionConfig => ({
  id: "u1",
  url,
  kind: "playlist",
  quality: "auto",
  repeat: false,
  maxLoops: 1,
  maxRuntimeSec: 60,
  startTimeoutSec: 15,
  mute: true,
  consentMode: "none",
  interactions: [],
  ...over,
});

const runner = (c: SessionConfig) => new SessionRunner(c, {} as Browser, {} as ProcessMonitor, () => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("Seitenwechsel laufen strikt nacheinander (Wiedergabeschleife und Skript navigieren nie gleichzeitig)", async () => {
  const r = runner(cfg("https://www.youtube.com/watch?v=abc&list=PL1"));
  const order: string[] = [];

  const nav = (name: string, ms: number): Promise<string> =>
    (r as unknown as { exclusiveNav(fn: () => Promise<string>): Promise<string> }).exclusiveNav(async () => {
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);

      return name;
    });

  const results = await Promise.all([nav("a", 80), nav("b", 5), nav("c", 5)]);

  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("Eine fehlgeschlagene Navigation blockiert die folgenden nicht", async () => {
  const r = runner(cfg("https://www.youtube.com/watch?v=abc&list=PL1"));
  const exclusive = (r as unknown as { exclusiveNav<T>(fn: () => Promise<T>): Promise<T> }).exclusiveNav.bind(r);

  await assert.rejects(exclusive(async () => Promise.reject(new Error("net::ERR_ABORTED"))), /ERR_ABORTED/);
  assert.equal(await exclusive(async () => "danach"), "danach");
});

test("Playlist-Übersicht startet mit der Wiedergabeseite, Watch-URLs bleiben unverändert", () => {
  const url = (r: SessionRunner) => (r as unknown as { currentUrl: string }).currentUrl;

  assert.equal(
    url(runner(cfg("https://www.youtube.com/playlist?list=PLabc"))),
    "https://www.youtube.com/watch?list=PLabc&index=1"
  );
  assert.equal(
    url(runner(cfg("https://www.youtube.com/watch?v=xyz&list=PLabc"))),
    "https://www.youtube.com/watch?v=xyz&list=PLabc"
  );
  assert.equal(
    url(runner(cfg("https://www.youtube.com/watch?v=xyz", { kind: "video" }))),
    "https://www.youtube.com/watch?v=xyz"
  );
});
