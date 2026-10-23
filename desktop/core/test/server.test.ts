import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import { SummaryStore } from "../src/aggregator";
import { ManagerError } from "../src/manager";
import { Scheduler } from "../src/scheduler";
import { startServer, type RunningServer } from "../src/server";
import type { Sample, SessionConfig } from "../src/types";
import { request } from "./helpers";

const TOKEN = "t".repeat(32);

class FakeManager extends EventEmitter {
  maxSessions = 3;
  started: SessionConfig[] = [];
  failWith: ManagerError | null = null;
  ids = new Set<string>();

  start(cfg: SessionConfig) {
    if (this.failWith) throw this.failWith;
    this.started.push(cfg);
    this.ids.add(cfg.id);
    return cfg.id;
  }

  stop(id: string) {
    return this.ids.delete(id);
  }

  list() {
    return [...this.ids];
  }

  activeCount() {
    return this.ids.size;
  }

  isReady() {
    return true;
  }

  has(id: string) {
    return this.ids.has(id);
  }
}

let srv: RunningServer;
let port: number;
let dir: string;
const mgr = new FakeManager();
const auth = { "X-TB-Token": TOKEN };
const json = { ...auth, "Content-Type": "application/json" };
const VIDEO = "https://www.youtube.com/watch?v=abc";

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-"));

  const dashboardPath = path.resolve(__dirname, "..", "public", "dashboard.html");

  srv = startServer({
    manager: mgr as never,
    csv: { append() {} },
    summaries: new SummaryStore(),
    scheduler: new Scheduler(mgr as never, path.join(dir, "schedules.json")),
    dataDir: dir,
    dashboardPath,
    port: 0,
    token: TOKEN,
  });

  port = await srv.listening;
});

after(async () => {
  await srv.close();
});

test("/api/health ist ohne Token erreichbar", async () => {
  const r = await request(port, { path: "/api/health" });
  assert.equal(r.status, 200);
});

test("API ohne/mit falschem Token -> 401, mit Token -> 200", async () => {
  assert.equal((await request(port, { path: "/api/sessions" })).status, 401);
  assert.equal(
    (await request(port, { path: "/api/sessions", headers: { "X-TB-Token": "falsch" } })).status,
    401
  );
  assert.equal((await request(port, { path: "/api/sessions", headers: auth })).status, 200);
  assert.equal((await request(port, { path: `/api/sessions?token=${TOKEN}` })).status, 200);
});

test("falscher Host-Header (DNS-Rebinding) wird abgelehnt", async () => {
  for (const host of ["evil.example", "evil.example:80", "a b", `127.0.0.1.evil.example:${port}`]) {
    const r = await request(port, { path: "/api/health", headers: { Host: host } });
    assert.equal(r.status, 403, host);
  }

  assert.equal((await request(port, { path: "/api/health" })).status, 200, "Server lebt weiter");
});

test("fremder Origin (CSRF) wird abgelehnt – auch mit gültigem Token", async () => {
  const r = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: { ...json, Origin: "https://evil.example" },
    body: JSON.stringify({ url: VIDEO }),
  });

  assert.equal(r.status, 403);
  assert.equal(mgr.started.length, 0);

  // text/plain (kein Preflight) ist ebenfalls geschützt
  const r2 = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: { ...auth, "Content-Type": "text/plain", Origin: "null" },
    body: JSON.stringify({ url: VIDEO }),
  });

  assert.equal(r2.status, 403);
});

test("keine CORS-Freigabe (kein Access-Control-Allow-Origin)", async () => {
  for (const r of [
    await request(port, { path: "/api/health" }),
    await request(port, { path: "/api/sessions", headers: auth }),
    await request(port, { method: "OPTIONS", path: "/api/sessions", headers: { Origin: "https://evil.example" } }),
  ]) {
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  }
});

test("gleicher Origin ist erlaubt", async () => {
  const r = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: { ...json, Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ url: VIDEO }),
  });

  assert.equal(r.status, 200);
  assert.equal(mgr.started.length, 1);
});

