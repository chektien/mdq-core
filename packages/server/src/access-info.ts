import { AccessInfo, DATA_DIR } from "@mdq/shared";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Tailscale detection ─────────────────────

interface TailscaleStatus {
  Self?: {
    DNSName?: string;
  };
}

function isTailscaleDetectionDisabled(): boolean {
  const value = (process.env.MDQ_DISABLE_TAILSCALE || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

/**
 * Detect the Tailscale Funnel URL by calling `tailscale status --json`.
 * Returns the DNS name (e.g., "my-laptop.tailnet.ts.net") or null if unavailable.
 */
export function detectTailscaleUrl(): string | null {
  if (isTailscaleDetectionDisabled()) {
    return null;
  }

  const configuredUrl = (process.env.MDQ_PUBLIC_URL || process.env.PUBLIC_URL || "").trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, "");
  }

  try {
    const output = execSync("tailscale status --json", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const status: TailscaleStatus = JSON.parse(output);
    const dnsName = status?.Self?.DNSName;

    if (dnsName) {
      // DNSName usually ends with a trailing dot; remove it
      const cleanName = dnsName.replace(/\.$/, "");
      return `https://${cleanName}`;
    }

    return null;
  } catch {
    // tailscale CLI not installed, not running, or timed out
    return null;
  }
}

function normalizePublicUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// ── Short URL generation ────────────────────

export interface ShortUrlProvider {
  name: string;
  generate: (longUrl: string) => Promise<string | null>;
}

/**
 * is.gd provider (free, no API key, no ads).
 */
export const isgdProvider: ShortUrlProvider = {
  name: "is.gd",
  generate: async (longUrl: string): Promise<string | null> => {
    try {
      const apiUrl = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`;
      const response = await fetch(apiUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const shortUrl = (await response.text()).trim();
      // Validate it looks like a URL (not HTML error page or other junk)
      if (
        shortUrl.startsWith("http") &&
        !shortUrl.includes("<") &&
        shortUrl.length < 200
      ) {
        return shortUrl;
      }
      return null;
    } catch {
      return null;
    }
  },
};

/**
 * Generate a short URL using provider abstraction with fallback.
 * Returns the short URL or empty string if all providers fail.
 */
export async function generateShortUrl(
  longUrl: string,
  providers: ShortUrlProvider[] = [isgdProvider],
): Promise<string> {
  for (const provider of providers) {
    try {
      const result = await provider.generate(longUrl);
      if (result) return result;
    } catch {
      // Try next provider
    }
  }
  return "";
}

// ── LAN IP detection ────────────────────────

/**
 * Get the first non-internal IPv4 address.
 */
export function getLanIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

// ── QR code generation ──────────────────────

/**
 * Generate a QR code data URL for a given URL.
 * Uses the `qrcode` npm package if available, otherwise returns empty string.
 */
export async function generateQrDataUrl(url: string): Promise<string> {
  try {
    // Dynamic import to avoid hard dependency
    const QRCode = await import("qrcode");
    const dataUrl = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    return dataUrl;
  } catch {
    return "";
  }
}

// ── Access info service ─────────────────────

let cachedAccessInfo: AccessInfo | null = null;

/**
 * Detect and build access info on startup.
 * Caches the result for subsequent calls.
 */
export async function detectAccessInfo(
  port: number,
  shortUrlProviders?: ShortUrlProvider[],
  dataDir = path.resolve(process.cwd(), process.env.MDQ_DATA_DIR?.trim() || DATA_DIR),
): Promise<AccessInfo> {
  const publicOverrideUrl = normalizePublicUrl(process.env.MDQ_PUBLIC_URL);

  // Try Tailscale first
  const tailscaleUrl = detectTailscaleUrl();

  let fullUrl: string;
  let source: AccessInfo["source"];
  let warning: string | undefined;

  if (publicOverrideUrl) {
    fullUrl = publicOverrideUrl;
    source = "public-override";
  } else if (tailscaleUrl) {
    fullUrl = tailscaleUrl;
    source = "tailscale";
  } else {
    const lanIp = getLanIp();
    fullUrl = `http://${lanIp}:${port}`;
    source = "lan-fallback";
    warning = isTailscaleDetectionDisabled()
      ? "Local/mock mode: Tailscale detection is disabled for this run."
      : "Tailscale unavailable. Students on isolated campus WiFi may not be able to connect.";
  }

  // Generate short URL
  const shortUrl = await generateShortUrl(fullUrl, shortUrlProviders);

  // Generate QR code from direct service URL (no shortener interstitial).
  const qrTargetUrl = fullUrl;
  const qrCodeDataUrl = await generateQrDataUrl(qrTargetUrl);

  const info: AccessInfo = {
    fullUrl,
    shortUrl,
    qrCodeDataUrl,
    qrTargetUrl,
    source,
    warning,
    detectedAt: Date.now(),
  };

  // Cache it
  cachedAccessInfo = info;

  // Persist to disk
  try {
    const accessDir = path.join(path.resolve(dataDir), "access");
    if (!fs.existsSync(accessDir)) {
      fs.mkdirSync(accessDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(accessDir, "current.json"),
      JSON.stringify(info, null, 2),
      "utf-8",
    );
  } catch {
    // Non-fatal: persistence is best-effort
  }

  return info;
}

/**
 * Get the cached access info, or detect if not yet cached.
 */
export function getCachedAccessInfo(): AccessInfo | null {
  return cachedAccessInfo;
}

/**
 * Set cached access info (for testing).
 */
export function setCachedAccessInfo(info: AccessInfo | null): void {
  cachedAccessInfo = info;
}
