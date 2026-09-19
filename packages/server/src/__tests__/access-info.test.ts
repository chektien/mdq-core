import {
  detectTailscaleUrl,
  generateShortUrl,
  getLanIp,
  generateQrDataUrl,
  detectAccessInfo,
  getCachedAccessInfo,
  setCachedAccessInfo,
  ShortUrlProvider,
  isgdProvider,
} from "../access-info";

// We mock child_process.execSync for tailscale tests
jest.mock("child_process", () => ({
  execSync: jest.fn(),
}));

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

beforeEach(() => {
  mockExecSync.mockReset();
  setCachedAccessInfo(null);
  delete process.env.MDQ_PUBLIC_URL;
  delete process.env.MDQ_DISABLE_TAILSCALE;
});

describe("detectTailscaleUrl", () => {
  it("returns tailscale HTTPS URL when tailscale status succeeds", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        Self: {
          DNSName: "my-laptop.tail1234.ts.net.",
        },
      }),
    );
    const url = detectTailscaleUrl();
    expect(url).toBe("https://my-laptop.tail1234.ts.net");
  });

  it("strips trailing dot from DNSName", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
    );
    expect(detectTailscaleUrl()).toBe("https://host.tailnet.ts.net");
  });

  it("returns null when DNSName is empty", () => {
    mockExecSync.mockReturnValue(JSON.stringify({ Self: { DNSName: "" } }));
    expect(detectTailscaleUrl()).toBeNull();
  });

  it("returns null when Self is missing", () => {
    mockExecSync.mockReturnValue(JSON.stringify({}));
    expect(detectTailscaleUrl()).toBeNull();
  });

  it("returns null when tailscale command is not found", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command not found: tailscale");
    });
    expect(detectTailscaleUrl()).toBeNull();
  });

  it("returns null when tailscale detection is disabled", () => {
    process.env.MDQ_DISABLE_TAILSCALE = "1";
    mockExecSync.mockReturnValue(
      JSON.stringify({ Self: { DNSName: "quiz-host.tailnet.ts.net." } }),
    );

    expect(detectTailscaleUrl()).toBeNull();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("returns null when tailscale times out", () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error("ETIMEDOUT");
      (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
      throw err;
    });
    expect(detectTailscaleUrl()).toBeNull();
  });

  it("returns null when tailscale returns invalid JSON", () => {
    mockExecSync.mockReturnValue("NOT JSON AT ALL");
    expect(detectTailscaleUrl()).toBeNull();
  });
});

describe("generateShortUrl", () => {
  it("returns short URL from a successful provider", async () => {
    const mockProvider: ShortUrlProvider = {
      name: "mock",
      generate: async () => "https://short.url/abc",
    };
    const result = await generateShortUrl("https://example.com", [mockProvider]);
    expect(result).toBe("https://short.url/abc");
  });

  it("tries next provider when first fails", async () => {
    const failProvider: ShortUrlProvider = {
      name: "fail",
      generate: async () => null,
    };
    const goodProvider: ShortUrlProvider = {
      name: "good",
      generate: async () => "https://short.url/xyz",
    };
    const result = await generateShortUrl("https://example.com", [failProvider, goodProvider]);
    expect(result).toBe("https://short.url/xyz");
  });

  it("tries next provider when first throws", async () => {
    const throwProvider: ShortUrlProvider = {
      name: "throw",
      generate: async () => {
        throw new Error("network error");
      },
    };
    const goodProvider: ShortUrlProvider = {
      name: "good",
      generate: async () => "https://short.url/ok",
    };
    const result = await generateShortUrl("https://example.com", [throwProvider, goodProvider]);
    expect(result).toBe("https://short.url/ok");
  });

  it("returns empty string when all providers fail", async () => {
    const failProvider: ShortUrlProvider = {
      name: "fail",
      generate: async () => null,
    };
    const result = await generateShortUrl("https://example.com", [failProvider]);
    expect(result).toBe("");
  });

  it("returns empty string with no providers", async () => {
    const result = await generateShortUrl("https://example.com", []);
    expect(result).toBe("");
  });
});

describe("isgdProvider validation", () => {
  it("rejects HTML error page responses", async () => {
    // Mock fetch to return HTML instead of a short URL
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html><body>Error 500</body></html>",
    });

    const result = await isgdProvider.generate("https://example.com");
    expect(result).toBeNull();

    global.fetch = origFetch;
  });

  it("rejects overly long responses", async () => {
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => "https://example.com/" + "x".repeat(300),
    });

    const result = await isgdProvider.generate("https://example.com");
    expect(result).toBeNull();

    global.fetch = origFetch;
  });

  it("rejects non-HTTP responses", async () => {
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => "Error: Invalid URL",
    });

    const result = await isgdProvider.generate("https://example.com");
    expect(result).toBeNull();

    global.fetch = origFetch;
  });

  it("returns null on non-OK response", async () => {
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await isgdProvider.generate("https://example.com");
    expect(result).toBeNull();

    global.fetch = origFetch;
  });

  it("returns null on network error", async () => {
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    const result = await isgdProvider.generate("https://example.com");
    expect(result).toBeNull();

    global.fetch = origFetch;
  });
});

