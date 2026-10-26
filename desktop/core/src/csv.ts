import fs from "node:fs";
import path from "node:path";
import type { Sample } from "./types";
import { log } from "./log";

const HEADER = [
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
  "width",
  "height",
  "bandwidthMBps",
  "cpuPercent",
  "ramMb",
  "rendererCpuPercent",
  "jsHeapMb",
  "stalls",
  "stallSec",
  "startupMs",
  "droppedFrames",
  "totalFrames",
  "note",
];

/**
 * Escaped einen CSV-Wert. Strings, die mit =, +, -, @, Tab oder CR beginnen,
 * bekommen ein führendes ' (Schutz vor Formel-Injection in Excel/Calc).
 * Zahlen werden nie verändert.
 */
export function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);

  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }

  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

function num(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "";
}

export class CsvWriter {
  private stream: fs.WriteStream | null = null;
  private bytes = 0;
  private broken = false;

  /** maxBytes: bei Überschreitung wird die Datei umbenannt und neu begonnen. */
  constructor(
    private readonly file: string,
    private readonly maxBytes = 50 * 1024 * 1024
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.open();
  }

  private open(): void {
    const exists = fs.existsSync(this.file);
    this.bytes = exists ? fs.statSync(this.file).size : 0;

    if (this.bytes >= this.maxBytes) {
      this.rotate();
    }

    // Datei synchron anlegen, damit eine direkt folgende Rotation sie findet.
    const fd = fs.openSync(this.file, "a");
    const stream = fs.createWriteStream(this.file, { fd, flags: "a" });

    // Ohne Error-Handler würde z. B. "Platte voll" den ganzen Prozess beenden.
    stream.on("error", (e) => {
      this.broken = true;
      log.error("CSV-Schreibfehler – Export wird deaktiviert", e);
    });

    this.stream = stream;

    if (this.bytes === 0) {
      this.write(HEADER.join(",") + "\n");
    }
  }

  private rotate(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = this.file.replace(/\.csv$/i, "") + `-${stamp}.csv`;

    try {
      fs.renameSync(this.file, target);
    } catch (e) {
      log.warn("CSV-Rotation fehlgeschlagen", e);
    }

    this.bytes = 0;
  }

  private write(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
    this.stream?.write(chunk);
  }

  append(s: Sample): void {
    if (this.broken || !this.stream) return;

    const line =
      [
        new Date(s.ts).toISOString(),
        csvEscape(s.sessionId),
        csvEscape(s.kind),
        s.queueIndex,
        csvEscape(s.url),
        csvEscape(s.state),
        num(s.currentTime),
        num(s.duration),
        num(s.bufferedSec),
        csvEscape(s.quality),
        s.width,
        s.height,
        num(s.bandwidthMBps),
        num(s.cpuPercent),
        num(s.ramMb),
        num(s.rendererCpuPercent),
        num(s.jsHeapMb),
        s.stalls,
        num(s.stallSec),
        s.startupMs,
        s.droppedFrames,
        s.totalFrames,
        csvEscape(s.note ?? ""),
      ].join(",") + "\n";

    if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
      this.stream.end();
      this.rotate();
      this.open();
    }

    this.write(line);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const s = this.stream;
      this.stream = null;

      if (!s) {
        resolve();
        return;
      }

      s.end(() => resolve());
    });
  }
}
