import { DECK_STYLE_KEYS, FONT_SIZE_ROLES, deckStylePresets, readDeckStyleHeader, resolveDeckStyleSetting } from "@mdq/shared";
import { printDeckStyle } from "../print-deck-style";
import { parseQuizMarkdown } from "../parser";

const deck = (header: string) => `# Synthetic\n${header}\n---\n## Example\ntype: slide\nText\n`;
const presets = ["small", "medium", "large", "x-large"];
describe("human font settings", () => {
  for (const [human, older] of FONT_SIZE_ROLES) {
    it(`${human} shares presets, not exact lengths, with ${older}`, () => {
      expect(DECK_STYLE_KEYS).toContain(human);
      expect(deckStylePresets(human)).toEqual(presets);
      for (const preset of presets) expect(resolveDeckStyleSetting(human, preset)).toEqual(resolveDeckStyleSetting(older, preset));
      for (const value of ["2rem", "32px", "2em", "huge"]) expect(resolveDeckStyleSetting(human, value)).toEqual({ ok: false, message: `${human}: ${value} is not a font size. Use small, medium, large or x-large.` });
      expect(parseQuizMarkdown(deck(`${human.replace(/-/g, "_")}: large`), "synthetic.md").quiz?.styleSettings).toEqual({ [human]: "large" });
    });
  }
  it("resolves by role before emitting properties, independent of line order", () => {
    for (const header of ["body-size: 2rem\nbody-font-size: large", "body-font-size: large\nbody-size: 2rem"]) {
      const source = deck(header);
      const shared = readDeckStyleHeader(source);
      expect(shared.settings).toEqual({ "body-font-size": "large" });
      expect(shared.style).toEqual({ "--mdq-body-scale": "1.2" });
      expect(shared.shadowed).toHaveLength(1);
      expect(shared.warnings).toEqual([]);
      const parsed = parseQuizMarkdown(source, "synthetic.md");
      expect(parsed.quiz?.styleSettings).toEqual(shared.settings);
      expect(parsed.quiz?.style).toEqual(shared.style);
      expect(parsed.diagnostics).toEqual([]);
    }
  });
  it("keeps first-key semantics, invalid fallback, scoping and line numbers", () => {
    const source = deck("body-font-size: huge\nbody-font-size: large\nbody-size: 2rem");
    const shared = readDeckStyleHeader(source);
    expect(shared.settings).toEqual({ "body-size": "2rem" });
    expect(shared.warnings[0].line).toBe(2);
    const parsed = parseQuizMarkdown(source, "synthetic.md");
    expect(parsed.diagnostics[0].lineNumber).toBe(2);
    expect(parsed.diagnostics[0].message).toBe(shared.warnings[0].message);
    expect(readDeckStyleHeader(deck("") + "body-font-size: large").settings).toEqual({});
  });
});
describe("participant ID canonical and compatible syntax", () => {
  for (const key of ["participant-id", "participant_id", "student-id", "student_id"]) {
    for (const value of [true, false]) it(`${key}: ${value} preserves the studentId runtime field`, () => {
      const parsed = parseQuizMarkdown(deck(`${key}: ${value}`), "synthetic.md");
      expect(parsed.errors).toEqual([]);
      expect(parsed.quiz?.studentId).toBe(value);
    });
    it(`${key} still rejects non-booleans`, () => {
      const parsed = parseQuizMarkdown(deck(`${key}: yes`), "synthetic.md");
      expect(parsed.errors[0].detail).toBe(`Invalid ${key.replace(/_/g, "-")}: yes (expected true or false)`);
      expect(parsed.errors[0].lineNumber).toBe(2);
    });
  }
  it("valid canonical alias wins regardless of order", () => {
    for (const header of ["student-id: true\nparticipant-id: false", "participant-id: false\nstudent-id: true"])
      expect(parseQuizMarkdown(deck(header), "synthetic.md").quiz?.studentId).toBe(false);
  });
  it("reports invalid aliases even when another valid alias supplies the value", () => {
    for (const header of ["participant-id: yes\nstudent-id: false", "participant-id: false\nstudent-id: yes"]) {
      const parsed = parseQuizMarkdown(deck(header), "synthetic.md");
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.quiz?.studentId).toBe(false);
    }
  });
});

it("new and older body presets feed identical native Core print CSS", () => {
  const older = parseQuizMarkdown(deck("body-size: large"), "synthetic.md").quiz!;
  const human = parseQuizMarkdown(deck("body-font-size: large"), "synthetic.md").quiz!;
  expect(printDeckStyle(human)).toEqual(printDeckStyle(older));
  expect(printDeckStyle(human).tokens).toContain("--mdq-body-scale: 1.2;");
});
