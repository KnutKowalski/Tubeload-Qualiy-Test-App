import type { Page } from "playwright-core";
import { pickWeighted, rand, sleep } from "./util";
import type { InteractionConfig } from "./types";

export class InteractionTester {
  constructor(
    private page: Page,
    private signal: AbortSignal,
    private config: InteractionConfig
  ) {}

  private async triggerPlayerAction(action: string, value?: number): Promise<boolean> {
    try {
      // Nutzt das bereits in qaPageScript.ts injizierte __qa Objekt
      const result = await this.page.evaluate(
        ({ act, val }) => {
          const qa = (window as any).__qa;
          if (!qa) return false;
          if (act === "pause") return qa.pause?.();
          if (act === "play") return qa.play?.();
          if (act === "seekBy" && typeof val === "number") return qa.seekBy?.(val);
          return false;
        },
        { act: action, val: value }
      );
      return result === true;
    } catch {
      // Player lädt evtl. gerade neu, Fehler stillschweigend ignorieren und beim nächsten Mal probieren
      return false;
    }
  }

  async run(): Promise<void> {
    // Initiale Wartezeit, damit das Video erst mal anläuft und der Player bereit ist
    await sleep(rand(4000, 8000), this.signal);

    if (this.config.mode === "manual") {
      await this.runManualSequence();
    } else {
      await this.runRandomBehavior();
    }
  }

  private async runRandomBehavior(): Promise<void> {
    const minP = this.config.minPauseSec ?? 2;
    const maxP = this.config.maxPauseSec ?? 8;
    const minS = this.config.minSeekSec ?? 5;
    const maxS = this.config.maxSeekSec ?? 45;

    while (!this.signal.aborted) {
      const action = pickWeighted<string>([
        ["pause", 0.30],
        ["seekForward", 0.35],
        ["seekBackward", 0.25],
        ["mouseJiggle", 0.10],
      ]);

      try {
        if (action === "pause") {
          await this.triggerPlayerAction("pause");
          const pauseDuration = rand(minP * 1000, maxP * 1000);
          await sleep(pauseDuration, this.signal);
          if (!this.signal.aborted) await this.triggerPlayerAction("play");
        } else if (action === "seekForward") {
          await this.triggerPlayerAction("seekBy", rand(minS, maxS));
        } else if (action === "seekBackward") {
          await this.triggerPlayerAction("seekBy", -rand(minS, Math.max(minS, maxS / 2)));
        } else if (action === "mouseJiggle") {
          await this.page.mouse.move(rand(100, 1100), rand(100, 600));
        }
      } catch {
        // Ignorieren
      }

      // Zufällige Pause zwischen den Aktionen, um menschliches Verhalten zu simulieren
      await sleep(rand(8000, 25000), this.signal);
    }
  }

  private async runManualSequence(): Promise<void> {
    if (!this.config.manualSequence) return;
    
    // Parse "30, -15, 10" zu [30, -15, 10]
    const seq = this.config.manualSequence.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (seq.length === 0) return;

    let index = 0;
    while (!this.signal.aborted) {
      const step = seq[index % seq.length];
      index++;
      
      if (step > 0) {
        // Positiver Wert: Warten
        await sleep(step * 1000, this.signal);
      } else {
        // Negativer Wert: Zurückspulen (in Sekunden)
        await this.triggerPlayerAction("seekBy", step);
        await sleep(3000, this.signal); // Kurz warten, damit der Player den Seek verarbeiten und neu puffern kann
      }
    }
  }
}
