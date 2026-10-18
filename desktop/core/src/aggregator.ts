import fs from "node:fs";
import path from "node:path";
import type { EndReason, Sample, SessionSummary } from "./types";
import { log } from "./log";

const RESERVOIR_SIZE = 10_000;

/**
 * Summiert einen kumulativen Zähler robust gegenüber Zurücksetzen
 * (jede neue Seite startet ihre Zähler bei 0).
 */
class ResettableCounter {
  private last = 0;
  total = 0;

  add(value: number): void {
    this.total += value >= this.last ? value - this.last : value;
    this.last = value;
  }
}

const ACTIVE_STATES = new Set(["playing", "buffering"]);

class SessionAggregator {
  private firstTs = 0;
  private lastTs = 0;

  private bwSamples = 0;
  private sumBw = 0;
  private peakBw = 0;
  private reservoir: number[] = [];
  private seen = 0;

  private stalls = new ResettableCounter();
  private stallMs = new ResettableCounter();
  private dropped = new ResettableCounter();
  private frames = new ResettableCounter();

  private playSec = 0;
  private startupMs = -1;

  private qualityTime = new Map<string, number>();
  private note = "";

  add(s: Sample): void {
    if (!this.firstTs) this.firstTs = s.ts;

    const dt = this.lastTs ? Math.max(0, (s.ts - this.lastTs) / 1000) : 0;
    this.lastTs = s.ts;

    if (s.note) this.note = s.note;

    // Diagnose-Samples (error/blocked/…) enthalten keine Messwerte.
    if (!ACTIVE_STATES.has(s.state) && s.state !== "paused" && s.state !== "ended") {
      return;
    }

    this.stalls.add(s.stalls);
    this.stallMs.add(Math.round(s.stallSec * 1000));
    this.dropped.add(s.droppedFrames);
    this.frames.add(s.totalFrames);

    if (this.startupMs < 0 && s.startupMs > 0) this.startupMs = s.startupMs;

    if (s.state === "playing") this.playSec += dt;

    if (ACTIVE_STATES.has(s.state)) {
      this.bwSamples++;
      this.sumBw += s.bandwidthMBps;
      this.peakBw = Math.max(this.peakBw, s.bandwidthMBps);
      this.pushReservoir(s.bandwidthMBps);

      const q = s.quality || "unknown";
      this.qualityTime.set(q, (this.qualityTime.get(q) ?? 0) + dt);
    }
  }

  // Reservoir-Sampling: begrenzter Speicher auch bei tagelangen Sessions.
  private pushReservoir(v: number): void {
    this.seen++;

    if (this.reservoir.length < RESERVOIR_SIZE) {
      this.reservoir.push(v);
      return;
    }

    const j = Math.floor(Math.random() * this.seen);

    if (j < RESERVOIR_SIZE) this.reservoir[j] = v;
  }

  summary(sessionId: string, endReason: EndReason): SessionSummary {
    const avg = this.bwSamples ? this.sumBw / this.bwSamples : 0;

    const sorted = [...this.reservoir].sort((a, b) => a - b);
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
      : 0;

    let dominantQuality = "unknown";
    let maxQTime = 0;

    for (const [q, t] of this.qualityTime) {
      if (t > maxQTime) {
        maxQTime = t;
        dominantQuality = q;
      }
    }

    const stallSeconds = this.stallMs.total / 1000;
    const denom = this.playSec + stallSeconds;

    return {
      sessionId,
      runtimeSec:
        this.lastTs && this.firstTs ? (this.lastTs - this.firstTs) / 1000 : 0,
      avgBandwidthMBps: avg,
      peakBandwidthMBps: this.peakBw,
      p95BandwidthMBps: p95,
      stalls: this.stalls.total,
      stallSeconds,
      rebufferRatio: denom > 0 ? stallSeconds / denom : 0,
      startupMs: this.startupMs,
      dominantQuality,
      droppedFrameRatio: this.frames.total
        ? this.dropped.total / this.frames.total
        : 0,
      endReason,
      note: this.note,
      finishedAt: Date.now(),
    };
  }
}

export class SummaryStore {
  private active = new Map<string, SessionAggregator>();
  private finished = new Map<string, SessionSummary>();

  /** file: optional, damit Zusammenfassungen einen Neustart überleben. */
  constructor(
    private readonly file?: string,
    private readonly maxFinished = 500
  ) {
    this.load();
  }

  add(s: Sample): void {
    let agg = this.active.get(s.sessionId);

    if (!agg) {
      agg = new SessionAggregator();
      this.active.set(s.sessionId, agg);
    }

    agg.add(s);
  }

  finish(sessionId: string, endReason: EndReason = "stopped"): SessionSummary | null {
    const agg = this.active.get(sessionId);

    if (!agg) {
      return this.finished.get(sessionId) ?? null;
    }

    const summary = agg.summary(sessionId, endReason);

    this.active.delete(sessionId);
    this.finished.set(sessionId, summary);

    while (this.finished.size > this.maxFinished) {
      const oldest = this.finished.keys().next().value;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
    }

    this.save();

    return summary;
  }

  all(): SessionSummary[] {
    return [...this.finished.values()].sort(
      (a, b) => b.finishedAt - a.finishedAt
    );
  }

  private load(): void {
    if (!this.file) return;

    try {
      if (!fs.existsSync(this.file)) return;

      const data: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"));

      if (!Array.isArray(data)) return;

      for (const item of data.slice(-this.maxFinished)) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as SessionSummary).sessionId === "string"
        ) {
          const s = item as SessionSummary;
          this.finished.set(s.sessionId, s);
        }
      }
    } catch (e) {
      log.warn("summaries.json konnte nicht gelesen werden", e);
    }
  }

  private save(): void {
    if (!this.file) return;

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });

      const tmp = `${this.file}.tmp`;
      const ordered = [...this.finished.values()].sort(
        (a, b) => a.finishedAt - b.finishedAt
      );

      fs.writeFileSync(tmp, JSON.stringify(ordered));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log.warn("summaries.json konnte nicht gespeichert werden", e);
    }
  }
}
