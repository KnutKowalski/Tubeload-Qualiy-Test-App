import type { Browser, CDPSession, Page } from "playwright-core";

import { NetworkCounter } from "./netCounter";
import { qaPageScript } from "./qaPageScript";
import { acceptConsent } from "./consent";
import { resolveChannelVideos } from "./channelResolver";
import { log } from "./log";
import type { ProcessMonitor } from "./processMonitor";
import { detectUrlKind, extractPlaylistId, toWatchPlaylistUrl, videoIdOf } from "./url";
import { LIMITS } from "./limits";
import { qualityHeight, shortError, sleep, viewportFor } from "./util";
import type {
  EndReason,
  InteractionResult,
  InteractionStep,
  Sample,
  SessionConfig,
  SessionState,
  UrlKind,
} from "./types";

interface PageStats {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
  bufferedAhead: number;
  width: number;
  height: number;
  droppedFrames: number;
  totalFrames: number;
  stalls: number;
  stallMs: number;
  startupMs: number;
  errors: number;
  state: string;
  ad: boolean;
}

type EndedOutcome = "continue" | "cycle" | "stop";

function describeStep(s: InteractionStep): string {
  if (s.action === "pause") return `Pause ${s.value} s`;
  if (s.action === "seek") return `Sprung ${(s.value ?? 0) > 0 ? "+" : ""}${s.value} s`;

  return s.action === "next" ? "nächstes Video" : "vorheriges Video";
}

export class SessionRunner {
  private abort = new AbortController();
  private cdp?: CDPSession;
  private net = new NetworkCounter();
  private page?: Page;

  private sampler?: NodeJS.Timeout;
  private runtimeTimer?: NodeJS.Timeout;
  private sampling = false;

  private lastTaskDuration = 0;
  private lastPerfTs = Date.now();

  private currentUrl: string;
  private kind: UrlKind;
  private queue: string[] = [];
  private queueIndex = 0;
  private loops = 0;

  // Interaktionsskript: je Durchlauf ein Ablauf, bei jedem Lauf identisch.
  private scriptCtl?: AbortController;
  private scriptDone: Promise<void> = Promise.resolve();
  private scriptBusy = false;
  private stepNote = "";

  /** Warum die Session endete – wird vom Manager in die Zusammenfassung übernommen. */
  endReason: EndReason = "completed";

  constructor(
    private cfg: SessionConfig,
    private browser: Browser,
    private monitor: ProcessMonitor,
    private onSample: (s: Sample) => void,
    private onInteraction: (r: InteractionResult) => void = () => {}
  ) {
    this.kind = detectUrlKind(cfg.url, cfg.kind);
    this.currentUrl = cfg.url;
  }

  /** Beendet die Session von außen (Benutzer, Shutdown). Der erste Grund gewinnt. */
  stop(reason: EndReason = "stopped"): void {
    this.end(reason);
  }

  private end(reason: EndReason): void {
    if (this.abort.signal.aborted) return;

    this.endReason = reason;
    this.abort.abort();
  }

  private get aborted(): boolean {
    return this.abort.signal.aborted;
  }