describe("getLanIp", () => {
  it("returns a valid IP address string", () => {
    const ip = getLanIp();
    // Should be either a real LAN IP or 127.0.0.1 fallback
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("generateQrDataUrl", () => {
  it("returns a data URL for a valid input", async () => {
    const result = await generateQrDataUrl("https://example.com");
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("returns non-empty data URL for any string", async () => {
    const result = await generateQrDataUrl("hello");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("detectAccessInfo", () => {
  it("uses MDQ_PUBLIC_URL when configured", async () => {
    process.env.MDQ_PUBLIC_URL = "https://mdq.example.com/";
    mockExecSync.mockReturnValue(
      JSON.stringify({ Self: { DNSName: "quiz-host.tailnet.ts.net." } }),
    );

    const mockProvider: ShortUrlProvider = {
      name: "mock",
      generate: async () => "https://short.url/mdq",
    };

    const info = await detectAccessInfo(3000, [mockProvider]);
    expect(info.source).toBe("public-override");
    expect(info.fullUrl).toBe("https://mdq.example.com");
    expect(info.shortUrl).toBe("https://short.url/mdq");
    expect(info.qrTargetUrl).toBe("https://mdq.example.com");
    expect(info.warning).toBeUndefined();
  });

  it("returns tailscale source when tailscale is available", async () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ Self: { DNSName: "quiz-host.tailnet.ts.net." } }),
    );

    const mockProvider: ShortUrlProvider = {
      name: "mock",
      generate: async () => "https://short.url/quiz",
    };

    const info = await detectAccessInfo(3000, [mockProvider]);
    expect(info.source).toBe("tailscale");
    expect(info.fullUrl).toBe("https://quiz-host.tailnet.ts.net");
    expect(info.shortUrl).toBe("https://short.url/quiz");
    expect(info.qrTargetUrl).toBe("https://quiz-host.tailnet.ts.net");
    expect(info.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(info.warning).toBeUndefined();
    expect(typeof info.detectedAt).toBe("number");
  });

  it("falls back to LAN when tailscale is unavailable", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command not found");
    });

    const noProvider: ShortUrlProvider = {
      name: "fail",
      generate: async () => null,
    };

    const info = await detectAccessInfo(4000, [noProvider]);
    expect(info.source).toBe("lan-fallback");
    expect(info.fullUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:4000$/);
    expect(info.shortUrl).toBe("");
    expect(info.qrTargetUrl).toBe(info.fullUrl);
    expect(info.warning).toBeDefined();
    expect(info.warning).toContain("Tailscale unavailable");
  });

  it("falls back to LAN when tailscale detection is disabled", async () => {
    process.env.MDQ_DISABLE_TAILSCALE = "true";
    mockExecSync.mockReturnValue(
      JSON.stringify({ Self: { DNSName: "quiz-host.tailnet.ts.net." } }),
    );

    const info = await detectAccessInfo(2081, []);
    expect(info.source).toBe("lan-fallback");
    expect(info.fullUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:2081$/);
    expect(info.warning).toContain("Local/mock mode");
  });

  it("caches access info after detection", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no tailscale");
    });

    expect(getCachedAccessInfo()).toBeNull();

    await detectAccessInfo(3000, []);
    const cached = getCachedAccessInfo();
    expect(cached).not.toBeNull();
    expect(cached!.source).toBe("lan-fallback");
  });

  it("persists access information inside the configured runtime data directory", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no tailscale");
    });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-access-"));

    await detectAccessInfo(3000, [], dataDir);

    expect(fs.existsSync(path.join(dataDir, "access", "current.json"))).toBe(true);
  });

  it("generates QR code even when short URL fails", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no tailscale");
    });

    const info = await detectAccessInfo(3000, []);
    // QR code should still be generated from the full URL
    expect(info.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(info.shortUrl).toBe("");
    expect(info.qrTargetUrl).toBe(info.fullUrl);
  });
});

describe("getCachedAccessInfo / setCachedAccessInfo", () => {
  it("returns null initially", () => {
    expect(getCachedAccessInfo()).toBeNull();
  });

  it("returns cached info after setting", () => {
    const info = {
      fullUrl: "https://test.ts.net",
      shortUrl: "https://t.ly/test",
      qrCodeDataUrl: "data:image/png;base64,abc",
      qrTargetUrl: "https://test.ts.net",
      source: "tailscale" as const,
      detectedAt: Date.now(),
    };
    setCachedAccessInfo(info);
    expect(getCachedAccessInfo()).toBe(info);
  });

  it("can be cleared by setting null", () => {
    setCachedAccessInfo({
      fullUrl: "https://test.ts.net",
      shortUrl: "",
      qrCodeDataUrl: "",
      qrTargetUrl: "https://test.ts.net",
      source: "tailscale",
      detectedAt: Date.now(),
    });
    setCachedAccessInfo(null);
    expect(getCachedAccessInfo()).toBeNull();
  });
});
