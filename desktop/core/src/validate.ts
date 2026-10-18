import { LIMITS } from "./limits";
import {
  CONSENT_MODES,
  QUALITY_LABELS,
  URL_KINDS,
  type SessionInput,
} from "./types";
import { detectUrlKind, isAllowedYouTubeUrl } from "./url";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ValidationError(`${what} muss ein JSON-Objekt sein.`);
  }

  return v as Record<string, unknown>;
}

function pickEnum<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  def: T[number],
  field: string
): T[number] {
  if (v === undefined || v === null || v === "") return def;

  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
    return v as T[number];
  }

  throw new ValidationError(
    `"${field}" ist ungültig (erlaubt: ${allowed.join(", ")}).`
  );
}

function pickBool(v: unknown, def: boolean, field: string): boolean {
  if (v === undefined || v === null) return def;

  if (typeof v === "boolean") return v;

  throw new ValidationError(`"${field}" muss true oder false sein.`);
}

function pickInt(
  v: unknown,
  def: number,
  min: number,
  max: number,
  field: string
): number {
  if (v === undefined || v === null || v === "") return def;

  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(`"${field}" muss eine Zahl sein.`);
  }

  const n = Math.round(v);

  if (n < min || n > max) {
    throw new ValidationError(`"${field}" muss zwischen ${min} und ${max} liegen.`);
  }

  return n;
}

/** Prüft und normalisiert eine Session-Konfiguration aus untrusted Input (API, schedules.json). */
export function parseSessionInput(raw: unknown): SessionInput {
  const o = asObject(raw, "Session");

  if (typeof o.url !== "string") {
    throw new ValidationError('"url" fehlt.');
  }

  const url = o.url.trim();

  if (!url || url.length > LIMITS.maxUrlLength) {
    throw new ValidationError('"url" ist leer oder zu lang.');
  }

  if (!isAllowedYouTubeUrl(url)) {
    throw new ValidationError(
      "Nur https-URLs von youtube.com, m./music.youtube.com und youtu.be sind erlaubt."
    );
  }

  const forced = pickEnum(o.kind, URL_KINDS, "auto", "kind");
  const detected = detectUrlKind(url);

  if (detected === "unknown") {
    throw new ValidationError(
      "Die URL konnte nicht als Video, Playlist oder Kanal erkannt werden."
    );
  }

  if (forced !== "auto" && forced !== detected) {
    throw new ValidationError(
      `Die URL passt nicht zum Typ "${forced}" (erkannt: "${detected}").`
    );
  }

  return {
    url,
    kind: detected,
    quality: pickEnum(o.quality, QUALITY_LABELS, "auto", "quality"),
    repeat: pickBool(o.repeat, false, "repeat"),
    maxLoops: pickInt(o.maxLoops, LIMITS.defaultLoops, 1, LIMITS.maxLoops, "maxLoops"),
    maxRuntimeSec: pickInt(
      o.maxRuntimeSec,
      LIMITS.defaultRuntimeSec,
      LIMITS.minRuntimeSec,
      LIMITS.maxRuntimeSec,
      "maxRuntimeSec"
    ),
    startTimeoutSec: pickInt(
      o.startTimeoutSec,
      LIMITS.defaultStartTimeoutSec,
      LIMITS.minStartTimeoutSec,
      LIMITS.maxStartTimeoutSec,
      "startTimeoutSec"
    ),
    mute: pickBool(o.mute, true, "mute"),
    consentMode: pickEnum(o.consentMode, CONSENT_MODES, "reject", "consentMode"),
  };
}
