export const QUALITY_LABELS = [
  "auto",
  "144p",
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
  "1440p",
  "2160p",
] as const;

export type QualityLabel = (typeof QUALITY_LABELS)[number];

export const URL_KINDS = [
  "auto",
  "video",
  "playlist",
  "channel",
  "unknown",
] as const;

export type UrlKind = (typeof URL_KINDS)[number];

export const CONSENT_MODES = ["accept", "reject", "none"] as const;

export type ConsentMode = (typeof CONSENT_MODES)[number];

export const INTERACTION_ACTIONS = ["pause", "seek", "next", "previous"] as const;

export type InteractionAction = (typeof INTERACTION_ACTIONS)[number];

/**
 * Ein Schritt des Interaktionsskripts. Der Ablauf ist fest vorgegeben und bei
 * jedem Lauf identisch (kein Zufall), damit sich Messungen vergleichen lassen.
 */
export interface InteractionStep {
  /** Sekunden seit Beginn der Wiedergabe des Durchlaufs. */
  at: number;
  action: InteractionAction;
  /** pause: Dauer in Sekunden; seek: Sprung in Sekunden (negativ = zurück). */
  value?: number;
}

export interface InteractionResult {
  /** 1-basierter Durchlauf (bei Wiederholungen läuft das Skript je Durchlauf). */
  loop: number;
  /** Geplante Sekunde laut Skript. */
  at: number;
  /** Tatsächlich gestartet, Sekunden seit Beginn des Durchlaufs. */
  startedAtSec: number;
  action: InteractionAction;
  value?: number;
  status: "ok" | "failed" | "skipped";
  /** Zeit bis die Wiedergabe nach der Aktion wieder läuft; -1 = nicht gemessen. */
  recoveryMs: number;
  note?: string;
}

export type SessionState =
  | "starting"
  | "idle"
  | "buffering"
  | "playing"
  | "paused"
  | "ended"
  | "error"
  | "blocked"
  | "no_video"
  | "not_playing"
  | "stopped";

export type EndReason =
  | "completed"
  | "stopped"
  | "max_runtime"
  | "blocked"
  | "error"
  | "shutdown";

export interface SessionConfig {
  id: string;
  url: string;
  /** Bereits aufgelöst (nie "auto"). */
  kind: UrlKind;
  quality: QualityLabel;
  /** Nach dem Ende erneut abspielen (höchstens maxLoops Durchläufe). */
  repeat: boolean;
  maxLoops: number;
  maxRuntimeSec: number;
  startTimeoutSec: number;
  mute: boolean;
  consentMode: ConsentMode;
  /** Festes Interaktionsskript (leer = keine Interaktionen). */
  interactions: InteractionStep[];
}

export interface Sample {
  ts: number;
  sessionId: string;
  kind: UrlKind;
  queueIndex: number;
  url: string;
  state: SessionState;
  currentTime: number;
  duration: number;
  bufferedSec: number;
  /** Tatsächlich gemessene Auflösung, z. B. "720p" (aus videoHeight). */
  quality: string;
  width: number;
  height: number;
  bandwidthMBps: number;
  /** CPU/RAM des gesamten Browsers (alle Prozesse), nicht pro Session. */
  cpuPercent: number;
  ramMb: number;
  rendererCpuPercent: number;
  jsHeapMb: number;
  /** Kumulativ innerhalb des aktuellen Seitenladevorgangs. */
  stalls: number;
  stallSec: number;
  /** Zeit vom Seitenaufruf bis zur ersten Wiedergabe, -1 = unbekannt. */
  startupMs: number;
  droppedFrames: number;
  totalFrames: number;
  note?: string;
}

export interface SessionSummary {
  sessionId: string;
  runtimeSec: number;
  avgBandwidthMBps: number;
  peakBandwidthMBps: number;
  p95BandwidthMBps: number;
  stalls: number;
  stallSeconds: number;
  /** Stallzeit / (Wiedergabezeit + Stallzeit), 0..1 */
  rebufferRatio: number;
  /** -1 = unbekannt */
  startupMs: number;
  dominantQuality: string;
  droppedFrameRatio: number;
  endReason: EndReason;
  note: string;
  finishedAt: number;
  /** Ergebnisse des Interaktionsskripts (nur wenn eines lief). */
  interactions?: InteractionResult[];
}

export type SessionInput = Omit<SessionConfig, "id">;

export interface Schedule {
  id: string;
  cron: string;
  enabled: boolean;
  session: SessionInput;
  lastRun?: number;
  nextRun?: number;
  lastError?: string;
  lastSessionId?: string;
  createdAt: number;
}
