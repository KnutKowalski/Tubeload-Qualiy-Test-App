import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Scheduler, validateCron } from "../src/scheduler";
import { ValidationError, parseSessionInput } from "../src/validate";
import type { SessionManager } from "../src/manager";
import type { SessionConfig } from "../src/types";

class FakeManager {
  ready = true;
  started: SessionConfig[] = [];
  running = new Set<string>();
  failWith: Error | null = null;

  isReady() {
    return this.ready;
  }

  has(id: string) {
    return this.running.has(id);
  }

  start(cfg: SessionConfig) {
    if (this.failWith) throw this.failWith;
    this.started.push(cfg);
    this.running.add(cfg.id);
    return cfg.id;
  }
}

const session = () => parseSessionInput({ url: "https://www.youtube.com/watch?v=abc" });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-sch-")), "schedules.json");

// tick() ist privat; der Test ruft ihn bewusst direkt auf.
const tick = (s: Scheduler) => (s as unknown as { tick(): void }).tick();

test("validateCron: gültig, ungültig, zu häufig", () => {
  assert.equal(validateCron("0 2 * * *"), "0 2 * * *");
  assert.equal(validateCron("*/10 * * * *"), "*/10 * * * *");

  for (const bad of ["* * * * *", "*/4 * * * *", "*/10 * * * * *", "nonsense", "", 5, null]) {
    assert.throws(() => validateCron(bad), ValidationError, String(bad));
  }
});

test("Lauf wird gestartet, wenn fällig, und bei Nichtbereitschaft nicht verbraucht", () => {
  const mgr = new FakeManager();
  const sch = new Scheduler(mgr as unknown as SessionManager, tmpFile());
  const added = sch.add({ cron: "0 2 * * *", session: session() });

  // fällig machen
  const internal = (sch as unknown as { schedules: { nextRun: number }[] }).schedules[0];
  internal.nextRun = Date.now() - 1000;

  mgr.ready = false;
  tick(sch);
  assert.equal(mgr.started.length, 0, "Browser nicht bereit: nichts starten");
  assert.ok(internal.nextRun < Date.now(), "Lauf darf nicht verbraucht werden");

  mgr.ready = true;
  tick(sch);
  assert.equal(mgr.started.length, 1);
  assert.ok(mgr.started[0].id.startsWith(added.id));
  assert.ok(internal.nextRun > Date.now(), "nächster Lauf wurde neu berechnet");
});

test("Fehler beim Start werden am Zeitplan sichtbar gemacht, statt verschluckt", () => {
  const mgr = new FakeManager();
  mgr.failWith = new Error("Maximal 3 gleichzeitige Sessions");

  const sch = new Scheduler(mgr as unknown as SessionManager, tmpFile());
  sch.add({ cron: "0 2 * * *", session: session() });

  (sch as unknown as { schedules: { nextRun: number }[] }).schedules[0].nextRun = Date.now() - 1000;
  tick(sch);

  assert.match(sch.list()[0].lastError ?? "", /Maximal 3/);
});

test("Überlappung und verpasste Läufe werden übersprungen", () => {
  const mgr = new FakeManager();
  const sch = new Scheduler(mgr as unknown as SessionManager, tmpFile());
  sch.add({ cron: "0 2 * * *", session: session() });
  const internal = (sch as unknown as { schedules: { nextRun: number; lastSessionId?: string }[] }).schedules[0];

  // 1) vorheriger Lauf aktiv
  internal.lastSessionId = "alt";
  mgr.running.add("alt");
  internal.nextRun = Date.now() - 1000;
  tick(sch);
  assert.equal(mgr.started.length, 0);
  assert.match(sch.list()[0].lastError ?? "", /noch aktiv/);

  // 2) Lauf lag Stunden zurück (App war aus) -> nicht nachholen
  mgr.running.clear();
  internal.nextRun = Date.now() - 3 * 60 * 60 * 1000;
  tick(sch);
  assert.equal(mgr.started.length, 0);
  assert.match(sch.list()[0].lastError ?? "", /verpasst/);
});

test("Laden: alte Dateien werden normalisiert, kaputte Einträge übersprungen", () => {
  const file = tmpFile();

  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        id: "ok1",
        cron: "0 2 * * *",
        enabled: true,
        createdAt: 1,
        session: { url: "https://www.youtube.com/watch?v=abc", humanize: true, repeat: true, quality: "720p" },
      },
      { id: "bad-cron", cron: "* * * * *", session: { url: "https://www.youtube.com/watch?v=abc" } },
      { id: "bad-url", cron: "0 2 * * *", session: { url: "file:///etc/passwd" } },
      "müll",
    ])
  );

  const sch = new Scheduler(new FakeManager() as unknown as SessionManager, file);
  const list = sch.list();

  assert.equal(list.length, 1);
  assert.equal(list[0].id, "ok1");
  assert.equal("humanize" in list[0].session, false);
  assert.equal(list[0].session.repeat, true);
});

test("setEnabled und remove", () => {
  const sch = new Scheduler(new FakeManager() as unknown as SessionManager, tmpFile());
  const a = sch.add({ cron: "0 2 * * *", session: session() });

  assert.equal(sch.setEnabled(a.id, false)?.enabled, false);
  assert.equal(sch.setEnabled("nope", true), null);
  assert.equal(sch.remove(a.id), true);
  assert.equal(sch.remove(a.id), false);
});
