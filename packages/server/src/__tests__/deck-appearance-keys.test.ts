import fs from "fs";
import path from "path";
import { DECK_PALETTES, describeDeckPalettes } from "@mdq/shared";
import { parseQuizMarkdown, QuizParseError } from "../parser";
import { buildHtml, parseArgs } from "../print-mdq";

const body = "---\n## Sample\ntype: slide\n\nPublic sample.\n";
const deck = (header: string) => `# Appearance\n${header}\n${body}`;
const parse = (header: string) => parseQuizMarkdown(deck(header), "appearance.md");

describe("deck appearance keys", () => {
  it.each(DECK_PALETTES)("reads theme: %s with each dark mode, quotes and case", (scheme) => {
    for (const [dark, theme] of [["on", "dark"], ["off", "light"]]) {
      for (const quote of ["", "'", '"']) {
        const result = parse(`THEME: ${quote}${scheme.toUpperCase()}${quote}\nDARK: ${quote}${dark.toUpperCase()}${quote}`);
        expect(result.errors).toEqual([]);
        expect(result.quiz).toMatchObject({ theme, palette: scheme });
      }
    }
  });

  it("keeps the retired scheme names accepted by parseDeckPalette", () => {
    for (const written of ["tokyo-night", " TOKYO-NIGHT ", "'tokyo-night'", '\"TOKYO-NIGHT\"']) {
      const result = parse(`theme: ${written}\ndark: off`);
      expect(result.errors).toEqual([]);
      expect(result.quiz).toMatchObject({ palette: "classic", theme: "light" });
    }
  });

  it("leaves each omitted key unset for runtime fallback", () => {
    expect(parse("").quiz).toMatchObject({ theme: undefined, palette: undefined });
    expect(parse("theme: gruvbox").quiz).toMatchObject({ theme: undefined, palette: "gruvbox" });
    expect(parse("dark: off").quiz).toMatchObject({ theme: "light", palette: undefined });
  });

  it("reads appearance only above the first separator, including a headerless deck", () => {
    for (const prefix of ["", "# Header\n"]) {
      const result = parseQuizMarkdown(`${prefix}${body}\ntheme: gruvbox\ndark: off\npalette: ayu\n`, "body.md");
      expect(result.errors).toEqual([]);
      expect(result.quiz).toMatchObject({ theme: undefined, palette: undefined });
    }
  });

  it.each(["solarized", "rosepine", "", "''"])("rejects unknown theme %s on its line", (value) => {
    const result = parse(`\ntheme: ${value}\ndark: on`);
    expect(result.quiz?.palette).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBeInstanceOf(QuizParseError);
    expect(result.errors[0]).toMatchObject({
      sourceFile: "appearance.md", questionIndex: -1, lineNumber: 3,
      detail: `Invalid theme: ${value} (expected ${describeDeckPalettes()})`,
    });
  });

  it.each([["dark", "on"], ["light", "off"], ['"DARK"', "on"], ["'LIGHT'", "off"]])(
    "rejects theme: %s and points to dark: %s", (value, mode) => {
      const result = parse(`theme: ${value}`);
      expect(result.quiz).toMatchObject({ theme: undefined, palette: undefined });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ lineNumber: 2, detail: `Invalid theme: ${value} (write dark: ${mode})` });
    },
  );

  it.each(["true", "yes", "dark", "light", "false", "no", "", '"YES"'])("rejects dark: %s", (value) => {
    const result = parse(`theme: classic\ndark: ${value}`);
    expect(result.quiz?.theme).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ lineNumber: 3, detail: `Invalid dark: ${value} (expected on or off)` });
  });

  it.each(["palette: gruvbox", 'PALETTE: "CLASSIC"', "palette:"])("refuses %s without applying it", (line) => {
    const result = parse(`\n${line}`);
    expect(result.quiz?.palette).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ lineNumber: 3, detail: "palette: is not a deck setting (write theme: <scheme>)" });
  });

  it("refuses every palette line even alongside a valid theme", () => {
    const result = parse("palette: ayu\ntheme: classic\npalette: gruvbox");
    expect(result.quiz?.palette).toBe("classic");
    expect(result.errors.map((error) => error.lineNumber)).toEqual([2, 4]);
  });

  it("preserves error lines in CRLF headers", () => {
    const result = parseQuizMarkdown(deck("theme: unknown\ndark: yes\npalette: classic").replace(/\n/g, "\r\n"), "crlf.md");
    expect(result.errors.map((error) => error.lineNumber).sort()).toEqual([2, 3, 4]);
  });
});

describe("print appearance flags", () => {
  it.each(DECK_PALETTES)("accepts --theme %s with --dark on or off", (scheme) => {
    for (const [dark, theme] of [["ON", "dark"], ["OFF", "light"]]) {
      expect(parseArgs(["sample.md", "--theme", scheme.toUpperCase(), "--dark", dark]).options).toMatchObject({ palette: scheme, theme });
    }
  });

  it("defaults to dark and uses the deck scheme, else classic", () => {
    const options = parseArgs(["sample.md"]).options;
    expect(options).toMatchObject({ theme: "dark", palette: undefined });
    const quiz = parse("theme: gruvbox\ndark: off").quiz!;
    expect(buildHtml(quiz, options)).toContain('--page-bg: #282828;');
    expect(buildHtml(parse("").quiz!, options)).toContain('--page-bg: #242423;');
    expect(buildHtml(quiz, parseArgs(["sample.md", "--theme", "ayu", "--dark", "off"]).options)).toContain('--page-bg: #fcfcfc;');
  });

  it.each(["dark", "light", "DARK"])("refuses old --theme %s and names --dark", (mode) => {
    expect(() => parseArgs(["sample.md", "--theme", mode])).toThrow(`Unsupported theme "${mode}". Use --dark ${mode.toLowerCase() === "dark" ? "on" : "off"}.`);
  });

  it("refuses --palette and names --theme", () => {
    expect(() => parseArgs(["sample.md", "--palette", "ayu"])).toThrow("--palette is not supported. Use --theme <scheme>.");
  });

  it.each(["true", "yes", "dark", "light"])("refuses --dark %s", (value) => {
    expect(() => parseArgs(["sample.md", "--dark", value])).toThrow(`Unsupported dark "${value}". Use on or off.`);
  });

  it("rejects unknown schemes and missing values", () => {
    expect(() => parseArgs(["sample.md", "--theme", "unknown"])).toThrow(`Unsupported theme "unknown". Use ${describeDeckPalettes()}.`);
    for (const flag of ["--theme", "--dark"]) {
      expect(() => parseArgs(["sample.md", flag])).toThrow(`Missing value for ${flag}`);
    }
  });
});

describe("appearance authoring documentation", () => {
  it("documents deck keys separately from operator config and print defaults", () => {
    const readme = fs.readFileSync(path.resolve(__dirname, "../../../../README.md"), "utf8");
    expect(readme).toContain("theme: gruvbox\ndark: off");
    expect(readme).toContain("| Colour scheme | `dark: off` | `dark: on` |");
    expect(readme).toContain("These deck keys differ from operator configuration");
    expect(readme).toContain("`--dark on|off`");
    expect(readme).not.toMatch(/--palette|--theme (?:dark|light)/);
  });
});
