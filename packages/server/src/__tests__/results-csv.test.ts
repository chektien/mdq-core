import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Quiz, Question } from "@mdq/shared";
import { buildResultsCsv, csvEscape } from "../results-csv";
import { getSessionResultsCsvPath, markQuestionRevealed, saveResultsCsv, saveSessionSummaryMarkdown } from "../persistence";
import { addParticipant, createSession, recordSubmission, transitionState } from "../session";

function makeQuestion(index: number, overrides: Partial<Question> = {}): Question {
  return {
    index,
    topic: `Topic ${index + 1}`,
    textMd: `Question ${index + 1}?`,
    textHtml: `<p>Question ${index + 1}?</p>`,
    options: [
      { label: "A", textMd: "Option A", textHtml: "Option A" },
      { label: "B", textMd: "Option B", textHtml: "Option B" },
    ],
    correctOptions: ["A"],
    allowsMultiple: false,
    explanation: "",
    timeLimitSec: 20,
    ...overrides,
  };
}

function makeFixture() {
  const quiz: Quiz = {
    week: "week01",
    title: "Fixture",
    sourceFile: "week01.md",
    questions: [
      makeQuestion(0),
      makeQuestion(1, { isPoll: true, questionType: "poll", correctOptions: [] }),
      makeQuestion(2, { questionType: "open_response", options: [], correctOptions: [] }),
    ],
  };
  const session = createSession("week01", "open");
  addParticipant(session, "S0001", "sock1", "Alex Tan");
  addParticipant(session, "S0002", "sock2", 'Sam "Sammy", Lee');
  addParticipant(session, "S0003", "sock3", "Jo\nKim");
  addParticipant(session, "S0004", "sock4", "Skips Everything");

  const startOf = (index: number) => {
    session.currentQuestionIndex = index;
    session.questionStartedAt = Date.now() - 1000 * (index + 1);
  };

  transitionState(session, "QUESTION_OPEN");
  startOf(0);
  recordSubmission(session, "S0001", 0, ["A"]);
  recordSubmission(session, "S0002", 0, ["B"]);
  recordSubmission(session, "S0003", 0, ["A"]);

  transitionState(session, "QUESTION_CLOSED");
  transitionState(session, "REVEAL");
  transitionState(session, "QUESTION_OPEN");
  startOf(1);
  recordSubmission(session, "S0001", 1, ["B"]);
  recordSubmission(session, "S0002", 1, ["A"]);

  transitionState(session, "QUESTION_CLOSED");
  transitionState(session, "REVEAL");
  transitionState(session, "QUESTION_OPEN");
  startOf(2);
  recordSubmission(session, "S0001", 2, { responseText: 'It is "fine", really.\nSecond line' });
  recordSubmission(session, "S0002", 2, { responseText: "=HYPERLINK(\"http://example.invalid\")" });

  return { session, quiz };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  return rows;
}

