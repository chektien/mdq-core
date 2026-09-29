import fs from "fs";
import path from "path";
import { readServedAppearance, resolveBootAppearance, resolveClientPalette, systemFallbackTheme } from "../../../client/src/appearance";
import { settleWithin } from "../../../client/src/boot";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

describe("client boot appearance", () => {
  it("keeps supported theme and palette attributes served on <html>", () => {
    expect(readServedAppearance({ theme: "light", palette: "gruvbox" })).toEqual({ theme: "light", palette: "gruvbox" });
    expect(readServedAppearance({ theme: "sepia", palette: "neon" })).toEqual({ theme: undefined, palette: undefined });
    expect(readServedAppearance({})).toEqual({ theme: undefined, palette: undefined });
  });

  it("keeps every supported palette served on <html> and ignores the rest", () => {
    for (const palette of ["classic", "gruvbox", "rose-pine", "catppuccin", "seoul256", "ayu", "tokyo-night"]) {
      expect(readServedAppearance({ palette })).toEqual({ theme: undefined, palette });
      expect(resolveClientPalette(palette)).toBe(palette);
    }
    for (const palette of ["rosepine", "Tokyo-Night", "mocha", "", undefined, 3]) {
      expect(resolveClientPalette(palette)).toBe("classic");
      expect(resolveClientPalette(palette, "ayu")).toBe("ayu");
    }
    expect(readServedAppearance({ palette: "rosepine" })).toEqual({ theme: undefined, palette: undefined });
    expect(resolveBootAppearance({}, { palette: "catppuccin" })).toEqual({ theme: "dark", palette: "catppuccin" });
    expect(resolveBootAppearance({ palette: "seoul256" }, { palette: "ayu" })).toEqual({ theme: "dark", palette: "seoul256" });
    expect(resolveBootAppearance({}, { palette: "unknown" })).toEqual({ theme: "dark", palette: "classic" });
  });

  it("prefers served attributes over the runtime config", () => {
    expect(resolveBootAppearance({ theme: "light", palette: "gruvbox" }, { theme: "dark", palette: "classic" })).toEqual({
      theme: "light",
      palette: "gruvbox",
    });
  });

  it("uses the runtime config when nothing was served", () => {
    expect(resolveBootAppearance({}, { theme: "light", palette: "gruvbox" })).toEqual({ theme: "light", palette: "gruvbox" });
  });

  it("falls back to dark classic when neither source is usable", () => {
    expect(resolveBootAppearance({}, { theme: "bogus" })).toEqual({ theme: "dark", palette: "classic" });
  });

  it("uses the device's colour scheme when neither source gives a theme", () => {
    expect(systemFallbackTheme(true)).toBe("light");
    expect(systemFallbackTheme(false)).toBe("dark");
    expect(resolveBootAppearance({}, {}, "light")).toEqual({ theme: "light", palette: "classic" });
    // Served attributes and a runtime config theme both still win over it.
    expect(resolveBootAppearance({ theme: "dark" }, {}, "light")).toEqual({ theme: "dark", palette: "classic" });
    expect(resolveBootAppearance({}, { theme: "dark", palette: "gruvbox" }, "light")).toEqual({ theme: "dark", palette: "gruvbox" });
  });

  describe("slow runtime config", () => {
    afterEach(() => jest.useRealTimers());

    it("resolves with the config when it arrives in time", async () => {
      await expect(settleWithin(Promise.resolve({ theme: "light" }), 3000)).resolves.toEqual({ theme: "light" });
    });

    it("gives up on a config request that never settles", async () => {
      jest.useFakeTimers();
      const pending = settleWithin(new Promise<never>(() => undefined), 3000);
      jest.advanceTimersByTime(3000);
      await expect(pending).resolves.toBeUndefined();
    });

    it("treats a failed request as no config", async () => {
      await expect(settleWithin(Promise.reject(new Error("offline")), 3000)).resolves.toBeUndefined();
    });

    it("falls back to the device's colour scheme until a config arrives", () => {
      const main = read("main.tsx");
      expect(main).toContain('systemFallbackTheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches === false)');
      expect(main).toContain("resolveBootAppearance(served, fetched, systemTheme)");
    });

    it("lets a late config restyle the join page until a session theme is known", () => {
      const student = read("views/StudentView.tsx");
      expect(student).toContain("useState<DeckTheme | null>(null)");
      expect(student).toContain("useState<DeckPalette | null>(null)");
      expect(student).toContain("applyClientTheme(sessionTheme, defaultTheme)");
      expect(student).not.toContain("setSessionTheme(defaultTheme)");
      expect(student).not.toContain("setSessionPalette(defaultPalette)");
    });

    it("starts the theme fallback before waiting for the config", () => {
      const main = read("main.tsx");
      const fallback = main.indexOf("window.setTimeout(");
      expect(fallback).toBeGreaterThan(-1);
      expect(fallback).toBeLessThan(main.indexOf("await "));
      expect(main).toContain("settleWithin(request, THEME_WAIT_MS)");
    });
  });

  it("paints a neutral that follows the system scheme until a theme is set", () => {
    const css = read("index.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/html:not\(\[data-theme\]\)\s*\{\s*background:\s*#ffffff;/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*html:not\(\[data-theme\]\)\s*\{\s*background:\s*#262625;/);
    expect(css).toMatch(/html:not\(\[data-theme\]\) #root\s*\{\s*visibility:\s*hidden;/);
  });
});
