import type { Sample, SessionSummary } from "./types";

class SessionAggregator {
  private firstTs = 0;
  private lastTs = 0;

  private count = 0;
  private sumBw = 0;
  private peakBw = 0;
  private bwValues: number[] = [];

  private lastStalls = 0;
  private stalls = 0;
  private stallSeconds = 0;

  private qualityTime = new Map<string, number>();

  private dropped = 0;
  private total = 0;

  add(s: Sample): void {
    if (!this.firstTs) this.firstTs = s.ts;

    const dt = this.lastTs ? Math.max(0, (s.ts - this.lastTs) / 1000) : 0;
    this.lastTs = s.ts;

    this.count++;
    this.sumBw += s.bandwidthMBps;
    this.peakBw = Math.max(this.peakBw, s.bandwidthMBps);
    this.bwValues.push(s.bandwidthMBps);

    if (s.stalls > this.lastStalls) {
      const diff = s.stalls - this.lastStalls;
      this.stalls += diff;
      this.stallSeconds += dt * Math.min(1, diff);
    }

    this.lastStalls = s.stalls;

    const q = s.quality || "unknown";
    this.qualityTime.set(q, (this.qualityTime.get(q) ?? 0) + dt);

    this.dropped = Math.max(this.dropped, s.droppedFrames);
    this.total = Math.max(this.total, s.totalFrames);
  }

  summary(sessionId: string): SessionSummary {
    const avg = this.count ? this.sumBw / this.count : 0;

    const sorted = [...this.bwValues].sort((a, b) => a - b);
    const p95 =
      sorted.length > 0
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

    return {
      sessionId,
      runtimeSec:
        this.lastTs && this.firstTs
          ? (this.lastTs - this.firstTs) / 1000
          : 0,
      avgBandwidthMBps: avg,
      peakBandwidthMBps: this.peakBw,
      p95BandwidthMBps: p95,
      stalls: this.stalls,
      stallSeconds: this.stallSeconds,
      dominantQuality,
      droppedFrameRatio: this.total ? this.dropped / this.total : 0,
      finishedAt: Date.now(),
    };
  }
}

export class SummaryStore {
  private active = new Map<string, SessionAggregator>();
  private finished = new Map<string, SessionSummary>();

  add(s: Sample): void {
    let agg = this.active.get(s.sessionId);

    if (!agg) {
      agg = new SessionAggregator();
      this.active.set(s.sessionId, agg);
    }

    agg.add(s);
  }

  finish(sessionId: string): SessionSummary | null {
    const agg = this.active.get(sessionId);

    if (!agg) {
      return this.finished.get(sessionId) ?? null;
    }

    const summary = agg.summary(sessionId);
    this.active.delete(sessionId);
    this.finished.set(sessionId, summary);

    return summary;
  }

  all(): SessionSummary[] {
    return [...this.finished.values()].sort(
      (a, b) => b.finishedAt - a.finishedAt
    );
  }
}
