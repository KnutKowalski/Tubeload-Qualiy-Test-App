/**
 * Zentrale Grenzwerte. Sie schützen den Rechner (Ressourcen) und verhindern,
 * dass ein einzelner Fehlgriff (z. B. Cron "* * * * *" ohne Laufzeit) beliebig
 * viele Browser-Sessions erzeugt. Die Werte hier sind die FESTEN Obergrenzen bzw.
 * Standardwerte; Läufe, Laufzeit und Zeitplan-Abstand stellt der Nutzer in den
 * Einstellungen ein (siehe settings.ts), nie über diese Obergrenzen hinaus.
 * Die Zahl paralleler Sessions hat bewusst KEINE feste Obergrenze: sie richtet sich nach
 * der Auslastung des Rechners und wird in den Einstellungen frei gewählt.
 * TB_MAX_SESSIONS liefert nur den Startwert dafür.
 */
export const LIMITS = {
  maxUrlLength: 2048,

  defaultLoops: 3,
  maxLoops: 10,

  minRuntimeSec: 30,
  defaultRuntimeSec: 30 * 60,
  maxRuntimeSec: 4 * 60 * 60,

  minStartTimeoutSec: 5,
  defaultStartTimeoutSec: 45,
  maxStartTimeoutSec: 120,

  minScheduleIntervalSec: 5 * 60,
  /** Feste Untergrenze, die auch die Einstellung nicht unterschreiten kann (verbietet Sekunden-Crons). */
  absoluteMinScheduleIntervalSec: 60,
  maxSchedules: 50,
  /** Nach so langer Verspätung wird ein Lauf übersprungen statt nachgeholt. */
  missedRunGraceMs: 5 * 60 * 1000,

  defaultMaxSessions: 3,

  maxChannelVideos: 25,
  maxBodyBytes: 64 * 1024,

  /** Zuletzt verwendete URLs, die dauerhaft gemerkt werden. */
  maxRecentUrls: 50,

  /** Interaktionsskript: fest vorgegebene Schritte, kein Zufall. */
  maxInteractionSteps: 50,
  /** Mindestabstand zwischen zwei Schritten (nach Ende einer Pause). */
  minInteractionGapSec: 2,
  maxPauseSec: 120,
  maxSeekSec: 600,
  /** So lange wird nach einer Aktion auf die Wiederaufnahme der Wiedergabe gewartet. */
  interactionRecoveryTimeoutSec: 20,
} as const;

export function configuredMaxSessions(
  env: NodeJS.ProcessEnv = process.env
): number {
  const n = Number(env.TB_MAX_SESSIONS);

  if (!Number.isFinite(n) || n < 1) return LIMITS.defaultMaxSessions;

  const whole = Math.floor(n);

  return Number.isSafeInteger(whole) ? whole : LIMITS.defaultMaxSessions;
}
