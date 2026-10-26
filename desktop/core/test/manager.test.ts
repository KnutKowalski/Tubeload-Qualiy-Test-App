import { test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";

import { ManagerError, SessionManager } from "../src/manager";
import type { ProcessMonitor } from "../src/processMonitor";
import type { SessionConfig } from "../src/types";

const cfg = { id: "s1" } as SessionConfig;
const monitor = {} as ProcessMonitor;

test("maxSessions: feste Zahl oder Funktion – Änderungen wirken sofort", () => {
  assert.equal(new SessionManager(monitor, 4).maxSessions, 4);

  let n = 2;
  const m = new SessionManager(monitor, () => n);

  assert.equal(m.maxSessions, 2);
  n = 7;
  assert.equal(m.maxSessions, 7);
});

test("Limit erreicht: Fehler nennt den aktuellen Wert und verweist auf die Einstellungen", () => {
  // 0 erlaubte Sessions: der Start scheitert garantiert am Limit, ohne dass ein Browser läuft.
  const m = new SessionManager(monitor, () => 0);

  m.setBrowser({} as Browser);

  assert.throws(
    () => m.start(cfg),
    (e: unknown) =>
      e instanceof ManagerError && e.code === "limit" && /Maximal 0 gleichzeitige Sessions/.test(e.message) && /Einstellungen/.test(e.message)
  );
  assert.equal(m.activeCount(), 0);
});

test("ohne Browser: no_browser, vor dem Limit-Check", () => {
  const m = new SessionManager(monitor, () => 0);

  assert.throws(() => m.start(cfg), (e: unknown) => e instanceof ManagerError && e.code === "no_browser");
});
