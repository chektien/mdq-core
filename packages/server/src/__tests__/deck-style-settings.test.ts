import { DECK_SETTING_KEYS, DECK_STYLE_KEYS, deckStylePresets, formatDiagnostic, safeDeckStyle } from "@mdq/shared";
import * as parserModule from "../parser";
import { parseQuizMarkdown } from "../parser";
import { printDeckStyle } from "../print-deck-style";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../app";
import { apply } from "../engine";
import { createSession } from "../session";

const SLIDE = "## One\n\ntype: slide\n\n- Point.";
const deck = (header: string) => `# Style deck\n${header}\n\n---\n\n${SLIDE}\n\n---\n`;
// A setting problem never blocks the deck: it is a diagnostic on the key's line, and the parse result has no error.
const parse = (header: string) => {
  const result = parseQuizMarkdown(deck(header), "style.md");
  expect(result.errors).toEqual([]);
  return { quiz: result.quiz, errors: result.diagnostics };
};

const SIZE_PRESETS = ["small", "medium", "large", "x-large"];
const WIDTH_PRESETS = ["narrow", "medium", "wide", "full"];
const SPACING_PRESETS = ["tight", "normal", "roomy"];
const SCALE_LEVEL = ["small", "medium", "large"];

const PRESET_TABLE: Record<string, string[]> = {
  "title-size": SIZE_PRESETS,
  "heading-size": SIZE_PRESETS,
  "body-size": SIZE_PRESETS,
  "small-size": SIZE_PRESETS,
  "caption-size": SIZE_PRESETS,
  "content-width": WIDTH_PRESETS,
  "slide-width": WIDTH_PRESETS,
  "text-width": WIDTH_PRESETS,
  "slide-padding": SPACING_PRESETS,
  "block-spacing": SPACING_PRESETS,
  "inline-spacing": SPACING_PRESETS,
  "list-spacing": SPACING_PRESETS,
  "list-indent": SCALE_LEVEL,
  "list-gap": SPACING_PRESETS,
  "bullet-size": SCALE_LEVEL,
  "image-corners": ["square", "rounded", "round"],
  "image-spacing": SPACING_PRESETS,
  "image-width": WIDTH_PRESETS,
};
const COLOR_KEYS = ["accent-color", "link-color", "text-color", "muted-color", "background-color", "surface-color", "bullet-color"];

