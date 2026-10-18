/**
 * Zentrale Grenzwerte. Sie schützen den Rechner (Ressourcen) und verhindern,
 * dass ein einzelner Fehlgriff (z. B. Cron "* * * * *" ohne Laufzeit) beliebig
 * viele Browser-Sessions erzeugt. Die Zahl paralleler Sessions lässt sich per
 * Umgebungsvariable TB_MAX_SESSIONS anpassen (max. hardMaxSessions).
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
  maxSchedules: 50,
  /** Nach so langer Verspätung wird ein Lauf übersprungen statt nachgeholt. */
  missedRunGraceMs: 5 * 60 * 1000,

  defaultMaxSessions: 3,
  hardMaxSessions: 10,

  maxChannelVideos: 25,
  maxBodyBytes: 64 * 1024,
} as const;

export function configuredMaxSessions(
  env: NodeJS.ProcessEnv = process.env
): number {
  const n = Number(env.TB_MAX_SESSIONS);

  if (!Number.isFinite(n) || n < 1) return LIMITS.defaultMaxSessions;

  return Math.min(Math.floor(n), LIMITS.hardMaxSessions);
}