describe("results CSV builder", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-results-csv-test-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("matches the file written by saveResultsCsv byte for byte", () => {
    const { session, quiz } = makeFixture();
    const fixedNow = Date.parse("2026-03-04T09:10:20.000Z");
    markQuestionRevealed(session, 0, Date.parse("2026-03-04T09:10:11.000Z"));
    markQuestionRevealed(session, 1, Date.parse("2026-03-04T09:10:15.000Z"));
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);

    saveResultsCsv(session, quiz, tempDir);
    const written = fs.readFileSync(getSessionResultsCsvPath(session, tempDir), "utf-8");

    const built = buildResultsCsv(session, quiz, {
      now: fixedNow,
      revealTimestamps: new Map([
        [0, Date.parse("2026-03-04T09:10:11.000Z")],
        [1, Date.parse("2026-03-04T09:10:15.000Z")],
      ]),
    });

    expect(built).toBe(written);
    expect(built.endsWith("\n")).toBe(true);
    expect(built.endsWith("\n\n")).toBe(false);
  });

  it("writes the expected columns, escaping and blank cells for skipped questions", () => {
    const { session, quiz } = makeFixture();
    const csv = buildResultsCsv(session, quiz, { now: Date.parse("2026-03-04T09:10:20.000Z") });
    const rows = parseCsv(csv);

    expect(rows).toHaveLength(5);
    const header = rows[0];
    expect(header.slice(0, 13)).toEqual([
      "session_id",
      "session_code",
      "week",
      "session_created_at_iso",
      "snapshot_written_at_iso",
      "student_id",
      "display_name",
      "joined_at_iso",
      "connected_at_end",
      "questions_answered",
      "correct_count",
      "total_time_ms",
      "attendance",
    ]);
    expect(header).toHaveLength(13 + 5 * 3);
    expect(header.slice(13, 18)).toEqual([
      "q1_revealed_at_iso",
      "q1_selected",
      "q1_correct",
      "q1_response_ms",
      "q1_answered_at_iso",
    ]);
    for (const row of rows) expect(row).toHaveLength(header.length);

    const col = (name: string) => header.indexOf(name);
    const byId = new Map(rows.slice(1).map((r) => [r[col("student_id")], r]));

    // Multiple choice: scored. Poll and open response: correct column blank.
    const alex = byId.get("S0001")!;
    expect(alex[col("snapshot_written_at_iso")]).toBe("2026-03-04T09:10:20.000Z");
    expect(alex[col("q1_selected")]).toBe("A");
    expect(alex[col("q1_correct")]).toBe("1");
    expect(alex[col("q2_selected")]).toBe("B");
    expect(alex[col("q2_correct")]).toBe("");
    expect(alex[col("q3_selected")]).toBe('It is "fine", really.\nSecond line');
    expect(alex[col("q3_correct")]).toBe("");

    // Commas, quotes and newlines in names survive a round trip.
    expect(byId.get("S0002")![col("display_name")]).toBe('Sam "Sammy", Lee');
    expect(byId.get("S0003")![col("display_name")]).toBe("Jo\nKim");

    // Skipped questions leave the answer cells empty.
    const skipper = byId.get("S0004")!;
    expect(skipper[col("questions_answered")]).toBe("0");
    for (const name of ["q1_selected", "q1_correct", "q1_response_ms", "q1_answered_at_iso", "q3_selected"]) {
      expect(skipper[col(name)]).toBe("");
    }
    const jo = byId.get("S0003")!;
    expect(jo[col("q2_selected")]).toBe("");
    expect(jo[col("q3_selected")]).toBe("");
  });

  it("omits covers and slides from result columns and saved question statistics", () => {
    const { session, quiz } = makeFixture();
    quiz.questions.push(makeQuestion(3, { questionType: "cover", correctOptions: [], options: [] }));
    quiz.questions.push(makeQuestion(4, { questionType: "slide", correctOptions: [], options: [] }));
    const rows = parseCsv(buildResultsCsv(session, quiz));
    expect(rows[0]).toHaveLength(28);
    expect(rows[0]).not.toContain("q4_selected");
    expect(rows[0]).not.toContain("q5_selected");
    expect(rows.every(row => row.length === 28)).toBe(true);
    expect(saveResultsCsv(session, quiz, tempDir).questionCount).toBe(3);
    const summary = saveSessionSummaryMarkdown(session, quiz, tempDir);
    const text = fs.readFileSync(summary.filePath, "utf8");
    expect(text).toContain("| Q3 | Open Response |");
    expect(text).not.toMatch(/Q[45]/);
    expect(text).toContain("- Scored Questions: 1");
  });

  describe("formula injection", () => {
    it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"])("prefixes text starting with %j", (text) => {
      const out = csvEscape(text);
      expect(out.replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    });

    it("leaves ordinary text, numbers and booleans alone", () => {
      expect(csvEscape("Alex Tan")).toBe("Alex Tan");
      expect(csvEscape("a=b")).toBe("a=b");
      expect(csvEscape("A|B")).toBe("A|B");
      expect(csvEscape("")).toBe("");
      expect(csvEscape(-5)).toBe("-5");
      expect(csvEscape(true)).toBe("true");
    });

    it("quotes after prefixing when the cell also needs CSV escaping", () => {
      expect(csvEscape('=SUM(1,2)')).toBe(`"'=SUM(1,2)"`);
      expect(csvEscape("\rx")).toBe(`"'\rx"`);
    });

    it("neutralises names and open responses in the built CSV", () => {
      const { session, quiz } = makeFixture();
      addParticipant(session, "S0005", "sock5", "@evil");
      const rows = parseCsv(buildResultsCsv(session, quiz));
      const header = rows[0];
      const evil = rows.find((r) => r[header.indexOf("student_id")] === "S0005")!;
      expect(evil[header.indexOf("display_name")]).toBe("'@evil");
      const sam = rows.find((r) => r[header.indexOf("student_id")] === "S0002")!;
      expect(sam[header.indexOf("q3_selected")]).toBe(`'=HYPERLINK("http://example.invalid")`);
    });
  });

  it("does not import fs or path (bundles for runtimes without a filesystem)", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../results-csv.ts"), "utf-8");
    const specifiers = [...source.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec).not.toMatch(/^(node:)?(fs|path|os|child_process)(\/.*)?$/);
    }

    // Local modules it pulls in must be free of them as well.
    for (const spec of specifiers.filter((s) => s.startsWith("./"))) {
      const dep = fs.readFileSync(path.resolve(__dirname, "..", `${spec}.ts`), "utf-8");
      expect(dep).not.toMatch(/from\s+["'](node:)?(fs|path|os|child_process)["']/);
    }
  });
});
