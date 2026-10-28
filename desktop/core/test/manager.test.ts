import { test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";

import { ManagerError, SessionManager } from "../src/manager";
import type { ProcessMonitor } from "../src/processMonitor";
import type { SessionConfig } from "../src/types";
import { parseSessionInput } from "../src/validate";

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

// Browser, dessen Kontext nie fertig wird: gestartete Sessions bleiben "aktiv", ohne dass etwas läuft.
const hangingBrowser = { newContext: () => new Promise(() => {}) } as unknown as Browser;
const youtube = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const configFor = (i: number) => ({ ...parseSessionInput({ url: youtube }), id: `s${i}` }) as unknown as SessionConfig;

test("Limit erreicht: Fehler nennt den aktuellen Wert und verweist auf die Einstellungen", () => {
  const m = new SessionManager(monitor, () => 1);

  m.setBrowser(hangingBrowser);
  m.start(configFor(0));

  assert.throws(
    () => m.start(configFor(1)),
    (e: unknown) =>
      e instanceof ManagerError && e.code === "limit" && /Maximal 1 gleichzeitige Sessions/.test(e.message) && /Einstellungen/.test(e.message)
  );
  assert.equal(m.activeCount(), 1);
});

test("0 = unbegrenzt: es gibt keine Sperre, auch weit über dem früheren Höchstwert von 10", () => {
  const m = new SessionManager(monitor, () => 0);

  m.setBrowser(hangingBrowser);

  for (let i = 0; i < 60; i++) m.start(configFor(i));

  assert.equal(m.activeCount(), 60);
});

test("ohne Browser: no_browser, vor dem Limit-Check", () => {
  const m = new SessionManager(monitor, () => 0);

  assert.throws(() => m.start(cfg), (e: unknown) => e instanceof ManagerError && e.code === "no_browser");
});

test("Keine feste Obergrenze: so viele Sessions wie eingestellt starten, die nächste scheitert erst am eingestellten Wert", () => {
  for (const limit of [12, 40]) {
    const m = new SessionManager(monitor, () => limit);

    m.setBrowser(hangingBrowser);

    for (let i = 0; i < limit; i++) m.start(configFor(i));

    assert.equal(m.activeCount(), limit, `${limit} parallele Sessions`);
    assert.throws(
      () => m.start(configFor(limit)),
      (e: unknown) => e instanceof ManagerError && e.code === "limit" && e.message.includes(`Maximal ${limit}`)
    );
    assert.equal(m.activeCount(), limit);
  }
});