describe("deck header appearance settings", () => {
  it("lists exactly the fixed vocabulary as setting keys", () => {
    expect([...DECK_STYLE_KEYS].sort()).toEqual([...Object.keys(PRESET_TABLE), ...COLOR_KEYS].sort());
    expect(DECK_STYLE_KEYS).toHaveLength(25);
    for (const key of DECK_STYLE_KEYS) expect(DECK_SETTING_KEYS).toContain(key);
  });

  it("gives a deck without the keys no style at all", () => {
    const { quiz, errors } = parse("theme: light\npalette: gruvbox");
    expect(errors).toEqual([]);
    expect(quiz!.style).toBeUndefined();
    expect(quiz!.styleSettings).toBeUndefined();
    expect("style" in quiz!).toBe(false);
  });

  describe.each(Object.entries(PRESET_TABLE))("%s", (key, presets) => {
    it("accepts each preset and reports the presets it lists", () => {
      expect(deckStylePresets(key)).toEqual(presets);
      for (const preset of presets) {
        const { quiz, errors } = parse(`${key}: ${preset}`);
        expect(errors).toEqual([]);
        expect(quiz!.styleSettings).toEqual({ [key]: preset });
        expect(Object.keys(quiz!.style!).length).toBeGreaterThan(0);
      }
    });

    it("accepts a plain length and ignores it when the unit is not allowed", () => {
      const isWidth = key.endsWith("width") && !key.startsWith("bullet");
      const length = isWidth ? "40rem" : "1.5em";
      const ok = parse(`${key}: ${length}`);
      expect(ok.errors).toEqual([]);
      expect(ok.quiz!.styleSettings).toEqual({ [key]: length });
      const bad = parse(`${key}: 10pt`);
      expect(bad.errors).toHaveLength(1);
      expect(bad.quiz!.style).toBeUndefined();
    });

    it("names the key, the value and the presets when the value is wrong", () => {
      const { quiz, errors } = parse(`${key}: huge`);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(`${key}: huge is not`);
      for (const preset of presets) expect(errors[0].message).toContain(preset);
      expect(errors[0].message).toMatch(/or a length such as/);
      expect(errors[0].lineNumber).toBe(2);
      expect(quiz!.style).toBeUndefined();
    });

    it("reads the underscored spelling like the dashed one", () => {
      const dashed = parse(`${key}: ${presets[0]}`).quiz!;
      const underscored = parse(`${key.replace(/-/g, "_")}: ${presets[0]}`).quiz!;
      expect(underscored.style).toEqual(dashed.style);
      expect(underscored.styleSettings).toEqual(dashed.styleSettings);
    });
  });

  it("writes the message the way the README shows it", () => {
    const { errors } = parse("title-size: huge");
    expect(errors[0].message).toContain("title-size: huge is not a size. Use small, medium, large, x-large, or a length such as 4rem.");
  });

  describe("size presets", () => {
    it("scale Core's own size by 0.85, 1, 1.2 and 1.4", () => {
      const scales = SIZE_PRESETS.map((preset) => parse(`body-size: ${preset}`).quiz!.style!["--mdq-body-scale"]);
      expect(scales).toEqual(["0.85", "1", "1.2", "1.4"]);
    });

    it("use an exact length as the size", () => {
      expect(parse("title-size: 4rem").quiz!.style).toEqual({ "--mdq-title-size": "4rem" });
      expect(parse("small-size: 14px").quiz!.style).toEqual({ "--mdq-small-size": "14px" });
      expect(parse("caption-size: .9em").quiz!.style).toEqual({ "--mdq-caption-size": ".9em" });
    });

    it("reject zero, negative and unitless numbers", () => {
      for (const value of ["0rem", "-2rem", "4", "4 rem", "rem", "4vw"]) expect(parse(`title-size: ${value}`).errors).toHaveLength(1);
    });
  });

  describe("colours", () => {
    it.each(COLOR_KEYS)("%s accepts a name, #rgb and #rrggbb, in any case", (key) => {
      for (const [written, kept] of [["teal", "teal"], ["Navy", "navy"], ["#0af", "#0af"], ["#0F766E", "#0f766e"], ['"tomato"', "tomato"], ["rebeccapurple", "rebeccapurple"]]) {
        const { quiz, errors } = parse(`${key}: ${written}`);
        expect(errors).toEqual([]);
        expect(quiz!.styleSettings).toEqual({ [key]: kept });
      }
    });

    it.each(COLOR_KEYS)("%s rejects functions, bad hex, unknown names and CSS keywords", (key) => {
      for (const value of ["rgb(1,2,3)", "hsl(10 20% 30%)", "var(--x)", "#12", "#12345", "#1234567", "#gggggg", "tealish", "transparent", "currentcolor", "inherit", "url(x.png)", "teal;color:red", "#fff}"]) {
        const { quiz, errors } = parse(`${key}: ${value}`);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain(`${key}: ${value} is not a colour. Use a colour name such as teal or navy, or a hex colour such as #0f766e.`);
        expect(quiz!.style).toBeUndefined();
      }
    });

    it("set the deck colour properties, and the background ones set the palette's own", () => {
      const { quiz } = parse("accent-color: teal\ntext-color: #111\nmuted-color: gray\nbackground-color: navy\nsurface-color: #223\nlink-color: blue\nbullet-color: red");
      expect(quiz!.style).toEqual({
        "--mdq-deck-accent": "teal",
        "--mdq-deck-text": "#111",
        "--mdq-deck-muted": "gray",
        "--mdq-slide-bg": "navy",
        "--mdq-slide-bg-soft": "#223",
        "--mdq-link-color": "blue",
        "--mdq-bullet-color": "red",
      });
    });

    it("uses the background colour as the top colour until a surface colour is set", () => {
      expect(parse("background-color: navy").quiz!.style).toEqual({ "--mdq-slide-bg": "navy", "--mdq-slide-bg-soft": "navy" });
      expect(parse("surface-color: #223").quiz!.style).toEqual({ "--mdq-slide-bg-soft": "#223" });
    });
  });

  describe("widths, spacing and list settings", () => {
    it("resolve width presets and lengths", () => {
      expect(parse("content-width: wide").quiz!.style).toEqual({ "--mdq-content-width": "min(80cqi, 90rem)" });
      expect(parse("slide-width: full").quiz!.style).toEqual({ "--mdq-slide-width": "100%" });
      expect(parse("text-width: 60ch").quiz!.style).toEqual({ "--mdq-text-width": "60ch" });
      expect(parse("text-width: 80%").quiz!.style).toEqual({ "--mdq-text-width": "80%" });
      expect(parse("content-width: 40vw").errors).toHaveLength(1);
    });

    it("resolve spacing presets as a scale and lengths as exact values, and allow zero", () => {
      expect(parse("slide-padding: roomy").quiz!.style).toEqual({ "--mdq-slide-padding-scale": "1.5" });
      expect(parse("block-spacing: tight").quiz!.style).toEqual({ "--mdq-block-spacing-scale": "0.6" });
      expect(parse("inline-spacing: 1rem").quiz!.style).toEqual({ "--mdq-inline-spacing": "1rem" });
      expect(parse("list-spacing: 0").errors).toHaveLength(1);
      expect(parse("list-spacing: 0em").quiz!.style).toEqual({ "--mdq-list-spacing": "0em" });
      expect(parse("list-spacing: roomy").quiz!.style).toEqual({ "--mdq-list-spacing": "0.4em" });
    });

    it("set both list gaps from one list-gap value", () => {
      expect(parse("list-gap: normal").quiz!.style).toEqual({ "--mdq-list-gap": "0.5em", "--mdq-list-gap-nested": "0.16em" });
      expect(parse("list-gap: roomy").quiz!.style).toEqual({ "--mdq-list-gap": "0.85em", "--mdq-list-gap-nested": "0.3em" });
      expect(parse("list-gap: 1rem").quiz!.style).toEqual({ "--mdq-list-gap": "1rem", "--mdq-list-gap-nested": "calc(1rem * 0.32)" });
    });

    it("resolve indent and bullet size", () => {
      expect(parse("list-indent: large").quiz!.style).toEqual({ "--mdq-list-indent": "1.8em" });
      expect(parse("list-indent: 2rem").quiz!.style).toEqual({ "--mdq-list-indent": "2rem" });
      expect(parse("bullet-size: large").quiz!.style).toEqual({ "--mdq-bullet-scale": "1.35" });
      expect(parse("bullet-size: 1.1em").quiz!.style).toEqual({ "--mdq-bullet-size": "1.1em" });
    });
  });

  describe("image settings", () => {
    it("resolve corners, spacing and width", () => {
      expect(parse("image-corners: square").quiz!.style).toEqual({ "--mdq-image-corners": "0" });
      expect(parse("image-corners: round").quiz!.style).toEqual({ "--mdq-image-corners": "1.4rem" });
      expect(parse("image-corners: 8px").quiz!.style).toEqual({ "--mdq-image-corners": "8px" });
      expect(parse("image-spacing: roomy").quiz!.style).toEqual({ "--mdq-image-spacing-scale": "1.5" });
      expect(parse("image-width: narrow").quiz!.style).toEqual({ "--mdq-image-width": "50%", "--mdq-image-inset": "auto" });
      expect(parse("image-width: 30rem").quiz!.style).toEqual({ "--mdq-image-width": "30rem", "--mdq-image-inset": "auto" });
    });
  });

  describe("unsafe values", () => {
    const ATTACKS = ["url(https://example.org/x.png)", "var(--other)", "calc(1rem + 2px)", "1rem; color: red", "1rem } body { color: red", "<script>", "1rem</style>", "expression(1)", "1rem !important", "\\31 rem"];
    it.each(DECK_STYLE_KEYS)("%s ignores any value that is not a preset, a plain length or a colour", (key) => {
      for (const value of ATTACKS) {
        const { quiz, errors } = parse(`${key}: ${value}`);
        expect(errors).toHaveLength(1);
        expect(quiz!.style).toBeUndefined();
        expect(quiz!.styleSettings).toBeUndefined();
      }
    });

    it("keeps a bad value from stopping the good ones", () => {
      const { quiz, errors } = parse("title-size: huge\naccent-color: teal\nbody-size: large\ntext-color: #zzz");
      expect(errors).toHaveLength(2);
      expect(quiz!.styleSettings).toEqual({ "accent-color": "teal", "body-size": "large" });
      expect(quiz!.style).toEqual({ "--mdq-deck-accent": "teal", "--mdq-body-scale": "1.2" });
    });

    it("reports an empty value with the choices", () => {
      const { errors } = parse("title-size:");
      expect(errors[0].message).toContain("title-size has no value. Use small, medium, large, x-large");
    });
  });

  describe("where the keys are read", () => {
    it("reads them from the header only", () => {
      const source = `# Style deck\nbody-size: large\n\n---\n\n## One\n\ntype: slide\naccent-color: teal\n\n- Point.\n\n---\n`;
      const { quiz, errors } = parseQuizMarkdown(source, "style.md");
      expect(errors).toEqual([]);
      expect(quiz!.styleSettings).toEqual({ "body-size": "large" });
    });

    it("reads them beside theme and palette without changing either", () => {
      const { quiz, errors } = parse("theme: light\npalette: gruvbox\naccent-color: teal");
      expect(errors).toEqual([]);
      expect(quiz!.theme).toBe("light");
      expect(quiz!.palette).toBe("gruvbox");
      expect(quiz!.style).toEqual({ "--mdq-deck-accent": "teal" });
    });

    it("carries the style to the slide payload only through the known custom properties", () => {
      expect(safeDeckStyle({ "--mdq-deck-accent": "teal", "--mdq-title-scale": "1.2", "--mdq-list-gap-nested": "calc(1rem * 0.32)" })).toEqual({
        "--mdq-deck-accent": "teal",
        "--mdq-title-scale": "1.2",
        "--mdq-list-gap-nested": "calc(1rem * 0.32)",
      });
      expect(safeDeckStyle({ "--other": "1", "--mdq-deck-accent": "url(x)", color: "red", "--mdq-body-size": "var(--x)", "--mdq-title-size": "1rem;color:red" })).toBeUndefined();
      // Fails closed: only the functions the settings emit, plain numbers and lengths, colours and auto.
      for (const value of ["var(--x)", "url(a)", "attr(x)", "env(x)", "calc(var(--x) * 2)", "calc(1rem * 2", "calc(1rem) )", "calc(((((1rem)))))", "1rem !important", "rgb(1,2,3)", "12345rem", "1.2345rem", "\\31 rem", "1rem 2rem", "javascript", "teal ", "", "calc(1rem * 2) url(x)", `calc(${"1rem + ".repeat(20)}1rem)`, "expression(1)"]) {
        expect([value, safeDeckStyle({ "--mdq-title-size": value })]).toEqual([value, undefined]);
      }
      for (const value of ["1rem", "0", "1.35", ".5em", "100%", "teal", "#0f766e", "auto", "min(42cqi, 44rem)", "max(1rem, 2cqi)", "clamp(1rem, 2cqi, 3rem)", "calc(1rem * 0.32)"]) {
        expect(safeDeckStyle({ "--mdq-title-size": value })).toEqual({ "--mdq-title-size": value });
      }
      expect(safeDeckStyle(null)).toBeUndefined();
      expect(safeDeckStyle("x")).toBeUndefined();
    });
  });

  describe("a setting problem never stops the deck", () => {
    it("reports each ignored setting on its own line and leaves errors empty", () => {
      const result = parseQuizMarkdown(deck("title-size: huge\nbody-size: large\naccent-color: teel"), "style.md");
      expect(result.errors).toEqual([]);
      expect(result.quiz).not.toBeNull();
      expect(result.diagnostics).toEqual([
        { severity: "warning", sourceFile: "style.md", questionIndex: -1, lineNumber: 2, message: expect.stringContaining("title-size: huge is not a size") },
        { severity: "warning", sourceFile: "style.md", questionIndex: -1, lineNumber: 4, message: expect.stringContaining("accent-color: teel is not a colour") },
      ]);
    });

    it("lists diagnostics in line order, not in the order the keys are checked", () => {
      const result = parseQuizMarkdown(deck("accent-color: teel\ntitle-size: huge\nbody-size: nope"), "style.md");
      expect(result.diagnostics.map((d) => d.lineNumber)).toEqual([2, 3, 4]);
      expect(result.diagnostics.map((d) => d.message.split(":")[0])).toEqual(["accent-color", "title-size", "body-size"]);
    });

    it("formats a location for the header, an item, and a missing line", () => {
      const base = { severity: "warning" as const, sourceFile: "x.md", message: "m" };
      expect(formatDiagnostic({ ...base, questionIndex: -1, lineNumber: 2 })).toBe("header, line 2: m");
      expect(formatDiagnostic({ ...base, questionIndex: 2, lineNumber: 14 })).toBe("item 3, line 14: m");
      expect(formatDiagnostic({ ...base, questionIndex: -1 })).toBe("header: m");
      expect(formatDiagnostic({ ...base, severity: "info", questionIndex: 0 })).toBe("item 1: m");
    });

    it("logs two identical diagnostics from one file once", async () => {
      const quizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-style-dup-"));
      fs.writeFileSync(path.join(quizDir, "dup.md"), deck("body-size: large"));
      const note = { severity: "info" as const, sourceFile: "dup.md", questionIndex: -1, lineNumber: 2, message: "Same note." };
      const real = parseQuizMarkdown(deck("body-size: large"), "dup.md");
      const parse = jest.spyOn(parserModule, "parseQuizMarkdown").mockReturnValue({ ...real, diagnostics: [note, { ...note }] });
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        createApp({ quizDir });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("Note in dup.md, header, line 2: Same note.");
      } finally {
        parse.mockRestore();
        warn.mockRestore();
        fs.rmSync(quizDir, { recursive: true, force: true });
      }
    });

    it("has no diagnostics for a clean deck", () => {
      expect(parseQuizMarkdown(deck("title-size: large"), "style.md").diagnostics).toEqual([]);
    });

    it("still lists the deck and reports the ignored setting with it", async () => {
      const quizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-style-"));
      fs.writeFileSync(path.join(quizDir, "styled.md"), deck("title-size: huge\nbody-size: large"));
      fs.writeFileSync(path.join(quizDir, "plain.md"), deck("theme: light").replace("# Style deck", "# Plain deck"));
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const app = createApp({ quizDir });
        const listed = await request(app).get("/api/decks").expect(200);
        const byWeek = Object.fromEntries(listed.body.map((item: { week: string }) => [item.week, item]));
        expect(Object.keys(byWeek).sort()).toEqual(["plain", "styled"]);
        expect(byWeek.styled.diagnostics).toEqual([{ severity: "warning", sourceFile: "styled.md", questionIndex: -1, lineNumber: 2, message: expect.stringContaining("title-size: huge is not a size") }]);
        expect("diagnostics" in byWeek.plain).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Ignored in styled\.md, header, line 2: title-size: huge is not a size/));
        const reloaded = await request(app).post("/api/decks/reload").expect(200);
        expect(reloaded.body.quizzes.find((item: { week: string }) => item.week === "styled").diagnostics).toHaveLength(1);
        // The same diagnostic is not logged again on reload.
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        fs.rmSync(quizDir, { recursive: true, force: true });
      }
    });
  });

  describe("slide payload", () => {
    const opened = (header: string) => {
      const quiz = parse(header).quiz!;
      const message = apply(createSession("style", "open"), quiz, { type: "start" }, 1000).messages.find((item) => item.event === "question:open");
      return message!.payload as Record<string, unknown>;
    };

    it("carries the deck's style on the opening of each item", () => {
      expect(opened("accent-color: teal\ntitle-size: large").deckStyle).toEqual({ "--mdq-deck-accent": "teal", "--mdq-title-scale": "1.2" });
    });

    it("leaves the field out for a deck without the keys", () => {
      expect("deckStyle" in opened("theme: light")).toBe(false);
    });
  });

  describe("print output", () => {
    it("adds nothing for a deck without the keys", () => {
      expect(printDeckStyle({})).toEqual({ tokens: "", pageBackground: undefined, rules: "" });
    });

    it("replaces the print colour tokens and scales the body text", () => {
      const { quiz } = parse("accent-color: teal\ntext-color: #111\nmuted-color: gray\nbackground-color: #fffdf6\nsurface-color: #eee\nlink-color: blue\nbullet-color: red\nbody-size: large\ntitle-size: large");
      const print = printDeckStyle(quiz!);
      for (const declaration of ["--accent: teal;", "--ink: #111;", "--body: #111;", "--muted: gray;", "--page-bg: #fffdf6;", "--paper: #fffdf6;", "--wash: #eee;", "--mdq-body-scale: 1.2;"]) {
        expect(print.tokens).toContain(declaration);
      }
      expect(print.tokens).not.toContain("title");
      expect(print.pageBackground).toBe("#fffdf6");
      expect(print.rules).toContain("a { color: blue; }");
      expect(print.rules).toContain("color: red;");
    });

    it("ignores stored values that are not valid", () => {
      const print = printDeckStyle({ styleSettings: { "accent-color": "red;background:url(x)" }, style: { "--mdq-body-size": "var(--x)" } });
      expect(print.tokens).toBe("");
    });
  });
});