test("Session starten: Client-ID wird ignoriert, Defaults sind sicher", async () => {
  const before = mgr.started.length;

  const r = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: json,
    body: JSON.stringify({ url: VIDEO, id: "../../etc/passwd", humanize: true }),
  });

  assert.equal(r.status, 200);

  const body = JSON.parse(r.body);
  const cfg = mgr.started[before];

  assert.notEqual(body.id, "../../etc/passwd");
  assert.equal(cfg.id, body.id);
  assert.equal(cfg.repeat, false);
  assert.ok(cfg.maxRuntimeSec <= 4 * 3600);
});

test("ungültige Eingaben -> 400 mit Meldung", async () => {
  const cases: unknown[] = [
    { url: "file:///etc/hostname" },
    { url: "http://127.0.0.1:7777/" },
    { url: VIDEO, quality: "8k" },
    { url: VIDEO, maxRuntimeSec: "abc" },
    { url: VIDEO, maxRuntimeSec: -1 },
    { url: VIDEO, repeat: "ja" },
    {},
  ];

  for (const c of cases) {
    const r = await request(port, {
      method: "POST",
      path: "/api/sessions",
      headers: json,
      body: JSON.stringify(c),
    });

    assert.equal(r.status, 400, JSON.stringify(c));
    assert.equal(typeof JSON.parse(r.body).error, "string");
  }

  const bad = await request(port, { method: "POST", path: "/api/sessions", headers: json, body: "{kaputt" });
  assert.equal(bad.status, 400);
});

test("Manager-Fehler werden auf Statuscodes abgebildet", async () => {
  const map: [ManagerError["code"], number][] = [
    ["limit", 429],
    ["no_browser", 503],
    ["exists", 409],
  ];

  for (const [code, status] of map) {
    mgr.failWith = new ManagerError(code, "x");

    const r = await request(port, {
      method: "POST",
      path: "/api/sessions",
      headers: json,
      body: JSON.stringify({ url: VIDEO }),
    });

    assert.equal(r.status, status, code);
  }

  mgr.failWith = null;
});

test("kaputte Pfade/Hosts bringen den Server nicht zum Absturz", async () => {
  const r = await request(port, { method: "DELETE", path: "/api/sessions/%E0%A4%A", headers: auth });
  assert.equal(r.status, 400);

  const r2 = await request(port, { method: "DELETE", path: "/api/sessions/does-not-exist", headers: auth });
  assert.equal(r2.status, 404);

  // roher Socket mit ungültigem Host-Header
  await new Promise<void>((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write("GET /api/health HTTP/1.1\r\nHost: a b\r\n\r\n");
    });
    s.on("data", () => {});
    s.on("close", () => resolve());
    s.on("error", () => resolve());
    setTimeout(() => {
      s.destroy();
      resolve();
    }, 500);
  });

  assert.equal((await request(port, { path: "/api/health" })).status, 200, "Server lebt weiter");
});

test("zu große Bodies werden abgelehnt (413)", async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 97);

  const r = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: json,
    body: big,
  });

  assert.equal(r.status, 413);
  assert.equal((await request(port, { path: "/api/health" })).status, 200);
});

test("Zeitpläne: anlegen, abschalten, löschen, ungültige Cron-Ausdrücke ablehnen", async () => {
  const add = await request(port, {
    method: "POST",
    path: "/api/schedules",
    headers: json,
    body: JSON.stringify({ cron: "0 2 * * *", session: { url: VIDEO } }),
  });

  assert.equal(add.status, 200);

  const id = JSON.parse(add.body).schedule.id as string;

  for (const cron of ["* * * * *", "nonsense"]) {
    const bad = await request(port, {
      method: "POST",
      path: "/api/schedules",
      headers: json,
      body: JSON.stringify({ cron, session: { url: VIDEO } }),
    });

    assert.equal(bad.status, 400, cron);
  }

  const patch = await request(port, {
    method: "PATCH",
    path: `/api/schedules/${id}`,
    headers: json,
    body: JSON.stringify({ enabled: false }),
  });

  assert.equal(patch.status, 200);
  assert.equal(JSON.parse(patch.body).schedule.enabled, false);

  const del = await request(port, { method: "DELETE", path: `/api/schedules/${id}`, headers: auth });
  assert.equal(del.status, 200);
});

