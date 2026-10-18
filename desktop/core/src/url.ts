import type { UrlKind } from "./types";

/** Erlaubte Hosts. Alles andere (file://, interne IPs, fremde Seiten) wird abgelehnt. */
const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isAllowedYouTubeUrl(raw: string): boolean {
  const u = parseUrl(raw);

  if (!u) return false;
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;

  return ALLOWED_HOSTS.has(u.hostname);
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

export function extractPlaylistId(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return null;
  return u.searchParams.get("list");
}

/** Video-ID aus einer Watch-/Shorts-/Embed-/youtu.be-URL (für Fortschrittserkennung). */
export function videoIdOf(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return null;

  const v = u.searchParams.get("v");
  if (v) return v;

  if (u.hostname === "youtu.be") {
    return u.pathname.slice(1).split("/")[0] || null;
  }

  const m = /^\/(?:shorts|embed)\/([^/]+)/.exec(u.pathname);
  return m?.[1] ?? null;
}

export function toWatchPlaylistUrl(playlistId: string, index = 1): string {
  return `https://www.youtube.com/watch?list=${encodeURIComponent(
    playlistId
  )}&index=${index}`;
}

/**
 * Bildet die "Videos"-Tab-URL eines Kanals. Query und Fragment (z. B. das
 * "?si=…" aus Teilen-Links) werden verworfen, sonst entstünde "…?si=x/videos".
 */
export function channelVideosUrl(raw: string): string {
  const u = parseUrl(raw);

  if (!u) throw new Error("Ungültige Kanal-URL.");

  let path = u.pathname.replace(/\/+$/, "");

  if (!/\/videos$/.test(path)) path += "/videos";

  return `${u.origin}${path}`;
}
