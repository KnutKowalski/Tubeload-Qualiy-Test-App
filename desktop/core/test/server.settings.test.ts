import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SummaryStore } from "../src/aggregator";
import { ManagerError } from "../src/manager";
import { RecentUrls } from "../src/recentUrls";
import { Scheduler } from "../src/scheduler";
import { startServer, type RunningServer } from "../src/server";
import { SettingsStore, defaultSettings } from "../src/settings";
import type { SessionConfig } from "../src/types";
import { request } from "./helpers";

const TOKEN = "s".repeat(32);
const auth = { "X-TB-Token": TOKEN };
const json = { ...auth, "Content-Type": "application/json" };
const VIDEO = "https://www.youtube.com/watch?v=abc";
const VIDEO2 = "https://www.youtube.com/watch?v=def";

class FakeManager extends EventEmitter {
  maxSessions = 3;
  started: SessionConfig[] = [];
  failWith: ManagerError | null = null;

  start(cfg: SessionConfig) {
    if (this.failWith) throw this.failWith;
    this.started.push(cfg);
    return cfg.id;
  }

  stop() {
    return false;
  }

  list() {
    return [];
  }

  activeCount() {
    return 0;
  }

  isReady() {
    return true;
  }

  has() {
    return false;
  }
}

let dir: string;
let srv: RunningServer;
let port: number;
let mgr: FakeManager;

function boot(): Promise<void> {
  mgr = new FakeManager();

  const settings = new SettingsStore(path.join(dir, "settings.json"), defaultSettings({}));
  const recent = new RecentUrls(path.join(dir, "recent-urls.json"));

  srv = startServer({
    manager: mgr as never,
    csv: { append() {} },
    summaries: new SummaryStore(),
    scheduler: new Scheduler(
      mgr as never,
      path.join(dir, "schedules.json"),
      () => settings.get().minScheduleIntervalMin * 60
    ),
    settings,
    recent,
    dataDir: dir,
    dashboardPath: path.resolve(__dirname, "..", "public", "dashboard.html"),
    port: 0,
    token: TOKEN,
  });

  return srv.listening.then((p) => {
    port = p;
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-set-"));
  await boot();
});

after(async () => {
  await srv.close();
});

const call = (method: string, p: string, body?: unknown, headers = json) =>
  request(port, { method, path: p, headers, body: body === undefined ? undefined : JSON.stringify(body) });

test("Einstellungen: erfordern das Token", async () => {
  for (const [m, p] of [["GET", "/api/settings"], ["PUT", "/api/settings"], ["POST", "/api/settings/reset"]]) {
    assert.equal((await request(port, { method: m, path: p })).status, 401, `${m} ${p}`);
  }
});

test("Einstellungen: lesen liefert Werte, Standardwerte und Grenzen", async () => {
  const r = await call("GET", "/api/settings", undefined, auth);
  const b = JSON.parse(r.body);

  assert.equal(r.status, 200);
  assert.deepEqual(b.settings, { maxSessions: 3, defaultLoops: 3, defaultRuntimeMin: 30, minScheduleIntervalMin: 5 });
  assert.deepEqual(b.defaults, b.settings);
  assert.deepEqual(b.bounds.maxSessions, { min: 1, max: 10 });
});

test("Einstellungen: ungültige Eingaben -> 400, nichts wird geändert", async () => {
  for (const body of [{ maxSessions: 11 }, { defaultLoops: 0 }, { foo: 1 }, { maxSessions: "5" }, []]) {
    const r = await call("PUT", "/api/settings", body);

    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof JSON.parse(r.body).error, "string");
  }

  assert.equal((await request(port, { method: "PUT", path: "/api/settings", headers: json, body: "{kaputt" })).status, 400);
  assert.equal(JSON.parse((await call("GET", "/api/settings", undefined, auth)).body).settings.maxSessions, 3);
});

test("Einstellungen: fremder Origin (CSRF) wird abgelehnt", async () => {
  const r = await call("PUT", "/api/settings", { maxSessions: 9 }, { ...json, Origin: "https://evil.example" });

  assert.equal(r.status, 403);
  assert.equal(JSON.parse((await call("GET", "/api/settings", undefined, auth)).body).settings.maxSessions, 3);
});

