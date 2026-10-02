export type QualityLabel =
  | "auto"
  | "144p"
  | "240p"
  | "360p"
  | "480p"
  | "720p"
  | "1080p"
  | "1440p"
  | "2160p";

export type UrlKind = "auto" | "video" | "playlist" | "channel" | "unknown";

export type ConsentMode = "accept" | "reject" | "none";

export interface SessionConfig {
  id: string;
  url: string;
  kind?: UrlKind;
  quality: QualityLabel;
  humanize: boolean;
  repeat: boolean;
  maxRuntimeSec?: number;
  mute?: boolean;
  consentMode?: ConsentMode;
}

export interface Sample {
  ts: number;
  sessionId: string;
  kind: UrlKind;
  queueIndex: number;
  url: string;
  state: string;
  currentTime: number;
  duration: number;
  bufferedSec: number;
  quality: string;
  bandwidthMBps: number;
  cpuPercent: number;
  ramMb: number;
  rendererCpuPercent: number;
  jsHeapMb: number;
  stalls: number;
  droppedFrames: number;
  totalFrames: number;
}

export interface SessionSummary {
  sessionId: string;
  runtimeSec: number;
  avgBandwidthMBps: number;
  peakBandwidthMBps: number;
  p95BandwidthMBps: number;
  stalls: number;
  stallSeconds: number;
  dominantQuality: string;
  droppedFrameRatio: number;
  finishedAt: number;
}

export interface Schedule {
  id: string;
  cron: string;
  enabled: boolean;
  session: Omit<SessionConfig, "id">;
  lastRun?: number;
  nextRun?: number;
  createdAt: number;
}
