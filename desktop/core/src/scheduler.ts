import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CronExpressionParser } from "cron-parser";

import { LIMITS } from "./limits";
import { log } from "./log";
import type { SessionManager } from "./manager";
import type { Schedule, SessionInput } from "./types";
import { errorMessage } from "./util";
import { parseSessionInput, ValidationError } from "./validate";

function nextCronRun(cron: string, from: Date = new Date()): Date {
  return CronExpressionParser.parse(cron, { currentDate: from }).next().toDate();
}

/**
 * Prüft den Cron-Ausdruck und verlangt einen Mindestabstand zwischen den
 * Läufen (Schutz vor Ausdrücken wie "* * * * *" oder Sekunden-Crons).
 */
export function validateCron(cron: unknown): string {
  if (typeof cron !== "string" || !cron.trim() || cron.length > 100) {
    throw new ValidationError('"cron" fehlt oder ist ungültig.');
  }

  const expr = cron.trim();

  try {
    const it = CronExpressionParser.parse(expr);
    let prev = it.next().toDate().getTime();
    let minGap = Infinity;

    for (let i = 0; i < 12; i++) {
      const next = it.next().toDate().getTime();
      minGap = Math.min(minGap, next - prev);
      prev = next;
    }

    if (minGap < LIMITS.minScheduleIntervalSec * 1000) {
      throw new ValidationError(
        `Cron-Läufe müssen mindestens ${LIMITS.minScheduleIntervalSec / 60} Minuten auseinander liegen.`
      );
    }
  } catch (e) {
    if (e instanceof ValidationError) throw e;

    throw new ValidationError(`Ungültiger Cron-Ausdruck: ${errorMessage(e)}`);
  }

  return expr;
}

export interface NewSchedule {
  cron: string;
  enabled?: boolean;
  session: SessionInput;
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
    if (this.timer) return;

    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 2_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): Schedule[] {
    return this.schedules.map((s) => ({ ...s }));
  }

  add(input: NewSchedule): Schedule {
    if (this.schedules.length >= LIMITS.maxSchedules) {
      throw new ValidationError(`Maximal ${LIMITS.maxSchedules} Zeitpläne erlaubt.`);
    }

    const cron = validateCron(input.cron);

    const schedule: Schedule = {
      id: crypto.randomUUID(),
      cron,
      enabled: input.enabled ?? true,
      session: input.session,
      createdAt: Date.now(),
      nextRun: nextCronRun(cron).getTime(),
    };

    this.schedules.push(schedule);
    this.save();

    return { ...schedule };
  }

  setEnabled(id: string, enabled: boolean): Schedule | null {
    const s = this.schedules.find((x) => x.id === id);

    if (!s) return null;

    s.enabled = enabled;

    if (enabled) {
      s.nextRun = nextCronRun(s.cron).getTime();
      s.lastError = undefined;
    }

    this.save();

    return { ...s };
  }

  remove(id: string): boolean {
    const before = this.schedules.length;

    this.schedules = this.schedules.filter((s) => s.id !== id);

    if (this.schedules.length === before) return false;

    this.save();

    return true;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;

      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"));

      if (!Array.isArray(raw)) return;

      for (const item of raw.slice(0, LIMITS.maxSchedules)) {
        try {
          const o = item as Partial<Schedule>;

          if (typeof o.id !== "string") throw new Error("id fehlt");

          this.schedules.push({
            id: o.id,
            cron: validateCron(o.cron),
            enabled: o.enabled !== false,
            // Alte Dateien (mit humanize usw.) werden hier normalisiert.
            session: parseSessionInput(o.session),
            createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
            lastRun: typeof o.lastRun === "number" ? o.lastRun : undefined,
            nextRun: typeof o.nextRun === "number" ? o.nextRun : undefined,
            lastError: typeof o.lastError === "string" ? o.lastError : undefined,
            lastSessionId:
              typeof o.lastSessionId === "string" ? o.lastSessionId : undefined,
          });
        } catch (e) {
          log.warn(`Zeitplan in ${this.file} übersprungen: ${errorMessage(e)}`);
        }
      }
    } catch (e) {
      log.warn(`${this.file} konnte nicht gelesen werden`, e);
      this.schedules = [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });

      const tmp = `${this.file}.tmp`;

      fs.writeFileSync(tmp, JSON.stringify(this.schedules, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log.error("Zeitpläne konnten nicht gespeichert werden", e);
    }
  }

  private tick(): void {
    // Solange kein Browser da ist, werden Läufe weder gestartet noch verbraucht.
    if (!this.manager.isReady()) return;

    const now = Date.now();
    let changed = false;

    for (const s of this.schedules) {
      if (!s.enabled) continue;

      try {
        if (!s.nextRun) {
          s.nextRun = nextCronRun(s.cron).getTime();
          changed = true;
        }

        if (now < s.nextRun) continue;

        const lateMs = now - s.nextRun;

        s.nextRun = nextCronRun(s.cron).getTime();
        changed = true;

        if (lateMs > LIMITS.missedRunGraceMs) {
          s.lastError = "Lauf verpasst (App war zum geplanten Zeitpunkt nicht aktiv).";
          continue;
        }

        if (s.lastSessionId && this.manager.has(s.lastSessionId)) {
          s.lastError = "Übersprungen: der vorherige Lauf ist noch aktiv.";
          continue;
        }

        const id = `${s.id}-${now}`;

        this.manager.start({ ...s.session, id });

        s.lastRun = now;
        s.lastSessionId = id;
        s.lastError = undefined;
      } catch (e) {
        s.lastRun = now;
        s.lastError = errorMessage(e);
        log.warn(`Zeitplan ${s.id}: Start fehlgeschlagen: ${s.lastError}`);
        changed = true;
      }
    }

    if (changed) this.save();
  }
}
