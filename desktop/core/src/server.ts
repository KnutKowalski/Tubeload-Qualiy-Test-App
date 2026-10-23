import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import type { CsvWriter } from "./csv";
import { csvEscape } from "./csv";
import { LIMITS } from "./limits";
import { log } from "./log";
import { ManagerError, type SessionManager } from "./manager";
import { RecentUrls } from "./recentUrls";
import type { Scheduler } from "./scheduler";
import {
  SETTING_BOUNDS,
  SettingsStore,
  sessionDefaultsFrom,
} from "./settings";
import type { SummaryStore } from "./aggregator";
import type { EndReason, InteractionResult, Sample, SessionSummary } from "./types";
import { parseSessionInput, ValidationError } from "./validate";

export interface ServerDeps {
  manager: SessionManager;
  csv: Pick<CsvWriter, "append">;
  summaries: SummaryStore;
  scheduler: Scheduler;
  dataDir: string;
  dashboardPath: string;
  port?: number;
  /** API-Token. Ohne Angabe: TB_TOKEN oder ein zufälliges Token pro Start. */
  token?: string;
  /** Einstellungen (Standardwerte/Grenzen). Ohne Angabe: nur im Speicher, mit Standardwerten. */
  settings?: SettingsStore;
  /** Zuletzt verwendete URLs. Ohne Angabe: nur im Speicher. */
  recent?: RecentUrls;
}

export interface RunningServer {
  server: http.Server;
  token: string;
  /** Löst mit dem tatsächlich gebundenen Port auf (wichtig bei port = 0). */
  listening: Promise<number>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const MANAGER_STATUS: Record<string, number> = {
  no_browser: 503,
  shutting_down: 503,
  limit: 429,
  exists: 409,
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);

    if (declared > limit) {
      reject(new HttpError(413, "Request zu groß."));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;

    req.on("data", (chunk: Buffer) => {
      if (failed) return;

      size += chunk.length;

      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, "Request zu groß."));
        return;
      }

      chunks.push(chunk);
    });

    // Buffer.concat statt String-Konkatenation: Mehrbyte-Zeichen bleiben heil.
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const text = await readBody(req, LIMITS.maxBodyBytes);

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Ungültiges JSON.");
  }
}

function pathId(segment: string | undefined): string {
  let id = "";

  try {
    id = decodeURIComponent(segment ?? "");
  } catch {
    throw new HttpError(400, "Ungültiger Pfad.");
  }

  if (!ID_RE.test(id)) throw new HttpError(400, "Ungültige ID.");

  return id;
}

function tokenMatches(provided: string | undefined, token: string): boolean {
  if (!provided) return false;

  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(token).digest();

  return crypto.timingSafeEqual(a, b);
}

function resolveToken(explicit?: string): string {
  const candidate = explicit ?? process.env.TB_TOKEN;

  if (candidate && candidate.length >= 16) return candidate;

  if (candidate) {
    log.warn("TB_TOKEN ist kürzer als 16 Zeichen und wird ignoriert.");
  }

  return crypto.randomBytes(24).toString("hex");
}