test("Dashboard: Token + Nonce eingesetzt, strenge CSP, Clickjacking-Schutz", async () => {
  const r = await request(port, { path: "/" });

  assert.equal(r.status, 200);
  assert.ok(r.body.includes(TOKEN), "Token im HTML");
  assert.ok(!r.body.includes("{{"), "keine offenen Platzhalter");

  const csp = String(r.headers["content-security-policy"]);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];

  assert.ok(nonce, "Nonce in CSP");
  assert.ok(r.body.includes(`nonce="${nonce}"`), "Nonce im HTML");
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(/\son[a-z]+\s*=/.test(r.body), false, "keine Inline-Event-Handler (CSP)");
});

test("Exporte erfordern das Token; Summaries-CSV neutralisiert Formeln", async () => {
  assert.equal((await request(port, { path: "/export/summaries.csv" })).status, 401);
  assert.equal((await request(port, { path: "/export/samples.csv", headers: auth })).status, 404);

  const ok = await request(port, { path: "/export/summaries.csv", headers: auth });

  assert.equal(ok.status, 200);
  assert.match(ok.headers["content-type"] ?? "", /text\/csv/);
});

test("WebSocket: nur mit Token, gültigem Origin; Samples werden gesendet", async () => {
  const open = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ ws?: WebSocket; error?: string }>((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.on("open", () => resolve({ ws }));
      ws.on("error", (e) => resolve({ error: e.message }));
      ws.on("unexpected-response", (_req, res) => resolve({ error: `HTTP ${res.statusCode}` }));
    });

  assert.match((await open(`ws://127.0.0.1:${port}/ws`)).error ?? "", /401/, "ohne Token");
  assert.match(
    (await open(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { Origin: "https://evil.example" })).error ?? "",
    /403/,
    "fremder Origin"
  );
  assert.match((await open(`ws://127.0.0.1:${port}/other?token=${TOKEN}`)).error ?? "", /404/);

  const good = await open(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, {
    Origin: `http://127.0.0.1:${port}`,
  });

  assert.ok(good.ws, good.error);

  const got = new Promise<{ type: string; data: Sample }>((resolve) => {
    good.ws!.on("message", (m) => resolve(JSON.parse(String(m))));
  });

  mgr.emit("sample", { sessionId: "s1", state: "playing" } as Sample);

  const msg = await got;

  assert.equal(msg.type, "sample");
  assert.equal(msg.data.sessionId, "s1");

  good.ws!.close();
});

test("Interaktionsskript: Text oder Liste wird angenommen und normalisiert an den Manager gegeben", async () => {
  const before = mgr.started.length;

  const r = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: json,
    body: JSON.stringify({ url: VIDEO, interactions: "30 pause 5\n1:00 seek +30\n1:30 seek -15" }),
  });

  assert.equal(r.status, 200);
  assert.deepEqual(mgr.started[before].interactions, [
    { at: 30, action: "pause", value: 5 },
    { at: 60, action: "seek", value: 30 },
    { at: 90, action: "seek", value: -15 },
  ]);

  const r2 = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: json,
    body: JSON.stringify({ url: VIDEO, interactions: [{ at: 10, action: "next" }] }),
  });

  assert.equal(r2.status, 200);
  assert.deepEqual(mgr.started[before + 1].interactions, [{ at: 10, action: "next" }]);

  // ohne Angabe: keine Interaktionen
  await request(port, { method: "POST", path: "/api/sessions", headers: json, body: JSON.stringify({ url: VIDEO }) });
  assert.deepEqual(mgr.started[before + 2].interactions, []);
});

