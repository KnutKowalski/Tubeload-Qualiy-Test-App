import fs from "node:fs";

import { LIMITS } from "./limits";
import { log } from "./log";
import { isAllowedYouTubeUrl } from "./url";
import { writeJsonAtomic } from "./util";
import { ValidationError } from "./validate";

/**
 * Zuletzt verwendete URLs, neueste zuerst. Sie liegen als JSON im Datenordner
 * der App und überleben damit Neustarts. (Im Browser-Speicher ginge das nicht:
 * Electron startet das Dashboard bei jedem Start auf einem anderen Port, und der
 * Browser-Speicher gilt pro Adresse samt Port.)
 */
export class RecentUrls {
  private urls: string[] = [];

  constructor(
    private readonly file?: string,
    private readonly max: number = LIMITS.maxRecentUrls
  ) {
    this.load();
  }

  all(): string[] {
    return [...this.urls];
  }

  /** Merkt sich die URL (an erster Stelle). Ungültige URLs werden abgelehnt. */
  add(raw: unknown): void {
    const url = this.check(raw);

    if (this.urls[0] === url) return;

    this.urls = [url, ...this.urls.filter((u) => u !== url)].slice(0, this.max);
    this.save();
  }

  remove(raw: unknown): boolean {
    if (typeof raw !== "string") return false;

    const url = raw.trim();
    const before = this.urls.length;

    this.urls = this.urls.filter((u) => u !== url);

    if (this.urls.length === before) return false;

    this.save();

    return true;
  }

  private check(raw: unknown): string {
    if (typeof raw !== "string") throw new ValidationError('"url" fehlt.');

    const url = raw.trim();

    if (!url || url.length > LIMITS.maxUrlLength) {
      throw new ValidationError('"url" ist leer oder zu lang.');
    }

    if (!isAllowedYouTubeUrl(url)) {
      throw new ValidationError(
        "Nur https-URLs von youtube.com, m./music.youtube.com und youtu.be sind erlaubt."
      );
    }

    return url;
  }

  private load(): void {
    if (!this.file) return;

    try {
      if (!fs.existsSync(this.file)) return;

      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"));

      if (!Array.isArray(raw)) return;

      const seen = new Set<string>();

      for (const item of raw) {
        if (typeof item !== "string") continue;

        const url = item.trim();

        if (seen.has(url) || url.length > LIMITS.maxUrlLength || !isAllowedYouTubeUrl(url)) {
          continue;
        }

        seen.add(url);
        this.urls.push(url);

        if (this.urls.length >= this.max) break;
      }
    } catch (e) {
      log.warn("recent-urls.json konnte nicht gelesen werden", e);
    }
  }

  private save(): void {
    if (!this.file) return;

    try {
      writeJsonAtomic(this.file, this.urls);
    } catch (e) {
      log.warn("recent-urls.json konnte nicht gespeichert werden", e);
    }
  }
}
