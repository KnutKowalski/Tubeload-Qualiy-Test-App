import type { Browser, CDPSession, Page } from "playwright-core";
import pidusage from "pidusage";

import { NetworkCounter } from "./netCounter";
import { qaPageScript } from "./qaPageScript";
import { HumanBehavior } from "./human";
import { acceptConsent } from "./consent";
import { resolveChannelVideos } from "./channelResolver";
import { detectUrlKind, extractPlaylistId, toWatchPlaylistUrl } from "./url";
import { qualityToCode, sleep } from "./util";
import type { Sample, SessionConfig, UrlKind } from "./types";

export class SessionRunner {
  private abort = new AbortController();
  private cdp?: CDPSession;
  private net = new NetworkCounter();
  private page?: Page;

  private lastTaskDuration = 0;
  private lastPerfTs = Date.now();

  private currentUrl: string;
  private kind: UrlKind;
  private queue: string[] = [];
  private queueIndex = 0;

  constructor(
    private cfg: SessionConfig,
    private browser: Browser,
    private onSample: (s: Sample) => void
  ) {
    this.kind = detectUrlKind(cfg.url, cfg.kind ?? "auto");
    this.currentUrl = cfg.url;
  }

  stop(): void {
    this.abort.abort();
  }

  async run(): Promise<void> {
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();
    this.page = page;

    await page.addInitScript(qaPageScript);

    this.cdp = await context.newCDPSession(page);
    await this.cdp.send("Network.enable");
    await this.cdp.send("Performance.enable");

    this.net.attach(this.cdp);

    const sampler = setInterval(() => {
      this.sample().catch(() => {});
    }, 1000);

    try {
      if (this.kind === "channel") {
        await this.resolveChannel(page);
      }

      await this.playCurrent(page);

      const human = this.cfg.humanize
        ? new HumanBehavior(page, this.abort.signal).run()
        : Promise.resolve();

      const repeater = this.cfg.repeat
        ? this.repeatLoop(page)
        : Promise.resolve();

      if (this.cfg.maxRuntimeSec) {
        await sleep(this.cfg.maxRuntimeSec * 1000, this.abort.signal);
        this.stop();
      } else {
        await this.waitStop();
      }

      await Promise.allSettled([human, repeater]);
    } finally {
      clearInterval(sampler);
      await context.close().catch(() => {});
    }
  }

  private waitStop(): Promise<void> {
    return new Promise<void>((resolve) => {
      const i = setInterval(() => {
        if (this.abort.signal.aborted) {
          clearInterval(i);
          resolve();
        }
      }, 250);
    });
  }

  private async resolveChannel(page: Page): Promise<void> {
    this.queue = await resolveChannelVideos(
      page,
      this.currentUrl,
      25,
      this.cfg.consentMode ?? "reject"
    );

    if (!this.queue.length) {
      throw new Error("Kanal-Resolver hat keine Videos gefunden.");
    }

    this.queueIndex = 0;
    this.currentUrl = this.queue[0];
  }

