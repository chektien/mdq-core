import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../app";
import { loadRuntimeConfig } from "../config";
import { clearAllSessions } from "../session";
import { parseQuizMarkdown } from "../parser";
import { DECK_PALETTES } from "@mdq/shared";

const QUESTION = `
---

## Check

**Ready?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Ready.

---
`;

function deck(title: string, palette?: string, theme?: string): string {
  return `# ${title}\n${theme ? `theme: ${theme}\n` : ""}${palette ? `palette: ${palette}\n` : ""}${QUESTION}`;
}

const ALL_PALETTES = ["classic", "gruvbox", "rose-pine", "catppuccin", "seoul256", "ayu", "tokyo-night"];

describe("per-deck palette", () => {
  afterEach(() => clearAllSessions());

  it("parses classic and gruvbox case-insensitively with optional quotes", () => {
    expect(parseQuizMarkdown(deck("Gruvbox", "GRUVBOX"), "gruvbox.md").quiz?.palette).toBe("gruvbox");
    expect(parseQuizMarkdown(deck("Classic", "'classic'"), "classic.md").quiz?.palette).toBe("classic");
    expect(parseQuizMarkdown(deck("Quoted", '"gruvbox"'), "quoted.md").quiz?.palette).toBe("gruvbox");
    expect(parseQuizMarkdown(deck("Fallback"), "fallback.md").quiz?.palette).toBeUndefined();
  });

  it("lists the supported palettes in one ordered shared constant", () => {
    expect([...DECK_PALETTES]).toEqual(ALL_PALETTES);
  });

  it.each(ALL_PALETTES)("parses %s case-insensitively with optional quotes", (name) => {
    for (const written of [name, name.toUpperCase(), `'${name}'`, `"${name.toUpperCase()}"`]) {
      const result = parseQuizMarkdown(deck("Deck", written), "deck.md");
      expect(result.errors).toEqual([]);
      expect(result.quiz?.palette).toBe(name);
    }
  });

  it("keeps palette independent of theme", () => {
    const quiz = parseQuizMarkdown(deck("Both", "gruvbox", "light"), "both.md").quiz;
    expect(quiz?.theme).toBe("light");
    expect(quiz?.palette).toBe("gruvbox");
  });

  it("only reads palette from the deck preamble", () => {
    const markdown = `# Body only\n${QUESTION.replace("**Ready?**", "palette: gruvbox\n\n**Ready?**")}`;
    const result = parseQuizMarkdown(markdown, "body.md");
    expect(result.errors).toEqual([]);
    expect(result.quiz?.palette).toBeUndefined();
  });

  it("reports invalid palette metadata at deck level", () => {
    const result = parseQuizMarkdown(deck("Invalid", "solarized"), "invalid.md");
    expect(result.errors.map((error) => error.detail)).toContain(
      "Invalid palette: solarized (expected classic, gruvbox, rose-pine, catppuccin, seoul256, ayu, or tokyo-night)",
    );
    // A near miss is still rejected, so only the exact hyphenated names work.
    for (const nearMiss of ["rosepine", "rose_pine", "tokyonight", "tokyo night", "mocha", ""]) {
      const rejected = parseQuizMarkdown(deck("Near miss", nearMiss || "''"), "near-miss.md");
      expect(rejected.errors.some((error) => error.detail.startsWith("Invalid palette"))).toBe(true);
      expect(rejected.quiz?.palette).toBeUndefined();
    }
    expect(result.errors.find((error) => error.detail.startsWith("Invalid palette"))?.questionIndex).toBe(-1);
  });

  it("defaults the runtime palette to classic and accepts MDQ_PALETTE", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-palette-config-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    expect(loadRuntimeConfig({ rootDir: root, env: {} }).palette).toBe("classic");
    expect(loadRuntimeConfig({ rootDir: root, env: { MDQ_PALETTE: " Gruvbox " } }).palette).toBe("gruvbox");
    expect(loadRuntimeConfig({ rootDir: root, env: { MDQ_PALETTE: "sepia" } }).palette).toBe("classic");
    for (const name of ALL_PALETTES) {
      expect(loadRuntimeConfig({ rootDir: root, env: { MDQ_PALETTE: ` ${name.toUpperCase()} ` } }).palette).toBe(name);
    }
    expect(loadRuntimeConfig({ rootDir: root, env: { MDQ_PALETTE: "rosepine" } }).palette).toBe("classic");
  });

  it("delivers each new palette on deck and runtime endpoints", async () => {
    const quizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-palette-all-"));
    for (const name of ALL_PALETTES) {
      fs.writeFileSync(path.join(quizDir, `${name}.md`), deck(name, name));
    }
    const app = createApp({ quizDir, palette: "tokyo-night" });

    const runtime = await request(app).get("/api/runtime-config").expect(200);
    expect(runtime.body.palette).toBe("tokyo-night");

    for (const name of ALL_PALETTES) {
      const response = await request(app).get(`/api/deck/${name}`).expect(200);
      expect(response.body.palette).toBe(name);
    }
  });

  it("serves classic by default so existing runtimes are unchanged", async () => {
    const quizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-palette-default-"));
    fs.writeFileSync(path.join(quizDir, "fallback.md"), deck("Fallback"));
    const app = createApp({ quizDir });

    const runtime = await request(app).get("/api/runtime-config").expect(200);
    expect(runtime.body.palette).toBe("classic");

    const deckResponse = await request(app).get("/api/deck/fallback").expect(200);
    expect(deckResponse.body.palette).toBe("classic");
  });

  it("delivers the effective palette on deck and session endpoints", async () => {
    const quizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-palette-"));
    fs.writeFileSync(path.join(quizDir, "gruvbox.md"), deck("Gruvbox", "gruvbox"));
    fs.writeFileSync(path.join(quizDir, "classic.md"), deck("Classic", "classic"));
    fs.writeFileSync(path.join(quizDir, "fallback.md"), deck("Fallback"));
    const app = createApp({ quizDir, theme: "dark", palette: "classic" });

    const runtime = await request(app).get("/api/runtime-config").expect(200);
    expect(runtime.body.palette).toBe("classic");

    const decks = await request(app).get("/api/decks").expect(200);
    const byWeek = (week: string) => decks.body.find((item: { week: string }) => item.week === week);
    expect(byWeek("gruvbox").palette).toBe("gruvbox");
    expect(byWeek("classic").palette).toBe("classic");
    expect(byWeek("fallback").palette).toBe("classic");

    const deckResponse = await request(app).get("/api/deck/gruvbox").expect(200);
    expect(deckResponse.body.palette).toBe("gruvbox");

    const created = await request(app).post("/api/session").send({ week: "gruvbox" }).expect(201);
    expect(created.body.palette).toBe("gruvbox");

    const lookup = await request(app).get(`/api/session/by-code/${created.body.sessionCode}`).expect(200);
    expect(lookup.body.palette).toBe("gruvbox");

    const restored = await request(app).get(`/api/session/${created.body.sessionId}/state`).expect(200);
    expect(restored.body.palette).toBe("gruvbox");

    const presentation = await request(app).get(`/api/session/${created.body.sessionId}/presentation`).expect(200);
    expect(presentation.body.palette).toBe("gruvbox");
  });

  it("falls back to the runtime palette when the deck sets none", async () => {
    const quizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-palette-runtime-"));
    fs.writeFileSync(path.join(quizDir, "fallback.md"), deck("Fallback"));
    fs.writeFileSync(path.join(quizDir, "classic.md"), deck("Classic", "classic"));
    const app = createApp({ quizDir, palette: "gruvbox" });

    const decks = await request(app).get("/api/decks").expect(200);
    const byWeek = (week: string) => decks.body.find((item: { week: string }) => item.week === week);
    expect(byWeek("fallback").palette).toBe("gruvbox");
    expect(byWeek("classic").palette).toBe("classic");

    const created = await request(app).post("/api/session").send({ week: "fallback" }).expect(201);
    expect(created.body.palette).toBe("gruvbox");
    const lookup = await request(app).get(`/api/session/by-code/${created.body.sessionCode}`).expect(200);
    expect(lookup.body.palette).toBe("gruvbox");
  });
});

describe("print exporter palette", () => {
  const printSource = fs.readFileSync(path.resolve(__dirname, "..", "print-mdq.ts"), "utf-8");

  it("accepts every palette through --palette and defaults to the deck palette", () => {
    expect(printSource).toContain('arg === "--palette"');
    expect(printSource).toContain("parseDeckPalette(value)");
    expect(printSource).toContain("Use ${describeDeckPalettes()}.");
    expect(printSource).toContain('options.palette ?? quiz.palette ?? "classic"');
  });

  it("has gruvbox print tokens for both themes", () => {
    const gruvbox = printSource.slice(
      printSource.indexOf("function renderGruvboxTokens"),
      printSource.indexOf("function printPageBackground"),
    );
    expect(gruvbox).toContain("--page-bg: #282828;");
    expect(gruvbox).toContain("--page-bg: #eff0ec;");
    expect(gruvbox).toContain("--accent: #fe8019;");
    expect(gruvbox).toContain("--accent: #af3a03;");
  });
});