test("Einstellungen wirken: Standard-Läufe/-Laufzeit und Zeitplan-Abstand, auch nach Neustart", async () => {
  const put = await call("PUT", "/api/settings", { defaultLoops: 6, defaultRuntimeMin: 45, minScheduleIntervalMin: 1 });

  assert.equal(put.status, 200);

  // Standardwerte neuer Sessions
  const s = await call("POST", "/api/sessions", { url: VIDEO, repeat: true });

  assert.equal(s.status, 200);
  assert.equal(mgr.started.at(-1)!.maxLoops, 6);
  assert.equal(mgr.started.at(-1)!.maxRuntimeSec, 45 * 60);

  // explizit angegebene Werte gelten weiterhin
  await call("POST", "/api/sessions", { url: VIDEO, repeat: true, maxLoops: 2 });
  assert.equal(mgr.started.at(-1)!.maxLoops, 2);

  // feste Obergrenze gilt trotz Einstellung
  assert.equal((await call("POST", "/api/sessions", { url: VIDEO, maxLoops: 11 })).status, 400);

  // Zeitplan-Abstand: jetzt 1 Minute erlaubt
  assert.equal((await call("POST", "/api/schedules", { cron: "*/2 * * * *", session: { url: VIDEO } })).status, 200);

  // Neustart: alles wird aus dem Datenordner gelesen
  await srv.close();
  await boot();

  assert.deepEqual(JSON.parse((await call("GET", "/api/settings", undefined, auth)).body).settings, {
    maxSessions: 3,
    defaultLoops: 6,
    defaultRuntimeMin: 45,
    minScheduleIntervalMin: 1,
  });
});

test("Einstellungen: Zurücksetzen", async () => {
  const r = await call("POST", "/api/settings/reset", {});

  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).settings, { maxSessions: 3, defaultLoops: 3, defaultRuntimeMin: 30, minScheduleIntervalMin: 5 });

  // der Abstand von 5 Minuten gilt wieder für neue Zeitpläne
  assert.equal((await call("POST", "/api/schedules", { cron: "*/2 * * * *", session: { url: VIDEO } })).status, 400);
});

test("Gespeicherte URLs: erfordern das Token", async () => {
  for (const m of ["GET", "POST", "DELETE"]) {
    assert.equal((await request(port, { method: m, path: "/api/recent-urls" })).status, 401, m);
  }
});

test("Gespeicherte URLs: speichern, neueste zuerst, überleben Neustart", async () => {
  assert.equal((await call("POST", "/api/recent-urls", { url: VIDEO })).status, 200);

  const r = await call("POST", "/api/recent-urls", { url: VIDEO2 });

  assert.deepEqual(JSON.parse(r.body).urls, [VIDEO2, VIDEO]);

  await srv.close();
  await boot();

  assert.deepEqual(JSON.parse((await call("GET", "/api/recent-urls", undefined, auth)).body).urls, [VIDEO2, VIDEO]);
});

test("Gespeicherte URLs: ungültige URLs -> 400", async () => {
  for (const url of ["file:///etc/passwd", "http://127.0.0.1/", "https://evil.example/", "", 5]) {
    assert.equal((await call("POST", "/api/recent-urls", { url })).status, 400, String(url));
  }

  assert.equal((await request(port, { method: "POST", path: "/api/recent-urls", headers: json, body: "{kaputt" })).status, 400);
  assert.equal(JSON.parse((await call("GET", "/api/recent-urls", undefined, auth)).body).urls.length, 2);
});

test("Gespeicherte URLs: entfernen (404, wenn nicht vorhanden)", async () => {
  const del = await call("DELETE", `/api/recent-urls?url=${encodeURIComponent(VIDEO)}`, undefined, auth);

  assert.equal(del.status, 200);
  assert.deepEqual(JSON.parse(del.body).urls, [VIDEO2]);

  assert.equal((await call("DELETE", `/api/recent-urls?url=${encodeURIComponent(VIDEO)}`, undefined, auth)).status, 404);
  assert.equal((await call("DELETE", "/api/recent-urls", undefined, auth)).status, 404);
});

test("Gespeicherte URLs: ein Start merkt die URL – auch wenn er am Limit scheitert", async () => {
  await call("DELETE", `/api/recent-urls?url=${encodeURIComponent(VIDEO2)}`, undefined, auth);

  const url = "https://youtu.be/xyz";

  mgr.failWith = new ManagerError("limit", "x");
  assert.equal((await call("POST", "/api/sessions", { url })).status, 429);
  mgr.failWith = null;

  assert.deepEqual(JSON.parse((await call("GET", "/api/recent-urls", undefined, auth)).body).urls, [url]);
});

test("Gespeicherte URLs: ein ungültiger Start speichert nichts; ein Zeitplan speichert die URL", async () => {
  await call("POST", "/api/sessions", { url: "https://evil.example/", maxLoops: 1 });
  assert.deepEqual(JSON.parse((await call("GET", "/api/recent-urls", undefined, auth)).body).urls, ["https://youtu.be/xyz"]);

  assert.equal((await call("POST", "/api/schedules", { cron: "0 3 * * *", session: { url: VIDEO } })).status, 200);
  assert.equal(JSON.parse((await call("GET", "/api/recent-urls", undefined, auth)).body).urls[0], VIDEO);
});

test("Dashboard enthält Einstellungen und speichert keine URLs mehr im Browser-Speicher", async () => {
  const html = (await request(port, { path: "/" })).body;

  assert.match(html, /id="settingsForm"/);
  assert.match(html, /name="maxSessions"/);
  assert.match(html, /name="minScheduleIntervalMin"/);
  assert.equal(/localStorage/.test(html), false, "kein localStorage: der gilt pro Port und geht beim Neustart verloren");
});
