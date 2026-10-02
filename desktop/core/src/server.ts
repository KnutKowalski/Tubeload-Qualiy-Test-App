import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

import type { SessionManager } from "./manager";
import type { CsvWriter } from "./csv";
import { csvEscape } from "./csv";
import type { SummaryStore } from "./aggregator";
import type { Scheduler } from "./scheduler";
import type { Sample, SessionConfig, SessionSummary } from "./types";
import { detectUrlKind } from "./url";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export interface ServerDeps {
  manager: SessionManager;
  csv: CsvWriter;
  summaries: SummaryStore;
  scheduler: Scheduler;
  dataDir: string;
  dashboardPath: string;
  port?: number;
}

export function startServer(deps: ServerDeps) {
  const { manager, csv, summaries, scheduler, dataDir, dashboardPath } = deps;
  const port = deps.port ?? Number(process.env.PORT ?? 7777);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/" && req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      fs.createReadStream(dashboardPath).pipe(res);
      return;
    }

    if (url.pathname === "/api/health" && req.method === "GET") {
      json(res, 200, { ok: true, ts: Date.now() });
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      json(res, 200, { ids: manager.list() });
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as Partial<SessionConfig>;

        if (!body.url) {
          json(res, 400, { ok: false, error: "url required" });
          return;
        }

        const cfg: SessionConfig = {
          id: body.id ?? crypto.randomUUID(),
          url: body.url,
          kind: detectUrlKind(body.url, body.kind ?? "auto"),
          quality: body.quality ?? "auto",
          humanize: body.humanize ?? true,
          repeat: body.repeat ?? true,
          maxRuntimeSec: body.maxRuntimeSec,
          mute: body.mute ?? true,
          consentMode: body.consentMode ?? "reject",
        };

        manager.start(cfg);

        json(res, 200, { ok: true, id: cfg.id, kind: cfg.kind });
      } catch (e: any) {
        json(res, 400, { ok: false, error: String(e) });
      }
      return;
    }

    if (url.pathname.startsWith("/api/sessions/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      manager.stop(id);

      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/summaries" && req.method === "GET") {
      json(res, 200, { summaries: summaries.all() });
      return;
    }

    if (url.pathname === "/api/schedules" && req.method === "GET") {
      json(res, 200, { schedules: scheduler.list() });
      return;
    }

    if (url.pathname === "/api/schedules" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));

        if (!body.cron || !body.session?.url) {
          json(res, 400, {
            ok: false,
            error: "cron and session.url required",
          });
          return;
        }

        const schedule = scheduler.add({
          cron: body.cron,
          enabled: body.enabled ?? true,
          session: {
            url: body.session.url,
            kind: detectUrlKind(body.session.url, body.session.kind ?? "auto"),
            quality: body.session.quality ?? "auto",
            humanize: body.session.humanize ?? true,
            repeat: body.session.repeat ?? true,
            maxRuntimeSec: body.session.maxRuntimeSec,
            mute: body.session.mute ?? true,
            consentMode: body.session.consentMode ?? "reject",
          },
        });

        json(res, 200, { ok: true, schedule });
      } catch (e: any) {
        json(res, 400, { ok: false, error: String(e) });
      }
      return;
    }

    if (url.pathname.startsWith("/api/schedules/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const ok = scheduler.remove(id);

      json(res, ok ? 200 : 404, { ok });
      return;
    }

    if (url.pathname === "/export/samples.csv" && req.method === "GET") {
      const file = path.join(dataDir, "samples.csv");

      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.end("no data");
        return;
      }

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="tubeload-samples.csv"'
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (url.pathname === "/export/summaries.csv" && req.method === "GET") {
      const rows = summaries.all();

      const header = [
        "sessionId",
        "runtimeSec",
        "avgBandwidthMBps",
        "peakBandwidthMBps",
        "p95BandwidthMBps",
        "stalls",
        "stallSeconds",
        "dominantQuality",
        "droppedFrameRatio",
        "finishedAt",
      ];

      const lines = [header.join(",")];

      for (const r of rows) {
        lines.push(
          [
            csvEscape(r.sessionId),
            r.runtimeSec,
            r.avgBandwidthMBps,
            r.peakBandwidthMBps,
            r.p95BandwidthMBps,
            r.stalls,
            r.stallSeconds,
            csvEscape(r.dominantQuality),
            r.droppedFrameRatio,
            new Date(r.finishedAt).toISOString(),
          ].join(",")
        );
      }

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="tubeload-summaries.csv"'
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.end(lines.join("\n") + "\n");
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  const broadcast = (type: string, data: unknown) => {
    const msg = JSON.stringify({ type, data });

    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  };

  manager.on("sample", (sample: Sample) => {
    csv.append(sample);
    summaries.add(sample);
    broadcast("sample", sample);
  });

  manager.on("started", (sessionId: string) => {
    broadcast("status", { sessionId, state: "starting" });
  });

  manager.on("stopped", (sessionId: string) => {
    const summary: SessionSummary | null = summaries.finish(sessionId);

    if (summary) {
      broadcast("summary", summary);
    }

    broadcast("status", { sessionId, state: "stopped" });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`TubeLoad QA Dashboard: http://127.0.0.1:${port}`);
  });

  return server;
}
