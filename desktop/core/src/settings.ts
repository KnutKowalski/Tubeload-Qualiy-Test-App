import { EventEmitter } from "node:events";
import fs from "node:fs";

import { LIMITS, configuredMaxSessions } from "./limits";
import { log } from "./log";
import { errorMessage, writeJsonAtomic } from "./util";
import { ValidationError, type SessionDefaults } from "./validate";

/**
 * Vom Nutzer einstellbare Werte. Sie gelten für neue Sessions und Zeitpläne;
 * bereits laufende Sessions bleiben unverändert. Die festen Obergrenzen
 * (SETTING_BOUNDS, abgeleitet aus LIMITS) lassen sich nicht überschreiten – sie
 * schützen den Rechner vor Überlastung.
 */
export interface Settings {
  /** Gleichzeitig laufende Sessions. */
  maxSessions: number;
  /** Durchläufe, wenn "Wiederholen" gewählt und keine Zahl angegeben ist. */
  defaultLoops: number;
  /** Maximale Laufzeit einer Session in Minuten, wenn keine angegeben ist. */
  defaultRuntimeMin: number;
  /** Mindestabstand zwischen zwei Läufen eines Zeitplans in Minuten. */
  minScheduleIntervalMin: number;
}

export const SETTING_KEYS = [
  "maxSessions",
  "defaultLoops",
  "defaultRuntimeMin",
  "minScheduleIntervalMin",
] as const satisfies readonly (keyof Settings)[];

export const SETTING_BOUNDS: Record<keyof Settings, { min: number; max: number }> = {
  maxSessions: { min: 1, max: LIMITS.hardMaxSessions },
  defaultLoops: { min: 1, max: LIMITS.maxLoops },
  defaultRuntimeMin: { min: 1, max: Math.floor(LIMITS.maxRuntimeSec / 60) },
  minScheduleIntervalMin: { min: LIMITS.absoluteMinScheduleIntervalSec / 60, max: 60 },
};

const LABELS: Record<keyof Settings, string> = {
  maxSessions: "Parallele Sessions",
  defaultLoops: "Standard-Läufe",
  defaultRuntimeMin: "Standard-Laufzeit (Minuten)",
  minScheduleIntervalMin: "Mindestabstand der Zeitplan-Läufe (Minuten)",
};

export function defaultSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    maxSessions: configuredMaxSessions(env),
    defaultLoops: LIMITS.defaultLoops,
    defaultRuntimeMin: Math.round(LIMITS.defaultRuntimeSec / 60),
    minScheduleIntervalMin: Math.round(LIMITS.minScheduleIntervalSec / 60),
  };
}

/** Standardwerte für neue Sessions, abgeleitet aus den Einstellungen. */
export function sessionDefaultsFrom(s: Settings): SessionDefaults {
  return { loops: s.defaultLoops, runtimeSec: s.defaultRuntimeMin * 60 };
}

function checkValue(key: keyof Settings, v: unknown): number {
  const { min, max } = SETTING_BOUNDS[key];

  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ValidationError(`"${LABELS[key]}" muss eine ganze Zahl sein.`);
  }

  if (v < min || v > max) {
    throw new ValidationError(`"${LABELS[key]}" muss zwischen ${min} und ${max} liegen.`);
  }

  return v;
}

/**
 * Hält die Einstellungen im Speicher und (optional) in einer JSON-Datei.
 * Events: "change" (settings: Settings)
 */
export class SettingsStore extends EventEmitter {
  private current: Settings;

  constructor(
    private readonly file?: string,
    private readonly defaults: Settings = defaultSettings()
  ) {
    super();
    this.current = { ...defaults };
    this.load();
  }

  get(): Settings {
    return { ...this.current };
  }

  getDefaults(): Settings {
    return { ...this.defaults };
  }

  /**
   * Übernimmt die angegebenen Felder (Teilaktualisierung). Unbekannte Felder
   * und Werte außerhalb der Grenzen werden abgelehnt, ohne etwas zu ändern.
   */
  update(raw: unknown): Settings {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ValidationError("Einstellungen müssen ein JSON-Objekt sein.");
    }

    const o = raw as Record<string, unknown>;

    for (const k of Object.keys(o)) {
      if (!(SETTING_KEYS as readonly string[]).includes(k)) {
        throw new ValidationError(`Unbekannte Einstellung "${k}".`);
      }
    }

    const next: Settings = { ...this.current };

    for (const key of SETTING_KEYS) {
      if (o[key] !== undefined) next[key] = checkValue(key, o[key]);
    }

    this.current = next;
    this.save();
    this.emit("change", this.get());

    return this.get();
  }

  reset(): Settings {
    this.current = { ...this.defaults };
    this.save();
    this.emit("change", this.get());

    return this.get();
  }

  private load(): void {
    if (!this.file) return;

    try {
      if (!fs.existsSync(this.file)) return;

      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"));

      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;

      const o = raw as Record<string, unknown>;

      // Feld für Feld: ein ungültiger Wert verwirft nicht die übrigen.
      for (const key of SETTING_KEYS) {
        if (o[key] === undefined) continue;

        try {
          this.current[key] = checkValue(key, o[key]);
        } catch (e) {
          log.warn(`settings.json: ${errorMessage(e)} Standardwert wird verwendet.`);
        }
      }
    } catch (e) {
      log.warn("settings.json konnte nicht gelesen werden", e);
    }
  }

  private save(): void {
    if (!this.file) return;

    try {
      writeJsonAtomic(this.file, this.current);
    } catch (e) {
      log.error("settings.json konnte nicht gespeichert werden", e);
    }
  }
}
