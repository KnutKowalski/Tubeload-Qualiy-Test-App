import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseExpression } from "cron-parser";

import type { SessionManager } from "./manager";
import type { Schedule, SessionConfig } from "./types";

function nextCronRun(cron: string, from = new Date()): Date {
  const interval = parseExpression(cron, { currentDate: from });
  return interval.next().toDate();
}

export interface NewSchedule {
  cron: string;
  enabled?: boolean;
  session: Omit<SessionConfig, "id">;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private schedules: Schedule[] = [];

  constructor(
    private manager: SessionManager,
    private file = "data/schedules.json"
  ) {
    this.load();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 30_000);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  list(): Schedule[] {
    return this.schedules;
  }

  add(input: NewSchedule): Schedule {
    nextCronRun(input.cron);

    const schedule: Schedule = {
      id: crypto.randomUUID(),
      cron: input.cron,
      enabled: input.enabled ?? true,
      session: input.session,
      createdAt: Date.now(),
      nextRun: nextCronRun(input.cron).getTime(),
    };

    this.schedules.push(schedule);
    this.save();

    return schedule;
  }

  remove(id: string): boolean {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter((s) => s.id !== id);
    this.save();
    return this.schedules.length !== before;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        this.schedules = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      }
    } catch {
      this.schedules = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.schedules, null, 2));
  }

  private tick(): void {
    const now = Date.now();
    let changed = false;

    for (const s of this.schedules) {
      if (!s.enabled) continue;

      if (!s.nextRun) {
        s.nextRun = nextCronRun(s.cron).getTime();
        changed = true;
      }

      if (now >= s.nextRun) {
        const id = `${s.id}-${now}`;

        try {
          this.manager.start({
            ...s.session,
            id,
          });
        } catch {}

        s.lastRun = now;
        s.nextRun = nextCronRun(s.cron).getTime();
        changed = true;
      }
    }

    if (changed) this.save();
  }
}
