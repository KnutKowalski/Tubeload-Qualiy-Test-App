import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";

import { SummaryStore } from "../src/aggregator";
import { Scheduler } from "../src/scheduler";
import { startServer, type RunningServer } from "../src/server";
import { request } from "./helpers";
import fs from "node:fs";
import os from "node:os";

// Zeichen, die beim Einsetzen in HTML/Templates Probleme machen: $& $$ " < > ' und &
const TOKEN = `ab$&cd$$e"<f>'g&amp;h-1234567890`;

class FakeManager extends EventEmitter {
  maxSessions = 3;
  start() { return "x"; }
  stop() { return false; }
  list() { return []; }
  activeCount() { return 0; }
  isReady() { return true; }
  has() { return false; }
}

let srv: RunningServer;
let port: number;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tok-"));
  const mgr = new FakeManager();

  srv = startServer({
    manager: mgr as never,
    csv: { append() {} },
    summaries: new SummaryStore(),
    scheduler: new Scheduler(mgr as never, path.join(dir, "schedules.json")),
    dataDir: dir,
    dashboardPath: path.resolve(__dirname, "..", "public", "dashboard.html"),
    port: 0,
    token: TOKEN,
  });

  port = await srv.listening;
});

after(async () => {
  await srv.close();
});

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

test("Token mit Sonderzeichen wird unverfälscht und HTML-sicher in das Dashboard eingesetzt", async () => {
  const r = await request(port, { path: `/?token=${encodeURIComponent(TOKEN)}` });

  assert.equal(r.status, 200);
  assert.ok(!r.body.includes("{{"), "keine offenen Platzhalter (auch nicht durch $&-Ersetzung)");

  const content = /<meta name="tb-token" content="([^"]*)"/.exec(r.body)?.[1];

  assert.ok(content, "Meta-Tag mit Token vorhanden und Attribut nicht aufgebrochen");
  assert.equal(unescape(content!), TOKEN);
  assert.ok(!r.body.includes(`content="${TOKEN}"`), "Token muss im Attribut maskiert sein");
});

test("Mit diesem Token funktionieren API (Header) und Ablehnung falscher Token", async () => {
  assert.equal((await request(port, { path: "/api/sessions", headers: { "X-TB-Token": TOKEN } })).status, 200);
  assert.equal((await request(port, { path: "/api/sessions", headers: { "X-TB-Token": TOKEN + "x" } })).status, 401);
  assert.equal((await request(port, { path: "/" })).status, 401);
});
