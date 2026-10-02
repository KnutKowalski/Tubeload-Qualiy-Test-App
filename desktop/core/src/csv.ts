import fs from "node:fs";
import path from "node:path";
import type { Sample } from "./types";

const header = [
  "timestamp",
  "sessionId",
  "kind",
  "queueIndex",
  "url",
  "state",
  "currentTime",
  "duration",
  "bufferedSec",
  "quality",
  "bandwidthMBps",
  "cpuPercent",
  "ramMb",
  "rendererCpuPercent",
  "jsHeapMb",
  "stalls",
  "droppedFrames",
  "totalFrames",
];

export class CsvWriter {
  private stream: fs.WriteStream;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const exists = fs.existsSync(file);
    this.stream = fs.createWriteStream(file, { flags: "a" });

    if (!exists) {
      this.stream.write(header.join(",") + "\n");
    }
  }

  append(s: Sample): void {
    const row = [
      new Date(s.ts).toISOString(),
      s.sessionId,
      s.kind,
      s.queueIndex,
      csvEscape(s.url),
      s.state,
      s.currentTime,
      s.duration,
      s.bufferedSec,
      csvEscape(s.quality),
      s.bandwidthMBps,
      s.cpuPercent,
      s.ramMb,
      s.rendererCpuPercent,
      s.jsHeapMb,
      s.stalls,
      s.droppedFrames,
      s.totalFrames,
    ].join(",");

    this.stream.write(row + "\n");
  }

  close(): void {
    this.stream.end();
  }
}

export function csvEscape(value: unknown): string {
  const s = String(value ?? "");

  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}
