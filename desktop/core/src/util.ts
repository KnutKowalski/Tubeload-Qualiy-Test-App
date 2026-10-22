import fs from "node:fs";
import path from "node:path";

import type { QualityLabel } from "./types";

/**
 * Schreibt JSON atomar (temporäre Datei + Umbenennen), damit ein Absturz
 * mitten im Schreiben nie eine halbe Datei hinterlässt.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const tmp = `${file}.tmp`;

  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Wartet ms Millisekunden oder bis das Signal abbricht.
 * Ist das Signal bereits abgebrochen (oder ms ungültig), kehrt die Funktion
 * sofort zurück – ein später feuerndes "abort"-Event gibt es dann nicht mehr.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted || !(ms > 0)) {
      resolve();
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Kurzfassung für Anzeige und CSV: erste nichtleere Zeile ohne ANSI-Farbcodes,
 * höchstens 300 Zeichen. (Playwright hängt an Fehler ein mehrzeiliges "Call log:"
 * mit Steuerzeichen an.)
 */
export function shortError(e: unknown): string {
  const text = errorMessage(e).replace(/\u001b\[[0-9;]*m/g, "");
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? text;

  return first.trim().slice(0, 300);
}

export const QUALITY_CODE: Record<QualityLabel, string> = {
  auto: "default",
  "144p": "tiny",
  "240p": "small",
  "360p": "medium",
  "480p": "large",
  "720p": "hd720",
  "1080p": "hd1080",
  "1440p": "hd1440",
  "2160p": "hd2160",
};

export function qualityToCode(label: QualityLabel): string {
  return QUALITY_CODE[label] ?? "default";
}

/** "720p" -> 720, "auto" -> undefined */
export function qualityHeight(label: QualityLabel): number | undefined {
  const m = /^(\d+)p$/.exec(label);
  return m ? Number(m[1]) : undefined;
}

/**
 * YouTube wählt die Auflösung im Auto-Modus anhand der Playergröße. Damit
 * hohe Stufen überhaupt erreichbar sind, bekommt jede Session einen
 * Viewport im passenden 16:9-Format.
 */
export function viewportFor(label: QualityLabel): { width: number; height: number } {
  const h = qualityHeight(label);

  if (!h) return { width: 1280, height: 720 };

  return { width: Math.round((h * 16) / 9), height: h };
}