  private async playCurrent(page: Page): Promise<void> {
    await page.goto(this.currentUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await this.prepare(page);
  }

  private async prepare(page: Page): Promise<void> {
    await acceptConsent(page, this.cfg.consentMode ?? "reject");

    await page
      .waitForSelector("video", { timeout: 30000 })
      .catch(() => {});

    if (this.cfg.mute !== false) {
      await page.evaluate(() => {
        const v = document.querySelector("video");
        if (v) {
          v.muted = true;
          v.volume = 0;
        }
      });
    }

    await this.ensureQuality(page);

    await page.evaluate(() => (window as any).__qa?.play?.());
  }

  private async ensureQuality(page: Page): Promise<void> {
    const label = this.cfg.quality;
    if (!label || label === "auto") return;

    const code = qualityToCode(label);

    await page.evaluate(
      (q: string) => (window as any).__qa?.setQuality?.(q),
      label
    );

    await sleep(1200, this.abort.signal);

    const levels = await page
      .evaluate(() => (window as any).__qa?.available?.() ?? [])
      .catch(() => []);

    if (Array.isArray(levels) && levels.length && !levels.includes(code)) {
      await this.forceQualityViaUi(page, label).catch(() => {});
    }
  }

  private async forceQualityViaUi(page: Page, label: string): Promise<void> {
    const settingsSelectors = [
      ".ytp-settings-button",
      "button.ytp-settings-button",
      '[aria-label*="Settings" i]',
      '[aria-label*="Einstellungen" i]',
    ];

    await page.locator(settingsSelectors.join(", ")).first().click({
      timeout: 2000,
    });

    const menu = page
      .locator(".ytp-quality-menu, .ytp-popup-menu")
      .first();

    await menu.waitFor({ state: "visible", timeout: 2000 });

    await menu
      .locator(`.ytp-menuitem:has-text("${label}")`)
      .first()
      .click({ timeout: 2000 });

    await page.keyboard.press("Escape").catch(() => {});
  }

  private async repeatLoop(page: Page): Promise<void> {
    while (!this.abort.signal.aborted) {
      await sleep(2000, this.abort.signal);
      if (this.abort.signal.aborted) break;

      const stats = await page
        .evaluate(() => (window as any).__qa?.stats?.())
        .catch(() => null);

      if (!stats) continue;

      if (stats.ended || stats.state === "ended") {
        await this.advance();

        if (!this.abort.signal.aborted) {
          await this.playCurrent(page);
        }
      }
    }
  }

  private async advance(): Promise<void> {
    if (this.kind === "playlist") {
      const pid =
        extractPlaylistId(this.cfg.url) ??
        extractPlaylistId(this.currentUrl);

      if (pid) {
        this.currentUrl = toWatchPlaylistUrl(pid, 1);
      }

      return;
    }

    if (this.queue.length > 1) {
      this.queueIndex = (this.queueIndex + 1) % this.queue.length;
      this.currentUrl = this.queue[this.queueIndex];
      return;
    }

    // Einzelnes Video oder Kanal mit nur einem Video:
    // aktuelle URL wird einfach erneut geladen.
  }

  private async sample(): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed() || !this.cdp) return;

    const stats = await page
      .evaluate(() => (window as any).__qa?.stats?.())
      .catch(() => null);

    const net = this.net.snapshot();

    let rendererCpuPercent = 0;
    let jsHeapMb = 0;

    try {
      const perf: any = await this.cdp.send("Performance.getMetrics");
      const map = Object.fromEntries(
        perf.metrics.map((m: any) => [m.name, m.value])
      );

      const taskDuration = Number(map.TaskDuration ?? 0);
      const jsHeapUsedSize = Number(map.JSHeapUsedSize ?? 0);

      const now = Date.now();
      const dtSec = Math.max(0.25, (now - this.lastPerfTs) / 1000);

      if (this.lastTaskDuration > 0) {
        rendererCpuPercent = Math.max(
          0,
          ((taskDuration - this.lastTaskDuration) / dtSec) * 100
        );
      }

      jsHeapMb = jsHeapUsedSize / 1024 / 1024;

      this.lastTaskDuration = taskDuration;
      this.lastPerfTs = now;
    } catch {}

    const proc = await this.processStats();

    const sample: Sample = {
      ts: Date.now(),
      sessionId: this.cfg.id,
      kind: this.kind,
      queueIndex: this.queueIndex,
      url: page.url(),
      state: stats?.state ?? "idle",
      currentTime: stats?.currentTime ?? 0,
      duration: stats?.duration ?? 0,
      bufferedSec: stats?.bufferedAhead ?? 0,
      quality: String(stats?.quality ?? ""),
      bandwidthMBps: net.mbPerSec,
      cpuPercent: proc.cpu,
      ramMb: proc.mem / 1024 / 1024,
      rendererCpuPercent,
      jsHeapMb,
      stalls: stats?.stalls ?? 0,
      droppedFrames: stats?.droppedFrames ?? 0,
      totalFrames: stats?.totalFrames ?? 0,
    };

    this.onSample(sample);
  }

  private browserPid?: number;

  private async resolveBrowserPid(): Promise<number | undefined> {
    if (this.browserPid) return this.browserPid;

    try {
      const bcdp = await this.browser.newBrowserCDPSession();
      try {
        const info: any = await bcdp.send("SystemInfo.getProcessInfo" as any);
        const main = (info?.processInfo ?? []).find(
          (p: any) => p.type === "browser"
        );
        this.browserPid = main?.id;
      } finally {
        await bcdp.detach().catch(() => {});
      }
    } catch {
      // keine Prozesswerte verfügbar
    }

    return this.browserPid;
  }

  private async processStats(): Promise<{ cpu: number; mem: number }> {
    const pid = await this.resolveBrowserPid();

    if (!pid) {
      return { cpu: 0, mem: 0 };
    }

    try {
      const stats = await pidusage(pid);
      return {
        cpu: stats.cpu ?? 0,
        mem: stats.memory ?? 0,
      };
    } catch {
      return { cpu: 0, mem: 0 };
    }
  }
}
