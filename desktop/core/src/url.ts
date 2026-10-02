import type { UrlKind } from "./types";

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function detectUrlKind(raw: string, forced: UrlKind = "auto"): UrlKind {
  if (forced && forced !== "auto") return forced;

  const u = parseUrl(raw);
  if (!u) return "unknown";

  const path = u.pathname;
  const list = u.searchParams.get("list");
  const v = u.searchParams.get("v");

  if (path.startsWith("/playlist") || list) return "playlist";

  if (
    v ||
    u.hostname === "youtu.be" ||
    path.startsWith("/shorts/") ||
    path.startsWith("/embed/")
  ) {
    return "video";
  }

  if (
    /\/channel\/UC[0-9A-Za-z_-]{22}/.test(path) ||
    path.startsWith("/@") ||
    path.startsWith("/c/") ||
    path.startsWith("/user/")
  ) {
    return "channel";
  }

  return "unknown";
}

export function extractVideoId(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return null;

  const v = u.searchParams.get("v");
  if (v) return v;

  if (u.hostname === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return id || null;
  }

  if (u.pathname.startsWith("/shorts/")) {
    return u.pathname.split("/")[2] || null;
  }

  if (u.pathname.startsWith("/embed/")) {
    return u.pathname.split("/")[2] || null;
  }

  return null;
}

export function extractPlaylistId(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return null;
  return u.searchParams.get("list");
}

export function extractChannelId(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return null;

  const m = u.pathname.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
  return m?.[1] ?? null;
}

export function uploadsPlaylistIdFromChannelId(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

export function toWatchPlaylistUrl(playlistId: string, index = 1): string {
  return `https://www.youtube.com/watch?list=${encodeURIComponent(
    playlistId
  )}&index=${index}`;
}
