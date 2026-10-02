import type { Page } from "playwright-core";
import { pickWeighted, rand, sleep } from "./util";

export class HumanBehavior {
  constructor(
    private page: Page,
    private signal: AbortSignal
  ) {}

  async run(): Promise<void> {
    await sleep(rand(2000, 7000), this.signal);

    while (!this.signal.aborted) {
      await sleep(rand(15000, 50000), this.signal);
      if (this.signal.aborted) break;

      const action = pickWeighted<string>([
        ["pause", 0.2],
        ["seekForward", 0.35],
        ["seekBackward", 0.25],
        ["mouseJiggle", 0.1],
        ["none", 0.1],
      ]);

      try {
        if (action === "pause") {
          await this.page.evaluate(() => (window as any).__qa?.pause?.());

          await sleep(rand(2000, 9000), this.signal);

          if (!this.signal.aborted) {
            await this.page.evaluate(() => (window as any).__qa?.play?.());
          }
        } else if (action === "seekForward") {
          await this.page.evaluate(
            (d: number) => (window as any).__qa?.seekBy?.(d),
            rand(5, 45)
          );
        } else if (action === "seekBackward") {
          await this.page.evaluate(
            (d: number) => (window as any).__qa?.seekBy?.(-d),
            rand(5, 30)
          );
        } else if (action === "mouseJiggle") {
          await this.page.mouse.move(rand(100, 1100), rand(100, 600));
        }
      } catch {
        // Navigation/Playerwechsel können Evaluate kurz fehlschlagen lassen.
      }
    }
  }
}
