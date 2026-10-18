import pidusage from "pidusage";
import type { Browser } from "playwright-core";
import { log } from "./log";

export interface ProcessSnapshot {
  /** Summe über alle Browser-Prozesse (Hauptprozess, Renderer, GPU, Utility). */
  cpu: number;
  memBytes: number;
}

const ZERO: ProcessSnapshot = { cpu: 0, memBytes: 0 };

/**
 * Misst CPU/RAM des gesamten Browsers einmal pro Sekunde für alle Sessions
 * gemeinsam. (Früher wurde nur der Hauptprozess erfasst – die Decoder- und
 * Renderer-Prozesse, in denen die Last entsteht, fehlten.)
 */
export class ProcessMonitor {
  private cached: ProcessSnapshot & { ts: number } = { ...ZERO, ts: 0 };
  private inflight: Promise<ProcessSnapshot> | null = null;
  private pids: number[] = [];
  private pidsTs = 0;

  constructor(private readonly getBrowser: () => Browser | null) {}

  snapshot(): Promise<ProcessSnapshot> {
    if (Date.now() - this.cached.ts < 900) {
      return Promise.resolve(this.cached);
    }

    if (!this.inflight) {
      this.inflight = this.measure().finally(() => {
        this.inflight = null;
      });
    }

    return this.inflight;
  }

  private async browserPids(browser: Browser): Promise<number[]> {
    if (Date.now() - this.pidsTs < 5000 && this.pids.length) {
      return this.pids;
    }

    let cdp: Awaited<ReturnType<Browser["newBrowserCDPSession"]>> | null = null;

    try {
      cdp = await browser.newBrowserCDPSession();

      const info = (await cdp.send("SystemInfo.getProcessInfo" as never)) as {
        processInfo?: { id: number }[];
      };

      this.pids = (info.processInfo ?? [])
        .map((p) => p.id)
        .filter((id) => Number.isInteger(id) && id > 0);
      this.pidsTs = Date.now();
    } catch (e) {
      log.debug("Prozessliste nicht verfügbar", e);
    } finally {
      await cdp?.detach().catch(() => {});
    }

    return this.pids;
  }

  private async measure(): Promise<ProcessSnapshot> {
    const browser = this.getBrowser();

    if (!browser) {
      this.cached = { ...ZERO, ts: Date.now() };
      return this.cached;
    }

    const pids = await this.browserPids(browser);

    const results = await Promise.allSettled(pids.map((pid) => pidusage(pid)));

    let cpu = 0;
    let mem = 0;

    for (const r of results) {
      if (r.status === "fulfilled") {
        cpu += r.value.cpu ?? 0;
        mem += r.value.memory ?? 0;
      }
    }

    this.cached = { cpu, memBytes: mem, ts: Date.now() };

    return this.cached;
  }

  dispose(): void {
    pidusage.clear();
  }
}