  async run(): Promise<void> {
    const context = await this.browser.newContext({
      viewport: viewportFor(this.cfg.quality),
      deviceScaleFactor: 1,
    });

    try {
      // Dev-Modus (tsx/esbuild) injiziert __name() in serialisierte Funktionen.
      await context.addInitScript(
        "window.__name = window.__name || ((f) => f);"
      );

      const page = await context.newPage();
      this.page = page;

      await page.addInitScript(qaPageScript);

      this.cdp = await context.newCDPSession(page);
      await this.cdp.send("Network.enable");
      await this.cdp.send("Performance.enable");

      this.net.attach(this.cdp);

      this.runtimeTimer = setTimeout(
        () => this.end("max_runtime"),
        this.cfg.maxRuntimeSec * 1000
      );

      this.sampler = setInterval(() => {
        void this.sample();
      }, 1000);

      if (this.kind === "channel") {
        await this.resolveChannel(page);
      }

      await this.playCurrent(page);

      if (!(await this.ensurePlaying(page))) return;

      this.startScript(page);

      await this.playLoop(page);
    } catch (e) {
      // Fehler durch einen Abbruch (Context geschlossen, Navigation abgebrochen)
      // sind erwartet und kein echter Fehler.
      if (this.aborted) return;

      this.onSample(this.diagnosticSample("error", shortError(e)));
      this.end("error");

      throw e;
    } finally {
      if (this.sampler) clearInterval(this.sampler);
      if (this.runtimeTimer) clearTimeout(this.runtimeTimer);

      // Offene Skriptschritte als "übersprungen" melden, bevor die Session als beendet gilt.
      this.scriptCtl?.abort();
      await this.scriptDone;

      await context.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Ablauf
  // ---------------------------------------------------------------------------

  /**
   * Läuft, bis das Video (bzw. Playlist/Kanal) zu Ende gespielt wurde und
   * keine Wiederholung mehr ansteht, oder bis die Session abgebrochen wird.
   * Alles läuft sequentiell in einem await-Strang: Fehler landen in run().
   */
  private async playLoop(page: Page): Promise<void> {
    let missing = 0;
    let videoErrors = 0;
    let endedPolls = 0;

    while (!this.aborted) {
      await sleep(1000, this.abort.signal);
      if (this.aborted) return;

      // Während ein Skriptschritt läuft (z. B. Seitenwechsel im Kanal), wird nichts bewertet.
      if (this.scriptBusy) {
        missing = 0;
        endedPolls = 0;
        continue;
      }

      const stats = await this.readStats(page);

      if (!stats) {
        if (++missing >= 30) {
          this.onSample(
            this.diagnosticSample("no_video", "Seit 30 s kein Video-Element auf der Seite.")
          );
          this.end("error");
          return;
        }

        continue;
      }

      missing = 0;

      if (stats.state === "error") {
        if (++videoErrors >= 5) {
          this.onSample(this.diagnosticSample("error", "Wiedergabefehler im Video-Element."));
          this.end("error");
          return;
        }

        continue;
      }

      videoErrors = 0;

      // Das Ende einer Werbung kann kurz wie "ended" aussehen. Gewertet wird das
      // Videoende erst, wenn keine Werbung läuft und der Zustand in zwei
      // aufeinanderfolgenden Messungen anliegt.
      if (stats.state !== "ended" || stats.ad) {
        endedPolls = 0;
        continue;
      }

      if (++endedPolls < 2) continue;

      endedPolls = 0;

      const outcome = await this.onEnded(page);

      if (outcome === "stop") return;
      if (outcome === "continue") continue;

      // Ein kompletter Durchlauf ist fertig; ein noch offenes Skript endet mit ihm.
      this.scriptCtl?.abort();
      this.loops++;

      if (!this.cfg.repeat || this.loops >= this.cfg.maxLoops) {
        this.end("completed");
        return;
      }

      this.prepareNextCycle();
      await this.playCurrent(page);

      if (!(await this.ensurePlaying(page))) return;

      this.startScript(page);
    }
  }

  // ---------------------------------------------------------------------------
  // Interaktionsskript (fest vorgegeben, kein Zufall)
  // ---------------------------------------------------------------------------

  /** Startet das Skript für den aktuellen Durchlauf; Zeiten zählen ab jetzt. */
  private startScript(page: Page): void {
    const steps = this.cfg.interactions ?? [];

    if (!steps.length) return;

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();

    // Endet die Session, endet auch das Skript.
    this.abort.signal.addEventListener("abort", onAbort, { once: true });

    this.scriptCtl?.abort();
    this.scriptCtl = ctl;

    const loop = this.loops + 1;
    const t0 = Date.now();
    const previous = this.scriptDone;

    this.scriptDone = previous
      .then(() => this.runScript(page, steps, loop, t0, ctl.signal))
      .catch((e: unknown) => log.warn(`Session ${this.cfg.id}: Interaktionsskript: ${shortError(e)}`))
      .finally(() => this.abort.signal.removeEventListener("abort", onAbort));
  }

  private async runScript(
    page: Page,
    steps: InteractionStep[],
    loop: number,
    t0: number,
    signal: AbortSignal
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const wait = t0 + step.at * 1000 - Date.now();

      if (wait > 0) await sleep(wait, signal);

      if (signal.aborted) {
        this.skipRest(steps, i, loop);
        return;
      }

      this.scriptBusy = true;
      this.stepNote = `Interaktion: ${describeStep(step)}`;

      let result: InteractionResult;

      try {
        result = await this.performStep(page, step, loop, Math.round((Date.now() - t0) / 1000), signal);
      } finally {
        this.scriptBusy = false;
        this.stepNote = "";
      }

      this.onInteraction(result);

      if (signal.aborted) {
        this.skipRest(steps, i + 1, loop);
        return;
      }
    }
  }

  private skipRest(steps: InteractionStep[], from: number, loop: number): void {
    // Zeit des Schritts lag hinter dem Ende: Video zu Ende (Normalfall), Durchlauf
    // vor einer Wiederholung beendet oder die Session wurde gestoppt.
    const note = !this.aborted
      ? "Durchlauf vorher beendet"
      : this.endReason === "completed"
        ? "Video war vorher zu Ende"
        : "Session vorher beendet";

    for (let i = from; i < steps.length; i++) {
      const s = steps[i];

      this.onInteraction({
        loop,
        at: s.at,
        startedAtSec: -1,
        action: s.action,
        value: s.value,
        status: "skipped",
        recoveryMs: -1,
        note,
      });
    }
  }

  /** Führt genau einen Schritt aus und misst, wann die Wiedergabe wieder läuft. */
  private async performStep(
    page: Page,
    step: InteractionStep,
    loop: number,
    startedAtSec: number,
    signal: AbortSignal
  ): Promise<InteractionResult> {
    const base = { loop, at: step.at, startedAtSec, action: step.action, value: step.value };
    const timeoutMs = LIMITS.interactionRecoveryTimeoutSec * 1000;
    const timeoutNote = `Wiedergabe lief nicht innerhalb von ${LIMITS.interactionRecoveryTimeoutSec} s wieder.`;

    const finish = (ms: number, ad: boolean, extra = ""): InteractionResult => {
      const notes = [extra, ad ? "Werbung während der Messung" : "", ms < 0 ? timeoutNote : ""].filter(Boolean);

      return {
        ...base,
        status: ms >= 0 ? "ok" : "failed",
        recoveryMs: ms,
        note: notes.length ? notes.join("; ") : undefined,
      };
    };

    const skipped = (note: string): InteractionResult => ({
      ...base,
      status: "skipped",
      recoveryMs: -1,
      note,
    });

    try {
      switch (step.action) {
        case "pause": {
          const paused = await page.evaluate(() => (window as any).__qa.pause());

          if (!paused) {
            return { ...base, status: "failed", recoveryMs: -1, note: "Pause hat nicht gegriffen." };
          }

          await sleep((step.value ?? 0) * 1000, signal);

          if (signal.aborted) return skipped("Session während der Pause beendet");

          const r = await page.evaluate((t: number) => (window as any).__qa.resume(t), timeoutMs);

          return finish(r.ms, r.ad);
        }

        case "seek": {
          const r = await page.evaluate(
            ([d, t]: [number, number]) => (window as any).__qa.seekBy(d, t),
            [step.value ?? 0, timeoutMs] as [number, number]
          );

          const extra = r.clamped ? "Sprung auf das Videoende begrenzt" : "";

          return finish(r.ms, r.ad, extra);
        }

        case "next":
        case "previous":
          return await this.stepVideo(page, step, base, signal, timeoutMs, finish, skipped);
      }
    } catch (e) {
      if (signal.aborted) return skipped("Session beendet");

      return { ...base, status: "failed", recoveryMs: -1, note: shortError(e) };
    }
  }

  /** Nächstes/vorheriges Video: Playlist über den Player, Kanal über die aufgelöste Liste. */
  private async stepVideo(
    page: Page,
    step: InteractionStep,
    base: { loop: number; at: number; startedAtSec: number; action: InteractionStep["action"]; value?: number },
    signal: AbortSignal,
    timeoutMs: number,
    finish: (ms: number, ad: boolean, extra?: string) => InteractionResult,
    skipped: (note: string) => InteractionResult
  ): Promise<InteractionResult> {
    const dir = step.action === "next" ? 1 : -1;

    if (this.kind === "video") {
      return skipped("Nicht anwendbar: Einzelvideo (nur bei Playlist oder Kanal).");
    }

    if (this.kind === "channel") {
      const target = this.queueIndex + dir;

      if (target < 0 || target >= this.queue.length) {
        return skipped(dir > 0 ? "Kein weiteres Video in der Kanalliste." : "Kein vorheriges Video in der Kanalliste.");
      }

      this.queueIndex = target;
      this.currentUrl = this.queue[target];

      const t0 = Date.now();

      await this.playCurrent(page);

      // Gemessen wird der ganze Wechsel: Seite laden + bis die Wiedergabe läuft.
      const loadedMs = Date.now() - t0;
      const r = await this.waitReady(page, Math.max(5000, timeoutMs - loadedMs), signal);

      return finish(r.ms < 0 ? -1 : loadedMs + r.ms, r.ad, "Seite neu geladen (Kanal)");
    }

    // Playlist
    const before = videoIdOf(page.url());
    const ok = await page.evaluate((d: number) => (window as any).__qa.step(d), dir);

    if (!ok) await page.keyboard.press(dir > 0 ? "Shift+N" : "Shift+P").catch(() => {});

    const r = await this.waitReady(page, timeoutMs, signal, () => videoIdOf(page.url()) !== before);

    if (r.ms < 0 && videoIdOf(page.url()) === before) {
      return {
        ...base,
        status: "failed",
        recoveryMs: -1,
        note: `Kein Wechsel innerhalb von ${LIMITS.interactionRecoveryTimeoutSec} s (${dir > 0 ? "letztes" : "erstes"} Video der Playlist?).`,
      };
    }

    return finish(r.ms, r.ad);
  }

  /**
   * Wartet, bis die Wiedergabe läuft (und die Position vorankommt). ms = Zeitpunkt des
   * ersten "läuft" ab Aufruf; -1 = Zeitüberschreitung.
   */
  private async waitReady(
    page: Page,
    timeoutMs: number,
    signal: AbortSignal,
    until?: () => boolean
  ): Promise<{ ms: number; ad: boolean }> {
    const t0 = Date.now();
    let since = -1;
    let base = 0;
    let ad = false;

    while (Date.now() - t0 < timeoutMs && !signal.aborted) {
      const st = await this.readStats(page);

      if (st?.ad) ad = true;

      if (st && st.state === "playing" && (!until || until())) {
        if (since < 0) {
          since = Date.now() - t0;
          base = st.currentTime;
        } else if (st.currentTime - base >= 0.25) {
          return { ms: since, ad };
        }
      } else {
        since = -1;
      }

      await sleep(100, signal);
    }

    return { ms: -1, ad };
  }

  /** Das aktuelle Video ist zu Ende: gibt es noch einen weiteren Eintrag im Durchlauf? */
  private async onEnded(page: Page): Promise<EndedOutcome> {
    if (this.kind === "channel") {
      if (this.queueIndex + 1 < this.queue.length) {
        this.queueIndex++;
        this.currentUrl = this.queue[this.queueIndex];

        await this.playCurrent(page);

        return (await this.ensurePlaying(page)) ? "continue" : "stop";
      }

      return "cycle";
    }

    if (this.kind === "playlist") {
      // YouTube springt am Ende eines Videos von selbst zum nächsten Eintrag.
      // Nur wenn das innerhalb der Frist NICHT passiert, ist die Playlist durch.
      const before = videoIdOf(page.url());
      const until = Date.now() + 12_000;

      while (Date.now() < until && !this.aborted) {
        await sleep(500, this.abort.signal);

        const now = videoIdOf(page.url());
        const stats = await this.readStats(page);

        if ((now && now !== before) || (stats && stats.state !== "ended")) {
          return "continue";
        }
      }

      return this.aborted ? "stop" : "cycle";
    }

    return "cycle";
  }

  private prepareNextCycle(): void {
    if (this.kind === "playlist") {
      const pid = extractPlaylistId(this.cfg.url);

      if (pid) this.currentUrl = toWatchPlaylistUrl(pid, 1);
    } else if (this.kind === "channel" && this.queue.length) {
      this.queueIndex = 0;
      this.currentUrl = this.queue[0];
    }
    // Einzelnes Video: dieselbe URL wird erneut geladen.
  }

  private async ensurePlaying(page: Page): Promise<boolean> {
    const playback = await this.waitForPlayback(page);

    if (playback.ok) return true;

    if (!this.aborted) {
      this.onSample(this.diagnosticSample(playback.state, playback.note));
      this.end(playback.state === "blocked" ? "blocked" : "error");
    }

    return false;
  }

  private async resolveChannel(page: Page): Promise<void> {
    this.queue = await resolveChannelVideos(
      page,
      this.currentUrl,
      undefined,
      this.cfg.consentMode
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
    const consentResult = await acceptConsent(page, this.cfg.consentMode);

    // Cookie-Fallback hat die Seite neu geladen: Navigation abwarten.
    if (consentResult === "cookie_fallback") {
      await page
        .waitForLoadState("domcontentloaded", { timeout: 30000 })
        .catch(() => {});
    }

    // Die Wartezeit auf das Video-Element zählt zur Startfrist (höchstens 30 s).
    await page
      .waitForSelector("video", {
        timeout: Math.min(30_000, this.cfg.startTimeoutSec * 1000),
      })
      .catch(() => {});

    if (this.cfg.mute) {
      await page
        .evaluate(() => {
          const v = document.querySelector("video");

          if (v) {
            v.muted = true;
            v.volume = 0;
          }
        })
        .catch(() => {});
    }

    await this.ensureQuality(page);

    await page.evaluate(() => (window as any).__qa?.play?.()).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Qualität (best effort)
  // ---------------------------------------------------------------------------

  private async ensureQuality(page: Page): Promise<void> {
    const label = this.cfg.quality;
    const want = qualityHeight(label);

    if (!want) return;

    await page
      .evaluate((q: string) => (window as any).__qa?.setQuality?.(q), label)
      .catch(() => {});

    await sleep(1500, this.abort.signal);

    const stats = await this.readStats(page);

    // Die Qualitäts-API von YouTube ist abgekündigt. Weicht die tatsächliche
    // Auflösung ab, wird zusätzlich der Weg über das Einstellungsmenü versucht.
    if (stats && stats.height > 0 && stats.height !== want) {
      await this.forceQualityViaUi(page, label).catch(() => {});
    }
  }

  private async forceQualityViaUi(page: Page, label: string): Promise<void> {
    await page
      .locator(".ytp-settings-button")
      .first()
      .click({ timeout: 2000 });

    const menu = page.locator(".ytp-settings-menu").first();
    await menu.waitFor({ state: "visible", timeout: 2000 });

    // Hauptmenü -> Eintrag "Qualität"/"Quality" -> Untermenü mit den Auflösungen.
    await menu
      .locator(".ytp-menuitem")
      .filter({ hasText: /Qualit|Quality/i })
      .first()
      .click({ timeout: 2000 });

    await menu
      .locator(".ytp-menuitem")
      .filter({ hasText: new RegExp(`^\\s*${label}(?!\\d)`) })
      .filter({ hasNotText: /Premium/i })
      .first()
      .click({ timeout: 2000 });

    await page.keyboard.press("Escape").catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Messung
  // ---------------------------------------------------------------------------

  private readStats(page: Page): Promise<PageStats | null> {
    return page
      .evaluate(() => (window as any).__qa?.stats?.() ?? null)
      .catch(() => null) as Promise<PageStats | null>;
  }

  private async sample(): Promise<void> {
    const page = this.page;

    // Kein Überlappen, falls ein Durchlauf länger als 1 s dauert.
    if (this.sampling || !page || page.isClosed() || !this.cdp) return;

    this.sampling = true;

    try {
      const stats = await this.readStats(page);
      const net = this.net.snapshot();

      let rendererCpuPercent = 0;
      let jsHeapMb = 0;

      try {
        const perf = (await this.cdp.send("Performance.getMetrics")) as {
          metrics: { name: string; value: number }[];
        };

        const map = Object.fromEntries(
          perf.metrics.map((m) => [m.name, m.value])
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
      } catch {
        // Metriken kurzzeitig nicht verfügbar (z. B. während einer Navigation)
      }

      const proc = await this.monitor.snapshot();

      const notes: string[] = [];
      const wantHeight = qualityHeight(this.cfg.quality);

      if (stats?.ad) notes.push("Werbung läuft");
      if (this.stepNote) notes.push(this.stepNote);

      if (
        wantHeight &&
        stats &&
        stats.state === "playing" &&
        stats.height > 0 &&
        stats.height !== wantHeight
      ) {
        notes.push(`Angefordert ${this.cfg.quality}, aktuell ${stats.height}p`);
      }

      this.onSample({
        ts: Date.now(),
        sessionId: this.cfg.id,
        kind: this.kind,
        queueIndex: this.queueIndex,
        url: page.url(),
        state: (stats?.state ?? "no_video") as SessionState,
        currentTime: stats?.currentTime ?? 0,
        duration: stats?.duration ?? 0,
        bufferedSec: stats?.bufferedAhead ?? 0,
        quality: stats && stats.height > 0 ? `${stats.height}p` : "",
        width: stats?.width ?? 0,
        height: stats?.height ?? 0,
        bandwidthMBps: net.mbPerSec,
        cpuPercent: proc.cpu,
        ramMb: proc.memBytes / 1024 / 1024,
        rendererCpuPercent,
        jsHeapMb,
        stalls: stats?.stalls ?? 0,
        stallSec: (stats?.stallMs ?? 0) / 1000,
        startupMs: stats?.startupMs ?? -1,
        droppedFrames: stats?.droppedFrames ?? 0,
        totalFrames: stats?.totalFrames ?? 0,
        note: notes.length ? notes.join("; ") : undefined,
      });
    } catch (e) {
      log.debug("Sample fehlgeschlagen", e);
    } finally {
      this.sampling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Start-Diagnose
  // ---------------------------------------------------------------------------

  private async waitForPlayback(
    page: Page
  ): Promise<{ ok: boolean; state: SessionState; note: string }> {
    const timeoutMs = this.cfg.startTimeoutSec * 1000;
    const deadline = Date.now() + timeoutMs;
    let consentAttempts = 0;

    while (Date.now() < deadline && !this.aborted) {
      const diag = await this.diagnose(page);

      if (diag.state === "playing") {
        return { ok: true, state: "playing", note: "" };
      }

      if (diag.consentVisible && consentAttempts < 3) {
        consentAttempts++;

        const result = await acceptConsent(page, this.cfg.consentMode);

        if (result === "cookie_fallback") {
          await page
            .waitForLoadState("domcontentloaded", { timeout: 30000 })
            .catch(() => {});
        }

        await sleep(2000, this.abort.signal);
        continue;
      }

      if (diag.consentVisible && consentAttempts >= 3) {
        return {
          ok: false,
          state: "blocked",
          note: "Consent-Dialog trotz automatischem Abnicken (3 Versuche inkl. Cookie-Fallback) noch sichtbar.",
        };
      }

      if (diag.blocked) {
        return { ok: false, state: "blocked", note: diag.note };
      }

      await sleep(1000, this.abort.signal);
    }

    const diag = await this.diagnose(page);

    return {
      ok: false,
      state: diag.hasVideo ? "not_playing" : "no_video",
      note:
        diag.note ||
        `Keine Wiedergabe innerhalb von ${this.cfg.startTimeoutSec} s gestartet.`,
    };
  }

  private async diagnose(page: Page): Promise<{
    state: string;
    hasVideo: boolean;
    blocked: boolean;
    consentVisible: boolean;
    note: string;
  }> {
    const diag = await page
      .evaluate(() => {
        const w = window as any;
        const stats = w.__qa?.stats?.() ?? null;

        const text = (document.body?.innerText ?? "").slice(0, 5000);

        const botWall =
          /Sign in to confirm|melde dich an, um zu bestätigen|unusual traffic|nicht ein Bot/i.test(
            text
          );

        // Consent-Wand: Weiterleitung auf consent.*, Inline-Formular
        // oder sichtbare Consent-Buttons (DE/EN).
        const consentVisible =
          location.hostname.startsWith("consent.") ||
          !!document.querySelector('form[action*="consent"]') ||
          /alle ablehnen|alle akzeptieren|reject all|accept all/i.test(text);

        return {
          state: stats?.state ?? "",
          hasVideo: !!document.querySelector("video"),
          botWall,
          consentVisible,
        };
      })
      .catch(() => null);

    if (!diag) {
      return {
        state: "",
        hasVideo: false,
        blocked: false,
        consentVisible: false,
        note: "Seite nicht erreichbar (Navigation fehlgeschlagen?).",
      };
    }

    // Die App umgeht eine Bot-/Anmeldeprüfung bewusst NICHT, sondern bricht ab.
    if (diag.botWall) {
      return {
        state: diag.state,
        hasVideo: diag.hasVideo,
        blocked: true,
        consentVisible: diag.consentVisible,
        note: "YouTube blockiert die Wiedergabe (Bot-/Anmeldeprüfung).",
      };
    }

    if (diag.consentVisible) {
      return {
        state: diag.state,
        hasVideo: diag.hasVideo,
        blocked: false,
        consentVisible: true,
        note: "Consent-Dialog sichtbar.",
      };
    }

    return {
      state: diag.state,
      hasVideo: diag.hasVideo,
      blocked: false,
      consentVisible: false,
      note: diag.hasVideo ? "" : "Kein <video>-Element auf der Seite.",
    };
  }

  private diagnosticSample(state: SessionState, note: string): Sample {
    return {
      ts: Date.now(),
      sessionId: this.cfg.id,
      kind: this.kind,
      queueIndex: this.queueIndex,
      url: this.currentUrl,
      state,
      note,
      currentTime: 0,
      duration: 0,
      bufferedSec: 0,
      quality: "",
      width: 0,
      height: 0,
      bandwidthMBps: 0,
      cpuPercent: 0,
      ramMb: 0,
      rendererCpuPercent: 0,
      jsHeapMb: 0,
      stalls: 0,
      stallSec: 0,
      startupMs: -1,
      droppedFrames: 0,
      totalFrames: 0,
    };
  }
}
