import { EventEmitter } from "node:events";
import type { Browser } from "playwright-core";

import { SessionRunner } from "./session";
import type { Sample, SessionConfig } from "./types";

export class SessionManager extends EventEmitter {
  private runners = new Map<string, SessionRunner>();

  constructor(private browser: Browser) {
    super();
  }

  start(cfg: SessionConfig): string {
    if (this.runners.has(cfg.id)) {
      throw new Error(`Session ${cfg.id} existiert bereits.`);
    }

    const runner = new SessionRunner(cfg, this.browser, (s: Sample) => {
      this.emit("sample", s);
    });

    this.runners.set(cfg.id, runner);
    this.emit("started", cfg.id);

    runner
      .run()
      .catch((err: unknown) => {
        this.emit(
          "error",
          cfg.id,
          err instanceof Error ? err.message : String(err)
        );
      })
      .finally(() => {
        this.runners.delete(cfg.id);
        this.emit("stopped", cfg.id);
      });

    return cfg.id;
  }

  stop(id: string): void {
    this.runners.get(id)?.stop();
  }

  list(): string[] {
    return [...this.runners.keys()];
  }
}
