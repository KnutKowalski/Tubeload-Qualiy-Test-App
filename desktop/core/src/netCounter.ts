import type { CDPSession } from "playwright-core";

export class NetworkCounter {
  private bytes = 0;
  private lastTs = Date.now();

  attach(cdp: CDPSession): void {
    cdp.on("Network.dataReceived", (event: any) => {
      const len = event.encodedDataLength ?? event.dataLength ?? 0;
      this.bytes += len;
    });
  }

  snapshot(): { bytes: number; mbPerSec: number } {
    const now = Date.now();
    const dtSec = Math.max(0.001, (now - this.lastTs) / 1000);

    const mbPerSec = this.bytes / dtSec / 1_000_000;
    const bytes = this.bytes;

    this.bytes = 0;
    this.lastTs = now;

    return { bytes, mbPerSec };
  }
}
