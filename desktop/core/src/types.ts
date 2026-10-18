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
