import { EventEmitter } from "node:events";
import fs from "node:fs";

import { LIMITS, configuredMaxSessions } from "./limits";
import { log } from "./log";
import { errorMessage, writeJsonAtomic } from "./util";
import { StorageError, ValidationError } from "./errors";
import type { SessionDefaults } from "./validate";

/**
 * Vom Nutzer einstellbare Werte. Sie gelten für neue Sessions und Zeitpläne;
 * bereits laufende Sessions bleiben unverändert. Die festen Obergrenzen
 * (SETTING_BOUNDS, abgeleitet aus LIMITS) lassen sich nicht überschreiten – sie
 * schützen den Rechner vor Überlastung. Nur die Zahl paralleler Sessions ist nach
 * oben frei (max: null); sie richtet sich nach der Auslastung des Rechners, und 0
 * bedeutet "unbegrenzt" (keine Sperre).
 */
export interface Settings {
  /** Gleichzeitig laufende Sessions; 0 = unbegrenzt. */
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

/** max: null bedeutet "keine feste Obergrenze". */
export interface SettingBounds {
  min: number;
  max: number | null;
}

export const SETTING_BOUNDS: Record<keyof Settings, SettingBounds> = {
  maxSessions: { min: 0, max: null },
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

  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isSafeInteger(v)) {
    throw new ValidationError(`"${LABELS[key]}" muss eine ganze Zahl sein.`);
  }

  if (v < min || (max !== null && v > max)) {
    throw new ValidationError(
      max === null
        ? `"${LABELS[key]}" muss mindestens ${min} sein${key === "maxSessions" ? " (0 = unbegrenzt)" : ""}.`
        : `"${LABELS[key]}" muss zwischen ${min} und ${max} liegen.`
    );
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

    return this.commit(next);
  }

  reset(): Settings {
    return this.commit({ ...this.defaults });
  }

  /** Übernimmt die Werte erst, wenn sie gespeichert sind: kein vorgetäuschter Erfolg. */
  private commit(next: Settings): Settings {
    const previous = this.current;

    this.current = next;

    try {
      this.save();
    } catch (e) {
      this.current = previous;

      throw new StorageError(`Einstellungen konnten nicht gespeichert werden: ${errorMessage(e)}`);
    }

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

    writeJsonAtomic(this.file, this.current);
  }
}
