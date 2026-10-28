import { EventEmitter } from "node:events";
import type { Browser } from "playwright-core";

import { configuredMaxSessions } from "./limits";
import { log } from "./log";
import type { ProcessMonitor } from "./processMonitor";
import { SessionRunner } from "./session";
import { shortError, sleep } from "./util";
import type { EndReason, InteractionResult, Sample, SessionConfig } from "./types";

export type ManagerErrorCode =
  | "no_browser"
  | "limit"
  | "exists"
  | "shutting_down";

export class ManagerError extends Error {
  constructor(
    readonly code: ManagerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ManagerError";
  }
}

/**
 * Events:
 *  - "sample"        (sample: Sample)
 *  - "interaction"   (sessionId: string, result: InteractionResult)
 *  - "started"       (sessionId: string)
 *  - "stopped"       (sessionId: string, reason: EndReason)
 *  - "session-error" (sessionId: string, message: string)
 *
 * (Bewusst kein Event namens "error": Node wirft bei "error" ohne Listener.)
 */
export class SessionManager extends EventEmitter {
  private runners = new Map<string, SessionRunner>();
  private browser: Browser | null = null;
  private closing = false;

  private readonly maxSessionsSource: () => number;

  /**
   * maxSessions: feste Zahl oder Funktion, die bei jedem Start den aktuellen Wert
   * liefert (so wirken geänderte Einstellungen sofort für neue Sessions).
   */
  constructor(
    private readonly monitor: ProcessMonitor,
    maxSessions: number | (() => number) = configuredMaxSessions()
  ) {
    super();
    this.maxSessionsSource =
      typeof maxSessions === "function" ? maxSessions : () => maxSessions;
  }

  /** Höchstzahl gleichzeitiger Sessions; 0 = unbegrenzt. */
  get maxSessions(): number {
    return this.maxSessionsSource();
  }

  /** Wird vom Core aufgerufen, sobald der Browser bereit ist (oder null bei Verlust). */
  setBrowser(browser: Browser | null): void {
    this.browser = browser;
  }

  isReady(): boolean {
    return this.browser !== null && !this.closing;
  }

  has(id: string): boolean {
    return this.runners.has(id);
  }

  activeCount(): number {
    return this.runners.size;
  }

  start(cfg: SessionConfig): string {
    if (this.closing) {
      throw new ManagerError("shutting_down", "Die App wird gerade beendet.");
    }

    const browser = this.browser;

    if (!browser) {
      throw new ManagerError(
        "no_browser",
        "Browser nicht verfügbar – Core konnte Chrome/Chromium nicht starten. Details stehen im core.log."
      );
    }

    if (this.runners.has(cfg.id)) {
      throw new ManagerError("exists", `Session ${cfg.id} existiert bereits.`);
    }

    const max = this.maxSessions;

    if (max > 0 && this.runners.size >= max) {
      throw new ManagerError(
        "limit",
        `Maximal ${max} gleichzeitige Sessions erlaubt (änderbar unter „Einstellungen“).`
      );
    }

    const runner = new SessionRunner(
      cfg,
      browser,
      this.monitor,
      (s: Sample) => {
        this.emit("sample", s);
      },
      (r: InteractionResult) => {
        this.emit("interaction", cfg.id, r);
      }
    );

    this.runners.set(cfg.id, runner);
    this.emit("started", cfg.id);

    runner
      .run()
      .catch((err: unknown) => {
        const message = shortError(err);
        log.warn(`Session ${cfg.id} fehlgeschlagen: ${message}`);
        this.emit("session-error", cfg.id, message);
      })
      .finally(() => {
        this.runners.delete(cfg.id);
        this.emit("stopped", cfg.id, runner.endReason);
      });

    return cfg.id;
  }

  stop(id: string, reason: EndReason = "stopped"): boolean {
    const runner = this.runners.get(id);

    if (!runner) return false;

    runner.stop(reason);

    return true;
  }

  list(): string[] {
    return [...this.runners.keys()];
  }

  /** Stoppt alle Sessions und wartet (begrenzt), bis ihre Zusammenfassungen fertig sind. */
  async stopAll(timeoutMs = 15_000): Promise<void> {
    this.closing = true;

    for (const runner of this.runners.values()) {
      runner.stop("shutdown");
    }

    const deadline = Date.now() + timeoutMs;

    while (this.runners.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  }
}
