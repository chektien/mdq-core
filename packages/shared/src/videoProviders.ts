/**
 * Provider adapters for externally hosted video. Each adapter is a small pure
 * function that takes a parsed URL and returns a playable target, or null when
 * the URL is not one of its forms. Only https is accepted, hosts are matched
 * exactly (never by suffix), and every ID is checked against a strict pattern.
 */

export type VideoProvider = "youtube" | "vimeo" | "file";

export interface VideoTarget {
  provider: VideoProvider;
  /** The player address to load in an iframe (YouTube and Vimeo). */
  embedUrl?: string;
  /** The address of a direct video file, played with a native video element. */
  fileUrl?: string;
  /** Where playback starts, in whole seconds. Only present when it is above zero. */
  startSeconds?: number;
}

export type VideoUrlResult =
  | { ok: true; target: VideoTarget }
  | { ok: false; reason: string };

/** The forms a deck author can use, worded for a diagnostic. */
export const SUPPORTED_VIDEO_FORMS =
  "https://www.youtube.com/watch?v=ID, https://youtu.be/ID, https://www.youtube.com/shorts/ID, " +
  "https://www.youtube.com/embed/ID, https://vimeo.com/ID (or https://vimeo.com/ID/HASH for an unlisted video), " +
  "or a direct https link to a .mp4, .webm, .m4v or .mov file";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^[0-9]{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{8,16}$/;
const VIDEO_FILE = /\.(mp4|webm|m4v|mov)$/i;
const MAX_START_SECONDS = 359999;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_SHORT_HOST = "youtu.be";
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com"]);
const VIMEO_PLAYER_HOST = "player.vimeo.com";

export const VIDEO_PROVIDER_NAMES: Record<VideoProvider, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  file: "Video file",
};

/** The name shown for a provider. A direct file shows the host it comes from. */
export function videoProviderName(provider: VideoProvider, url?: string): string {
  if (provider === "file" && url) {
    try {
      return new URL(url).hostname;
    } catch {
      return VIDEO_PROVIDER_NAMES.file;
    }
  }
  return VIDEO_PROVIDER_NAMES[provider];
}

/** Reads a YouTube start time: 90, 90s, 1m30s or 1h2m3s. Returns 0 when it is not a time. */
export function parseStartSeconds(value: string | null | undefined): number {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return 0;
  let seconds = 0;
  if (/^[0-9]{1,6}s?$/.test(text)) {
    seconds = Number.parseInt(text, 10);
  } else {
    const match = text.match(/^(?:([0-9]{1,3})h)?(?:([0-9]{1,4})m)?(?:([0-9]{1,6})s)?$/);
    if (!match || (!match[1] && !match[2] && !match[3])) return 0;
    seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return seconds > 0 && seconds <= MAX_START_SECONDS ? seconds : 0;
}

/** YouTube: watch?v=ID, youtu.be/ID, shorts/ID and embed/ID, on the plain, www and m hosts. Played through the no-cookie player. */
export function youtubeTarget(url: URL): VideoTarget | null {
  const host = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (host === YOUTUBE_SHORT_HOST) {
    if (parts.length === 1) id = parts[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? undefined;
    else if (parts.length === 2 && (parts[0] === "shorts" || parts[0] === "embed")) id = parts[1];
  } else {
    return null;
  }
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const startSeconds = parseStartSeconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
  const embedUrl = `https://www.youtube-nocookie.com/embed/${id}${startSeconds > 0 ? `?start=${startSeconds}` : ""}`;
  return { provider: "youtube", embedUrl, ...(startSeconds > 0 ? { startSeconds } : {}) };
}

/** Vimeo: vimeo.com/ID, vimeo.com/ID/HASH for an unlisted video, and player.vimeo.com/video/ID (with h=HASH). Played with do-not-track on. */
export function vimeoTarget(url: URL): VideoTarget | null {
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let hash: string | undefined;
  if (VIMEO_HOSTS.has(url.hostname)) {
    if (parts.length === 1) id = parts[0];
    else if (parts.length === 2) [id, hash] = parts;
  } else if (url.hostname === VIMEO_PLAYER_HOST) {
    if (parts.length === 2 && parts[0] === "video") {
      id = parts[1];
      hash = url.searchParams.get("h") ?? undefined;
    }
  } else {
    return null;
  }
  if (!id || !VIMEO_ID.test(id)) return null;
  if (hash !== undefined && !VIMEO_HASH.test(hash)) return null;
  const query = `${hash ? `h=${hash}&` : ""}dnt=1`;
  return { provider: "vimeo", embedUrl: `https://player.vimeo.com/video/${id}?${query}` };
}

/** A direct https link to a .mp4, .webm, .m4v or .mov file. A query string is allowed. */
export function fileTarget(url: URL): VideoTarget | null {
  if (!VIDEO_FILE.test(url.pathname)) return null;
  return { provider: "file", fileUrl: url.href };
}

/**
 * Turns a link into a playable target, or says why it cannot. Anything that is
 * not https, carries a login, names another host or has a bad ID is refused.
 */
export function resolveVideoUrl(raw: string): VideoUrlResult {
  const supported = `Supported forms: ${SUPPORTED_VIDEO_FORMS}.`;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `"${raw.trim()}" is not a complete web address. ${supported}` };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `Only https video links are supported, so this one stays an ordinary link. ${supported}` };
  }
  if (url.username || url.password || url.port) {
    return { ok: false, reason: `A video link cannot carry a login or a port, so this one stays an ordinary link. ${supported}` };
  }
  const target = youtubeTarget(url) ?? vimeoTarget(url) ?? fileTarget(url);
  if (target) return { ok: true, target };
  return {
    ok: false,
    reason: `${url.hostname} is not a supported video address, or its video ID is not valid, so this stays an ordinary link. ${supported}`,
  };
}