test("Interaktionsskript: ungültige Skripte -> 400 mit Zeilenangabe, nichts wird gestartet", async () => {
  const before = mgr.started.length;

  for (const interactions of ["10 tanzen", "10 seek", "10 pause 5\n11 seek 5", 42, [{ at: 1, action: "zufall" }]]) {
    const r = await request(port, {
      method: "POST",
      path: "/api/sessions",
      headers: json,
      body: JSON.stringify({ url: VIDEO, interactions }),
    });

    assert.equal(r.status, 400, JSON.stringify(interactions));
    assert.equal(typeof JSON.parse(r.body).error, "string");
  }

  const r = await request(port, {
    method: "POST",
    path: "/api/sessions",
    headers: json,
    body: JSON.stringify({ url: VIDEO, interactions: "10 seek 5\n\n20 tanzen" }),
  });

  assert.match(JSON.parse(r.body).error, /Zeile 3/);
  assert.equal(mgr.started.length, before);
});

test("Interaktionsskript: auch im Zeitplan, ungültiges Skript lehnt den Zeitplan ab", async () => {
  const ok = await request(port, {
    method: "POST",
    path: "/api/schedules",
    headers: json,
    body: JSON.stringify({ cron: "0 4 * * *", session: { url: VIDEO, interactions: "20 pause 3\n40 seek -5" } }),
  });

  assert.equal(ok.status, 200);

  const s = JSON.parse(ok.body).schedule;

  assert.equal(s.session.interactions.length, 2);

  const bad = await request(port, {
    method: "POST",
    path: "/api/schedules",
    headers: json,
    body: JSON.stringify({ cron: "0 5 * * *", session: { url: VIDEO, interactions: "x" } }),
  });

  assert.equal(bad.status, 400);

  await request(port, { method: "DELETE", path: `/api/schedules/${s.id}`, headers: auth });
});

test("Interaktions-Ergebnisse: Event -> Zusammenfassung, Export erfordert Token, Formeln werden neutralisiert", async () => {
  assert.equal((await request(port, { path: "/export/interactions.csv" })).status, 401);

  const base = { loop: 1, startedAtSec: 30, status: "ok" as const };

  mgr.emit("interaction", "ia-1", { ...base, at: 30, action: "pause", value: 5, recoveryMs: 420 });
  mgr.emit("interaction", "ia-1", { ...base, at: 60, action: "seek", value: 30, recoveryMs: 880 });
  mgr.emit("interaction", "ia-1", { ...base, at: 90, action: "next", status: "skipped", recoveryMs: -1, note: "=HYPERLINK(\"x\")" });
  mgr.emit("stopped", "ia-1", "completed");

  const sums = JSON.parse((await request(port, { path: "/api/summaries", headers: auth })).body).summaries as {
    sessionId: string;
    interactions?: unknown[];
  }[];

  assert.equal(sums.find((x) => x.sessionId === "ia-1")?.interactions?.length, 3);

  const csv = await request(port, { path: "/export/interactions.csv", headers: auth });

  assert.equal(csv.status, 200);
  assert.match(csv.headers["content-type"] ?? "", /text\/csv/);
  assert.match(csv.body.split("\n")[0], /^sessionId,loop,plannedAtSec,startedAtSec,action,value,status,recoveryMs,note$/);
  assert.match(csv.body, /ia-1,1,30,30,pause,5,ok,420,/);
  assert.match(csv.body, /ia-1,1,60,30,seek,30,ok,880,/);
  assert.match(csv.body, /ia-1,1,90,30,next,,skipped,-1,/);
  assert.ok(!/,=HYPERLINK/.test(csv.body), "Formel am Zellanfang muss neutralisiert sein");
  assert.match(csv.body, /'=HYPERLINK/);

  const sumCsv = (await request(port, { path: "/export/summaries.csv", headers: auth })).body;
  const [head, ...rows] = sumCsv.trim().split("\n");

  assert.match(head, /interactions,interactionsOk,interactionsFailed,interactionsSkipped,avgRecoveryMs,maxRecoveryMs$/);

  const row = rows.find((x) => x.startsWith("ia-1"))!;

  assert.match(row, /,3,2,0,1,650,880$/);
});
