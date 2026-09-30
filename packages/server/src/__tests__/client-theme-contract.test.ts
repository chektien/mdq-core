import fs from "fs";
import path from "path";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string =>
  fs.readFileSync(path.join(clientSrc, rel), "utf-8");

describe("client light-theme contract", () => {
  describe("per-deck theme application", () => {
    const theme = read("theme.ts");
    const appearance = read("appearance.ts");
    const instructor = read("views/InstructorView.tsx");
    const student = read("views/StudentView.tsx");
    const presentation = read("views/PresentationView.tsx");
    const socket = read("hooks/useSocket.ts");

    it("normalizes and applies only supported themes", () => {
      expect(appearance).toContain('theme === "light" || theme === "dark"');
      expect(theme).toContain("document.documentElement.dataset.theme = resolved");
    });

    it("applies deck themes to instructor, student, and projector views", () => {
      expect(instructor).toContain("sessionTheme ?? selectedDeck?.theme");
      expect(student).toContain("resolveClientTheme(data.theme, defaultTheme)");
      expect(presentation).toContain("applyClientTheme(meta?.theme, defaultTheme)");
    });

    it("retains the deck theme across student socket reconnection", () => {
      expect(socket).toContain("sessionTheme?: DeckTheme");
      expect(socket).toContain("sessionTheme: existing.sessionTheme");
    });
  });

  describe("theme.css end-session dialog", () => {
    const css = read("theme.css");

    it("defines light-theme overrides for the dialog semantic classes", () => {
      for (const cls of [
        ".end-session-card",
        ".end-session-stat",
        ".end-session-stat-value",
        ".end-session-keep",
        ".end-session-end",
      ]) {
        expect(css).toMatch(
          new RegExp(`html\\[data-theme="light"\\]\\s+${cls.replace(".", "\\.")}`),
        );
      }
    });

    it("does not reuse the dark dialog hex (#201d28) inside light overrides", () => {
      const lightBlock = css.slice(css.indexOf("End-session dialog (light theme)"));
      expect(lightBlock).not.toMatch(/#201d28/i);
    });
  });

  describe("InstructorView end-session dialog markup", () => {
    const tsx = read("views/InstructorView.tsx");

    it("carries the semantic class names", () => {
      for (const cls of [
        "end-session-overlay",
        "end-session-card",
        "end-session-eyebrow",
        "end-session-desc",
        "end-session-stat",
        "end-session-stat-value",
        "end-session-stat-label",
        "end-session-keep",
        "end-session-end",
      ]) {
        expect(tsx).toContain(cls);
      }
    });

    it("keeps the dark overlay and reads the dialog surface and border from tokens (classic dark stays #201d28)", () => {
      expect(tsx).toContain("bg-[#07060b]/80");
      expect(tsx).toContain("bg-[var(--mdq-dialog)]");
      expect(tsx).not.toContain("bg-[#201d28]");
      expect(read("theme.css")).toContain("--mdq-dialog: #201d28;");
    });
  });

  describe("index.css slide media canvas", () => {
    const css = read("index.css");

    it("has a light-theme .slide-media-figure override with a light background", () => {
      expect(css).toMatch(
        /html\[data-theme="light"\]\s+\.slide-media-figure\s*\{[^}]*background:\s*#fffdfa/,
      );
    });

    it("keeps the base dark .slide-media-figure rule (dark stays identical)", () => {
      expect(css).toMatch(/\.slide-media-figure\s*\{[^}]*background:\s*rgba\(31,\s*31,\s*30/);
    });
  });

  describe("media caption contrast token", () => {
    const css = read("index.css");

    it("defines a dedicated media caption ink token", () => {
      expect(css).toMatch(/--mdq-media-caption-ink:\s*#/);
    });

    it("light theme overrides the caption ink token for the light slab", () => {
      expect(css).toMatch(
        /html\[data-theme="light"\]\s*\{[^}]*--mdq-media-caption-ink:/,
      );
    });

    it("thumbnail and video captions share one rule using the token", () => {
      expect(css).toMatch(
        /\.slide-media-figure figcaption,\s*\.slide-video-figure figcaption\s*\{[^}]*color:\s*var\(--mdq-media-caption-ink\)/,
      );
    });

    it("expanded image caption uses the same token", () => {
      const start = css.indexOf(".image-expansion-caption");
      const block = css.slice(start, css.indexOf("}", start));
      expect(block).toMatch(/var\(--mdq-media-caption-ink\)/);
    });
  });

  describe("shared expansion close control stacking", () => {
    const css = read("index.css");

    it("lifts the shared close control above the expanded media", () => {
      const start = css.indexOf("\n.image-expansion-close {");
      expect(start).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf("}", start));
      expect(block).toMatch(/position:\s*absolute/);
      expect(block).toMatch(/z-index:\s*[1-9]/);
    });
  });

  describe("VideoCard media family + expansion close control", () => {
    const tsx = read("components/VideoCard.tsx");

    it("reuses the exact image-expansion close button and icon", () => {
      expect(tsx).toContain("image-expansion-close");
      expect(tsx).toContain("image-expansion-close-icon");
    });

    it("presents the caption with figcaption grammar inside a media figure", () => {
      expect(tsx).toContain("slide-video-figure");
      expect(tsx).toContain("<figcaption>");
    });

    it("drops the on-card label badge and bespoke text close button", () => {
      expect(tsx).not.toContain("slide-video-card-badge");
      expect(tsx).not.toContain("video-expansion-close");
    });

    it("closes on Escape and returns focus to the trigger", () => {
      expect(tsx).toContain('event.key === "Escape"');
      expect(tsx).toContain("triggerRef.current?.focus()");
    });

    it("uses native inline playback for direct media files", () => {
      expect(tsx).toContain("video-expansion-native");
      expect(tsx).toContain("playsInline");
      expect(tsx).toContain('preload="metadata"');
      expect(tsx).toContain("autoPlay");
    });
  });

  describe("open-response identity contrast", () => {
    const css = read("index.css");
    const tsx = read("components/OpenResponseList.tsx");

    it("uses semantic identity and answer classes", () => {
      expect(tsx).toContain("open-response-display-name");
      expect(tsx).toContain("open-response-student-id");
      expect(tsx).toContain("open-response-text");
    });

    it("takes the card, ink and outline from the theme tokens, in light and dark", () => {
      const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule(".open-response-entry")).toContain("background: var(--mdq-card-strong)");
      expect(rule(".open-response-entry")).toContain("border-color: var(--mdq-control-border)");
      expect(rule(".open-response-text")).toContain("color: var(--mdq-ink-strong)");
      expect(rule(".open-response-display-name")).toContain("color: var(--mdq-muted)");
      // No fixed dark card colours, and no zinc utilities that the light theme would have to remap.
      expect(css).not.toMatch(/\.open-response-entry\s*\{[^}]*#(?:343432|41413f)/);
      expect(css).not.toMatch(/html\[data-theme="light"\]\s+\.open-response-entry\s*\{/);
      expect(tsx).not.toContain("zinc");
    });
  });
});