export function startServer(deps: ServerDeps): RunningServer {
  const { manager, csv, summaries, scheduler, dataDir, dashboardPath } = deps;

  const settings = deps.settings ?? new SettingsStore();
  const recent = deps.recent ?? new RecentUrls();

  const settingsPayload = () => ({
    ok: true,
    settings: settings.get(),
    defaults: settings.getDefaults(),
    bounds: SETTING_BOUNDS,
  });

  const token = resolveToken(deps.token);
  let port = deps.port ?? Number(process.env.PORT ?? 7777);

  let dashboardTemplate: string | null = null;

  try {
    dashboardTemplate = fs.readFileSync(dashboardPath, "utf-8");
  } catch (e) {
    log.error(`Dashboard-Datei nicht lesbar: ${dashboardPath}`, e);
  }

  const hostAllowed = (host: string | undefined): boolean => {
    const h = (host ?? "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };

  const originAllowed = (origin: string | undefined): boolean => {
    // Kein Origin = kein Browser-Kontext (curl, Skripte, gleiche Origin bei GET).
    if (origin === undefined) return true;

    return (
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://localhost:${port}`
    );
  };

  const tokenFrom = (req: http.IncomingMessage, url: URL): string | undefined => {
    const header = req.headers["x-tb-token"];

    if (typeof header === "string") return header;

    return url.searchParams.get("token") ?? undefined;
  };

  const dashboardHtml = (res: http.ServerResponse): void => {
    if (!dashboardTemplate) {
      throw new HttpError(500, "Dashboard-Datei fehlt.");
    }

    const nonce = crypto.randomBytes(16).toString("base64");

    const html = dashboardTemplate
      .replaceAll("{{NONCE}}", nonce)
      .replaceAll("{{TOKEN}}", token);

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; ")
    );
    res.end(html);
  };

  const streamFile = (
    res: http.ServerResponse,
    file: string,
    filename: string
  ): void => {
    if (!fs.existsSync(file)) {
      throw new HttpError(404, "Keine Daten vorhanden.");
    }

    res.statusCode = 200;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");

    pipeline(fs.createReadStream(file), res, (err) => {
      if (err) log.debug("CSV-Download abgebrochen", err);
    });
  };

  const summariesCsv = (): string => {
    const header = [
      "sessionId",
      "runtimeSec",
      "avgBandwidthMBps",
      "peakBandwidthMBps",
      "p95BandwidthMBps",
      "stalls",
      "stallSeconds",
      "rebufferRatio",
      "startupMs",
      "dominantQuality",
      "droppedFrameRatio",
      "endReason",
      "note",
      "finishedAt",
      "interactions",
      "interactionsOk",
      "interactionsFailed",
      "interactionsSkipped",
      "avgRecoveryMs",
      "maxRecoveryMs",
    ];

    const lines = [header.join(",")];

    for (const r of summaries.all()) {
      const ia = r.interactions ?? [];
      const ok = ia.filter((x) => x.status === "ok");
      const rec = ok.map((x) => x.recoveryMs);

      lines.push(
        [
          csvEscape(r.sessionId),
          r.runtimeSec,
          r.avgBandwidthMBps,
          r.peakBandwidthMBps,
          r.p95BandwidthMBps,
          r.stalls,
          r.stallSeconds,
          r.rebufferRatio,
          r.startupMs,
          csvEscape(r.dominantQuality),
          r.droppedFrameRatio,
          csvEscape(r.endReason),
          csvEscape(r.note),
          new Date(r.finishedAt).toISOString(),
          ia.length,
          ok.length,
          ia.filter((x) => x.status === "failed").length,
          ia.filter((x) => x.status === "skipped").length,
          rec.length ? Math.round(rec.reduce((a, b) => a + b, 0) / rec.length) : "",
          rec.length ? Math.max(...rec) : "",
        ].join(",")
      );
    }

    return lines.join("\n") + "\n";
  };

  /** Eine Zeile je Skriptschritt: wie lange die Wiedergabe danach zur Erholung brauchte. */
  const interactionsCsv = (): string => {
    const lines = [
      [
        "sessionId",
        "loop",
        "plannedAtSec",
        "startedAtSec",
        "action",
        "value",
        "status",
        "recoveryMs",
        "note",
      ].join(","),
    ];

    for (const r of summaries.all()) {
      for (const x of r.interactions ?? []) {
        lines.push(
          [
            csvEscape(r.sessionId),
            x.loop,
            x.at,
            x.startedAtSec,
            csvEscape(x.action),
            x.value ?? "",
            csvEscape(x.status),
            x.recoveryMs,
            csvEscape(x.note ?? ""),
          ].join(",")
        );
      }
    }

    return lines.join("\n") + "\n";
  };

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";

    // 1) DNS-Rebinding: nur die eigene Loopback-Adresse ist als Host erlaubt.
    if (!hostAllowed(req.headers.host)) {
      throw new HttpError(403, "Ungültiger Host.");
    }

    // 2) CSRF: Browser senden bei Cross-Site-Requests einen fremden Origin.
    if (!originAllowed(req.headers.origin)) {
      throw new HttpError(403, "Ungültiger Origin.");
    }

    let url: URL;

    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      throw new HttpError(400, "Ungültige URL.");
    }

    const p = url.pathname;

    if (method === "OPTIONS") {
      // Bewusst ohne CORS-Header: Cross-Origin-Zugriffe sind nicht vorgesehen.
      res.statusCode = 204;
      res.setHeader("Allow", "GET,POST,PUT,PATCH,DELETE");
      res.end();
      return;
    }

    if (p === "/" && method === "GET") {
      dashboardHtml(res);
      return;
    }

    if (p === "/favicon.ico" && method === "GET") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (p === "/api/health" && method === "GET") {
      sendJson(res, 200, { ok: true, ts: Date.now() });
      return;
    }

    // 3) Alles Weitere erfordert das Token.
    if (!tokenMatches(tokenFrom(req, url), token)) {
      throw new HttpError(401, "Token fehlt oder ist falsch.");
    }

    const seg = p.split("/").filter(Boolean);

    if (p === "/api/sessions" && method === "GET") {
      sendJson(res, 200, {
        ids: manager.list(),
        active: manager.activeCount(),
        max: manager.maxSessions,
        ready: manager.isReady(),
      });
      return;
    }

    if (p === "/api/sessions" && method === "POST") {
      const input = parseSessionInput(
        await readJson(req),
        sessionDefaultsFrom(settings.get())
      );
      const id = crypto.randomUUID();

      // Zuerst merken, dann starten: Die URL bleibt auch erhalten, wenn der Start
      // an einem Limit oder am Browser scheitert ("einmal eingegeben = gespeichert").
      recent.add(input.url);

      manager.start({ ...input, id });

      sendJson(res, 200, { ok: true, id, kind: input.kind });
      return;
    }

    if (seg[0] === "api" && seg[1] === "sessions" && seg.length === 3 && method === "DELETE") {
      const ok = manager.stop(pathId(seg[2]));

      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }

    if (p === "/api/settings" && method === "GET") {
      sendJson(res, 200, settingsPayload());
      return;
    }

    if (p === "/api/settings" && method === "PUT") {
      settings.update(await readJson(req));
      sendJson(res, 200, settingsPayload());
      return;
    }

    if (p === "/api/settings/reset" && method === "POST") {
      settings.reset();
      sendJson(res, 200, settingsPayload());
      return;
    }

    if (p === "/api/recent-urls" && method === "GET") {
      sendJson(res, 200, { ok: true, urls: recent.all() });
      return;
    }

    if (p === "/api/recent-urls" && method === "POST") {
      const body = (await readJson(req)) as { url?: unknown } | null;

      recent.add(body?.url);
      sendJson(res, 200, { ok: true, urls: recent.all() });
      return;
    }

    if (p === "/api/recent-urls" && method === "DELETE") {
      const removed = recent.remove(url.searchParams.get("url") ?? undefined);

      sendJson(res, removed ? 200 : 404, { ok: removed, urls: recent.all() });
      return;
    }

    if (p === "/api/summaries" && method === "GET") {
      sendJson(res, 200, { summaries: summaries.all() });
      return;
    }

    if (p === "/api/schedules" && method === "GET") {
      sendJson(res, 200, { schedules: scheduler.list() });
      return;
    }

    if (p === "/api/schedules" && method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown> | null;

      if (!body || typeof body !== "object") {
        throw new ValidationError("Ungültiger Request-Body.");
      }

      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new ValidationError('"enabled" muss true oder false sein.');
      }

      const session = parseSessionInput(
        body.session,
        sessionDefaultsFrom(settings.get())
      );

      recent.add(session.url);

      const schedule = scheduler.add({
        cron: body.cron as string,
        enabled: body.enabled as boolean | undefined,
        session,
      });

      sendJson(res, 200, { ok: true, schedule });
      return;
    }

    if (seg[0] === "api" && seg[1] === "schedules" && seg.length === 3) {
      const id = pathId(seg[2]);

      if (method === "PATCH") {
        const body = (await readJson(req)) as { enabled?: unknown } | null;

        if (!body || typeof body.enabled !== "boolean") {
          throw new ValidationError('"enabled" (true/false) fehlt.');
        }

        const schedule = scheduler.setEnabled(id, body.enabled);

        sendJson(res, schedule ? 200 : 404, { ok: !!schedule, schedule });
        return;
      }

      if (method === "DELETE") {
        const ok = scheduler.remove(id);

        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }
    }

    if (p === "/export/samples.csv" && method === "GET") {
      streamFile(res, path.join(dataDir, "samples.csv"), "tubeload-samples.csv");
      return;
    }

    if (p === "/export/summaries.csv" && method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Disposition", 'attachment; filename="tubeload-summaries.csv"');
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.end(summariesCsv());
      return;
    }

    if (p === "/export/interactions.csv" && method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Disposition", 'attachment; filename="tubeload-interactions.csv"');
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.end(interactionsCsv());
      return;
    }

    throw new HttpError(404, "Nicht gefunden.");
  }

  const server = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader("Connection", "close");
        sendJson(res, e.status, { ok: false, error: e.message });
        return;
      }

      if (e instanceof ValidationError) {
        sendJson(res, 400, { ok: false, error: e.message });
        return;
      }

      if (e instanceof ManagerError) {
        sendJson(res, MANAGER_STATUS[e.code] ?? 500, { ok: false, error: e.message });
        return;
      }

      log.error(`Unerwarteter Fehler bei ${req.method} ${req.url}`, e);
      sendJson(res, 500, { ok: false, error: "Interner Fehler." });
    });
  });

  server.requestTimeout = 30_000;

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  // --- WebSocket -------------------------------------------------------------

  type Client = WebSocket & { isAlive?: boolean };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname !== "/ws") return reject("404 Not Found");
      if (!hostAllowed(req.headers.host)) return reject("403 Forbidden");
      if (!originAllowed(req.headers.origin)) return reject("403 Forbidden");
      if (!tokenMatches(tokenFrom(req, url), token)) return reject("401 Unauthorized");

      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      reject("400 Bad Request");
    }
  });

  wss.on("connection", (ws: Client) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", () => {});
    ws.on("message", () => {});
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<Client>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }

      client.isAlive = false;
      client.ping();
    }
  }, 30_000);

  heartbeat.unref?.();

  const broadcast = (type: string, data: unknown) => {
    const msg = JSON.stringify({ type, data });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  };

  manager.on("sample", (sample: Sample) => {
    csv.append(sample);
    summaries.add(sample);
    broadcast("sample", sample);
  });

  manager.on("interaction", (sessionId: string, result: InteractionResult) => {
    summaries.addInteraction(sessionId, result);
    broadcast("interaction", { sessionId, ...result });
  });

  manager.on("started", (sessionId: string) => {
    broadcast("status", { sessionId, state: "starting" });
  });

  manager.on("session-error", (sessionId: string, message: string) => {
    broadcast("error", { sessionId, message });
  });

  manager.on("stopped", (sessionId: string, reason: EndReason) => {
    const summary: SessionSummary | null = summaries.finish(sessionId, reason);

    if (summary) {
      broadcast("summary", summary);
    }

    broadcast("status", { sessionId, state: "stopped" });
  });

  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject);

    server.listen(port, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      server.off("error", reject);
      log.info(`TubeLoad QA Dashboard: http://127.0.0.1:${port}`);
      resolve(port);
    });
  });

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);

    for (const client of wss.clients) client.terminate();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  };

  return { server, token, listening, close };
}
