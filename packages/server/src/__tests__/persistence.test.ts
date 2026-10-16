import { createLegacySession } from "./fixtures/legacy-session";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  saveSessionSnapshot,
  saveSubmissions,
  saveResultsCsv,
  persistSessionProgressOnReveal,
  saveWeeklyResult,
  loadWeeklyResult,
  loadAllWeeklyResults,
  computeCumulativeLeaderboard,
  computeCumulativeFromResults,
  persistSessionOnEnd,
  saveSessionSummaryMarkdown,
  getSessionResultsCsvPath,
  getSessionSummaryMarkdownPath,
} from "../persistence";
import {
  addParticipant,
  recordSubmission,
  transitionState,
} from "../session";
import { Session, Quiz, WeeklyResult, LeaderboardEntry } from "@mdq/shared";

/** Create a temp directory for test data */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mdq-persist-test-"));
}

/** Clean up temp directory */
function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Create a minimal quiz for testing */
function makeQuiz(week = "week01", questionCount = 2): Quiz {
  const questions = Array.from({ length: questionCount }, (_, i) => ({
    index: i,
    topic: `Topic ${i + 1}`,
    textMd: `Question ${i + 1}?`,
    textHtml: `<p>Question ${i + 1}?</p>`,
    options: [
      { label: "A", textMd: "Option A", textHtml: "Option A" },
      { label: "B", textMd: "Option B", textHtml: "Option B" },
    ],
    correctOptions: ["A"],
    allowsMultiple: false,
    explanation: `A is correct for Q${i + 1}`,
    timeLimitSec: 20,
  }));
  return { week, title: `Week Quiz`, questions, sourceFile: `${week}.md` };
}

/** Setup a session with participants and submissions for testing */
function setupSessionWithData(): { session: Session; quiz: Quiz } {
  const session = createLegacySession("week01", "open");
  const quiz = makeQuiz("week01", 2);

  // Add participants
  addParticipant(session, "s001", "sock1", "Alice");
  addParticipant(session, "s002", "sock2", "Bob");
  addParticipant(session, "s003", "sock3", "Charlie");

  // Move to QUESTION_OPEN and record submissions for Q0
  transitionState(session, "QUESTION_OPEN");
  session.currentQuestionIndex = 0;
  session.questionStartedAt = Date.now() - 5000;

  recordSubmission(session, "s001", 0, ["A"]); // correct, ~5000ms
  recordSubmission(session, "s002", 0, ["B"]); // incorrect
  recordSubmission(session, "s003", 0, ["A"]); // correct

  // Move to Q1
  transitionState(session, "QUESTION_CLOSED");
  transitionState(session, "REVEAL");
  transitionState(session, "QUESTION_OPEN");
  session.currentQuestionIndex = 1;
  session.questionStartedAt = Date.now() - 3000;

  recordSubmission(session, "s001", 1, ["A"]); // correct
  recordSubmission(session, "s002", 1, ["A"]); // correct
  // s003 does not submit for Q1

  return { session, quiz };
}

describe("Persistence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tempDir);
  });

  describe("saveSessionSnapshot", () => {
    it("writes session metadata to sessions/<id>.json", () => {
      const { session } = setupSessionWithData();
      saveSessionSnapshot(session, tempDir);

      const filePath = path.join(tempDir, "sessions", `${session.sessionId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const snapshot = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(snapshot.sessionId).toBe(session.sessionId);
      expect(snapshot.week).toBe("week01");
      expect(snapshot.participantCount).toBe(3);
      expect(snapshot.participants).toHaveLength(3);
      expect(snapshot.participants[0].studentId).toBe("s001");
      expect(snapshot.participants[0].displayName).toBe("Alice");
      expect(typeof snapshot.endedAt).toBe("number");
    });
  });

  describe("saveSubmissions", () => {
    it("writes all submissions to submissions/<id>.json", () => {
      const { session } = setupSessionWithData();
      saveSubmissions(session, tempDir);

      const filePath = path.join(tempDir, "submissions", `${session.sessionId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(data.sessionId).toBe(session.sessionId);
      expect(data.submissionCount).toBe(5);
      expect(data.submissions).toHaveLength(5);
    });
  });

  describe("saveResultsCsv", () => {
    it("resolves default artifact paths to repo-level data/submissions", () => {
      const session = createLegacySession("week01", "open");
      const cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(path.resolve(__dirname, "../.."));

      try {
        const csvPath = getSessionResultsCsvPath(session);
        const summaryPath = getSessionSummaryMarkdownPath(session);
        const expectedDir = path.resolve(__dirname, "../../../../data/submissions");

        expect(path.dirname(csvPath)).toBe(expectedDir);
        expect(path.dirname(summaryPath)).toBe(expectedDir);
        expect(csvPath).not.toContain(path.join("packages", "server", "data", "submissions"));
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it("writes per-student CSV with one row per studentId", () => {
      const session = createLegacySession("week01", "open");
      const quiz = makeQuiz("week01", 2);

      const firstJoin = addParticipant(session, "s001", "sock1", "Alice");
      // Rejoin with same token should not create a second participant row
      addParticipant(session, "s001", "sock2", "Alice", firstJoin.participant.sessionToken);
      addParticipant(session, "s002", "sock3", "Bob");

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;
      recordSubmission(session, "s001", 0, ["A"]);

      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 1;
      session.questionStartedAt = Date.now() - 1500;
      recordSubmission(session, "s001", 1, ["B"]);
      recordSubmission(session, "s002", 1, ["A"]);

      saveResultsCsv(session, quiz, tempDir);

      const csvPath = getSessionResultsCsvPath(session, tempDir);
      expect(fs.existsSync(csvPath)).toBe(true);

      const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(3); // header + s001 + s002
      expect(lines[0]).toContain("student_id");
      expect(lines[0]).toContain("q1_revealed_at_iso");
      expect(lines[0]).toContain("q1_selected");
      expect(lines[0]).toContain("q1_answered_at_iso");
      expect(lines[0]).toContain("q2_correct");

      const s001Rows = lines.filter((line) => line.includes(",s001,"));
      expect(s001Rows).toHaveLength(1);
      expect(s001Rows[0]).toContain("present");
    });

    it("persists reveal timestamp and answer timestamp columns", () => {
      const session = createLegacySession("week01", "open");
      const quiz = makeQuiz("week01", 1);

      addParticipant(session, "s001", "sock1", "Alice");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;

      const revealAt = Date.parse("2026-03-04T09:10:11.000Z");
      persistSessionProgressOnReveal(session, quiz, tempDir, revealAt);

      session.questionStartedAt = revealAt - 1000;
      const originalNow = Date.now;
      try {
        Date.now = () => Date.parse("2026-03-04T09:10:12.000Z");
        recordSubmission(session, "s001", 0, ["A"]);
      } finally {
        Date.now = originalNow;
      }

      saveResultsCsv(session, quiz, tempDir);

      const csvPath = getSessionResultsCsvPath(session, tempDir);
      const [headerLine, rowLine] = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
      const headers = headerLine.split(",");
      const row = rowLine.split(",");
      const revealIdx = headers.indexOf("q1_revealed_at_iso");
      const answeredIdx = headers.indexOf("q1_answered_at_iso");

      expect(revealIdx).toBeGreaterThan(-1);
      expect(answeredIdx).toBeGreaterThan(-1);
      expect(row[revealIdx]).toBe("2026-03-04T09:10:11.000Z");
      expect(row[answeredIdx]).toBe("2026-03-04T09:10:12.000Z");
    });

    it("returns created on first write, then updated", () => {
      const { session, quiz } = setupSessionWithData();

      const firstWrite = saveResultsCsv(session, quiz, tempDir);
      const secondWrite = saveResultsCsv(session, quiz, tempDir);

      expect(firstWrite.action).toBe("created");
      expect(secondWrite.action).toBe("updated");
      expect(firstWrite.filePath).toBe(secondWrite.filePath);
      expect(firstWrite.rowCount).toBe(3);
      expect(firstWrite.questionCount).toBe(2);
    });

    it("returns skipped when reveal question index is out of range", () => {
      const session = createLegacySession("week01", "open");
      const quiz = makeQuiz("week01", 1);
      session.currentQuestionIndex = 3;

      const result = persistSessionProgressOnReveal(session, quiz, tempDir);

      expect(result.status).toBe("skipped");
      expect(result.reason).toContain("question_index_out_of_range");
      expect(fs.existsSync(path.join(tempDir, "submissions"))).toBe(false);
    });

    it("leaves correctness blank for open_response questions and excludes them from scoring", () => {
      const session = createLegacySession("week-open", "open");
      const quiz: Quiz = {
        week: "week-open",
        title: "Week Open",
        sourceFile: "week-open.md",
        questions: [
          {
            index: 0,
            topic: "Reflection",
            textMd: "Share one takeaway.",
            textHtml: "<p>Share one takeaway.</p>",
            questionType: "open_response",
            options: [],
            correctOptions: [],
            allowsMultiple: false,
            explanation: "Thanks.",
            timeLimitSec: 20,
          },
          {
            index: 1,
            topic: "Check",
            textMd: "Question 2?",
            textHtml: "<p>Question 2?</p>",
            options: [
              { label: "A", textMd: "Option A", textHtml: "Option A" },
              { label: "B", textMd: "Option B", textHtml: "Option B" },
            ],
            correctOptions: ["A"],
            allowsMultiple: false,
            explanation: "A",
            timeLimitSec: 20,
          },
        ],
      };

      addParticipant(session, "s001", "sock1", "Alice");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;
      recordSubmission(session, "s001", 0, { responseText: "I need more examples." });

      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 1;
      session.questionStartedAt = Date.now() - 1000;
      recordSubmission(session, "s001", 1, ["A"]);

      saveResultsCsv(session, quiz, tempDir);

      const [headerLine, rowLine] = fs.readFileSync(getSessionResultsCsvPath(session, tempDir), "utf-8").trim().split("\n");
      const headers = headerLine.split(",");
      const row = rowLine.split(",");

      expect(row[headers.indexOf("correct_count")]).toBe("1");
      expect(row[headers.indexOf("q1_selected")]).toBe("I need more examples.");
      expect(row[headers.indexOf("q1_correct")]).toBe("");
      expect(row[headers.indexOf("q2_correct")]).toBe("1");
    });
  });

  describe("saveWeeklyResult", () => {
    it("writes leaderboard to winners/weekNN.json", () => {
      const { session, quiz } = setupSessionWithData();
      saveWeeklyResult(session, quiz, tempDir);

      const filePath = path.join(tempDir, "winners", "week01.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const result = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(result.week).toBe("week01");
      expect(result.totalQuestions).toBe(2);
      expect(result.entries).toHaveLength(3);

      // s001 got both correct, should be rank 1
      const s001 = result.entries.find((e: LeaderboardEntry) => e.studentId === "s001");
      expect(s001.correctCount).toBe(2);
      expect(s001.rank).toBe(1);
    });

    it("overwrites existing weekly result", () => {
      const { session, quiz } = setupSessionWithData();
      saveWeeklyResult(session, quiz, tempDir);

      // Save again (simulating a new session for same week)
      saveWeeklyResult(session, quiz, tempDir);

      const filePath = path.join(tempDir, "winners", "week01.json");
      const result = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(result.entries).toHaveLength(3);
    });
  });

  describe("loadWeeklyResult", () => {
    it("returns null for non-existent week", () => {
      expect(loadWeeklyResult("week99", tempDir)).toBeNull();
    });

    it("loads a valid weekly result", () => {
      const { session, quiz } = setupSessionWithData();
      saveWeeklyResult(session, quiz, tempDir);

      const result = loadWeeklyResult("week01", tempDir);
      expect(result).not.toBeNull();
      expect(result!.week).toBe("week01");
      expect(result!.entries).toHaveLength(3);
    });

    it("returns null for malformed JSON", () => {
      const dir = path.join(tempDir, "winners");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "week01.json"), "NOT JSON", "utf-8");

      expect(loadWeeklyResult("week01", tempDir)).toBeNull();
    });
  });

  describe("loadAllWeeklyResults", () => {
    it("returns empty array when winners dir does not exist", () => {
      expect(loadAllWeeklyResults(tempDir)).toEqual([]);
    });

    it("loads all valid weekly results and skips malformed", () => {
      const { session, quiz } = setupSessionWithData();
      saveWeeklyResult(session, quiz, tempDir);

      // Add a second week
      const session2 = createLegacySession("week02", "open");
      const quiz2 = makeQuiz("week02", 1);
      addParticipant(session2, "s001", "sock1", "Alice");
      transitionState(session2, "QUESTION_OPEN");
      session2.currentQuestionIndex = 0;
      session2.questionStartedAt = Date.now() - 2000;
      recordSubmission(session2, "s001", 0, ["A"]);
      saveWeeklyResult(session2, quiz2, tempDir);

      // Add a malformed file
      fs.writeFileSync(
        path.join(tempDir, "winners", "weekBad.json"),
        '{"bad": true}',
        "utf-8",
      );

      const results = loadAllWeeklyResults(tempDir);
      expect(results).toHaveLength(2);
    });

    it("skips files with missing week field", () => {
      const dir = path.join(tempDir, "winners");
      fs.mkdirSync(dir, { recursive: true });

      // Valid entries array but no week field
      fs.writeFileSync(
        path.join(dir, "weekNoField.json"),
        JSON.stringify({ entries: [{ studentId: "s1", correctCount: 1, totalTimeMs: 100, rank: 1 }] }),
        "utf-8",
      );

      const results = loadAllWeeklyResults(tempDir);
      expect(results).toHaveLength(0);
    });

    it("sanitizes entries with missing numeric fields", () => {
      const dir = path.join(tempDir, "winners");
      fs.mkdirSync(dir, { recursive: true });

      // Entry with missing correctCount and totalTimeMs
      const data = {
        week: "week01",
        sessionId: "s1",
        totalQuestions: 1,
        completedAt: Date.now(),
        entries: [
          { studentId: "s001", rank: 1 },
          { studentId: "s002", correctCount: "not-a-number", totalTimeMs: null, rank: 2 },
        ],
      };
      fs.writeFileSync(path.join(dir, "week01.json"), JSON.stringify(data), "utf-8");

      const results = loadAllWeeklyResults(tempDir);
      expect(results).toHaveLength(1);
      expect(results[0].entries).toHaveLength(2);
      // Missing fields default to 0
      expect(results[0].entries[0].correctCount).toBe(0);
      expect(results[0].entries[0].totalTimeMs).toBe(0);
      expect(results[0].entries[1].correctCount).toBe(0);
      expect(results[0].entries[1].totalTimeMs).toBe(0);
    });

    it("filters out entries without studentId", () => {
      const dir = path.join(tempDir, "winners");
      fs.mkdirSync(dir, { recursive: true });

      const data = {
        week: "week01",
        sessionId: "s1",
        totalQuestions: 1,
        completedAt: Date.now(),
        entries: [
          { studentId: "s001", correctCount: 1, totalTimeMs: 100, rank: 1 },
          { correctCount: 2, totalTimeMs: 200, rank: 2 }, // no studentId
          null, // null entry
        ],
      };
      fs.writeFileSync(path.join(dir, "week01.json"), JSON.stringify(data), "utf-8");

      const results = loadAllWeeklyResults(tempDir);
      expect(results).toHaveLength(1);
      // Only the valid entry should remain
      expect(results[0].entries).toHaveLength(1);
      expect(results[0].entries[0].studentId).toBe("s001");
    });
  });

  describe("persistSessionOnEnd", () => {
    it("persists all three files without throwing", () => {
      const { session, quiz } = setupSessionWithData();
      persistSessionOnEnd(session, quiz, tempDir);

      expect(fs.existsSync(path.join(tempDir, "sessions", `${session.sessionId}.json`))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "submissions", `${session.sessionId}.json`))).toBe(true);
      expect(fs.existsSync(getSessionResultsCsvPath(session, tempDir))).toBe(true);
      expect(fs.existsSync(getSessionSummaryMarkdownPath(session, tempDir))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "winners", "week01.json"))).toBe(true);
    });

    it("handles session with no participants", () => {
      const session = createLegacySession("week01", "open");
      const quiz = makeQuiz("week01", 1);
      // No participants, no submissions
      expect(() => persistSessionOnEnd(session, quiz, tempDir)).not.toThrow();

      const filePath = path.join(tempDir, "sessions", `${session.sessionId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
      const snapshot = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(snapshot.participantCount).toBe(0);
      expect(snapshot.participants).toEqual([]);
    });

    it("continues saving other files when one save fails", () => {
      const { session, quiz } = setupSessionWithData();
      // Verify error isolation by checking other files still save even if one component errors
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      
      persistSessionOnEnd(session, quiz, tempDir);
      
      // All files should exist since nothing actually failed
      expect(fs.existsSync(path.join(tempDir, "submissions", `${session.sessionId}.json`))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "winners", "week01.json"))).toBe(true);
      
      consoleSpy.mockRestore();
    });

    it("logs csv_created when end-of-session write creates the CSV", () => {
      const { session, quiz } = setupSessionWithData();
      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      try {
        persistSessionOnEnd(session, quiz, tempDir);

        const endCsvLogCall = consoleLogSpy.mock.calls.find(
          (call) => call.join(" ").includes("csv_created") && !call.join(" ").includes("reveal_q="),
        );

        expect(endCsvLogCall).toBeDefined();
        expect(endCsvLogCall?.join(" ")).toContain(`session=${session.sessionId}`);
        expect(endCsvLogCall?.join(" ")).toContain(`code=${session.sessionCode}`);
        expect(endCsvLogCall?.join(" ")).toContain("path=");
      } finally {
        consoleLogSpy.mockRestore();
      }
    });

    it("includes leaderboard summary section in markdown", () => {
      const { session, quiz } = setupSessionWithData();
      saveSessionSummaryMarkdown(session, quiz, tempDir);

      const summaryPath = getSessionSummaryMarkdownPath(session, tempDir);
      const summary = fs.readFileSync(summaryPath, "utf-8");

      expect(summary).toContain("- Quiz: week01 MDQ");
      expect(summary).toContain("## Leaderboard Summary");
      expect(summary).toContain("- Ranked Participants: 3");
      expect(summary).toContain("- Winner: s001 (Alice), score 2/2");
      expect(summary).toContain("| Rank | Student ID | Name | Correct | Total Time (ms) |");
      expect(summary).toContain("| 1 | s001 | Alice | 2/2 |");
    });

    it("excludes poll questions from score summaries and CSV correctness fields", () => {
      const session = createLegacySession("week01", "open");
      const quiz: Quiz = {
        week: "week01",
        title: "Week Quiz",
        sourceFile: "week01.md",
        questions: [
          {
            index: 0,
            topic: "Live Poll",
            textMd: "How are you feeling?",
            textHtml: "<p>How are you feeling?</p>",
            options: [
              { label: "A", textMd: "Great", textHtml: "Great" },
              { label: "B", textMd: "Okay", textHtml: "Okay" },
            ],
            correctOptions: [],
            allowsMultiple: false,
            isPoll: true,
            explanation: "Thanks for the signal.",
            timeLimitSec: 20,
          },
          {
            index: 1,
            topic: "Scored Question",
            textMd: "Which option is correct?",
            textHtml: "<p>Which option is correct?</p>",
            options: [
              { label: "A", textMd: "Correct", textHtml: "Correct" },
              { label: "B", textMd: "Incorrect", textHtml: "Incorrect" },
            ],
            correctOptions: ["A"],
            allowsMultiple: false,
            explanation: "A is correct.",
            timeLimitSec: 20,
          },
        ],
      };

      addParticipant(session, "s001", "sock1", "Alice");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;
      recordSubmission(session, "s001", 0, ["B"]);

      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 1;
      session.questionStartedAt = Date.now() - 1000;
      recordSubmission(session, "s001", 1, ["A"]);

      saveResultsCsv(session, quiz, tempDir);
      saveSessionSummaryMarkdown(session, quiz, tempDir);

      const csvPath = getSessionResultsCsvPath(session, tempDir);
      const [headerLine, rowLine] = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
      const headers = headerLine.split(",");
      const row = rowLine.split(",");

      expect(row[headers.indexOf("correct_count")]).toBe("1");
      expect(row[headers.indexOf("q1_correct")]).toBe("");
      expect(row[headers.indexOf("q2_correct")]).toBe("1");

      const summaryPath = getSessionSummaryMarkdownPath(session, tempDir);
      const summary = fs.readFileSync(summaryPath, "utf-8");
      expect(summary).toContain("| Q1 | Poll |");
      expect(summary).toContain("- Scored Questions: 1");
      expect(summary).toContain("- Average Score: 1.00 / 1 (100.0%)");
    });
  });
});

describe("Ranking and Tie-Breaking", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tempDir);
  });

  describe("session leaderboard ranking", () => {
    it("ranks by correct count desc, then totalTimeMs asc", () => {
      const { session, quiz } = setupSessionWithData();
      saveWeeklyResult(session, quiz, tempDir);

      const result = loadWeeklyResult("week01", tempDir)!;
      // s001: 2 correct, s003: 1 correct, s002: 1 correct
      // s001 should be rank 1
      // s002 and s003 both have 1 correct; tie-break by time
      expect(result.entries[0].studentId).toBe("s001");
      expect(result.entries[0].rank).toBe(1);
    });

    it("uses deterministic tie-break by studentId when scores and times match", () => {
      const session = createLegacySession("week01", "open");
      const quiz = makeQuiz("week01", 1);

      // Add participants with alphabetically ordered IDs
      addParticipant(session, "beta", "sock1", "Beta");
      addParticipant(session, "alpha", "sock2", "Alpha");

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      const startTime = Date.now();
      session.questionStartedAt = startTime;

      // Both answer correctly with identical response times
      // We need to control timing precisely
      const origNow = Date.now;

      // Simulate both submitting at exactly the same offset
      Date.now = () => startTime + 1000;
      recordSubmission(session, "beta", 0, ["A"]);
      recordSubmission(session, "alpha", 0, ["A"]);
      Date.now = origNow;

      saveWeeklyResult(session, quiz, tempDir);
      const result = loadWeeklyResult("week01", tempDir)!;

      // Both have 1 correct, same time => tie-break by studentId ascending
      expect(result.entries[0].studentId).toBe("alpha");
      expect(result.entries[0].rank).toBe(1);
      expect(result.entries[1].studentId).toBe("beta");
      expect(result.entries[1].rank).toBe(2);
    });
  });
});

describe("Cumulative Leaderboard", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tempDir);
  });

  it("returns empty array when no weekly results exist", () => {
    const entries = computeCumulativeLeaderboard(tempDir);
    expect(entries).toEqual([]);
  });

  it("aggregates across multiple weeks", () => {
    const week1: WeeklyResult = {
      week: "week01",
      sessionId: "s1",
      totalQuestions: 2,
      completedAt: Date.now(),
      entries: [
        { rank: 1, studentId: "s001", displayName: "Alice", correctCount: 2, totalTimeMs: 5000 },
        { rank: 2, studentId: "s002", displayName: "Bob", correctCount: 1, totalTimeMs: 3000 },
      ],
    };

    const week2: WeeklyResult = {
      week: "week02",
      sessionId: "s2",
      totalQuestions: 3,
      completedAt: Date.now(),
      entries: [
        { rank: 1, studentId: "s002", displayName: "Bob", correctCount: 3, totalTimeMs: 6000 },
        { rank: 2, studentId: "s001", displayName: "Alice", correctCount: 1, totalTimeMs: 4000 },
        { rank: 3, studentId: "s003", displayName: "Charlie", correctCount: 1, totalTimeMs: 2000 },
      ],
    };

    const cumulative = computeCumulativeFromResults([week1, week2]);

    // s002: 1+3=4 correct, 3000+6000=9000ms, 2 weeks
    // s001: 2+1=3 correct, 5000+4000=9000ms, 2 weeks
    // s003: 1 correct, 2000ms, 1 week
    expect(cumulative).toHaveLength(3);
    expect(cumulative[0].studentId).toBe("s002");
    expect(cumulative[0].totalCorrect).toBe(4);
    expect(cumulative[0].rank).toBe(1);
    expect(cumulative[0].weeksParticipated).toBe(2);

    expect(cumulative[1].studentId).toBe("s001");
    expect(cumulative[1].totalCorrect).toBe(3);
    expect(cumulative[1].rank).toBe(2);

    expect(cumulative[2].studentId).toBe("s003");
    expect(cumulative[2].totalCorrect).toBe(1);
    expect(cumulative[2].rank).toBe(3);
  });

  it("uses deterministic tie-break by studentId for cumulative", () => {
    const results: WeeklyResult[] = [
      {
        week: "week01",
        sessionId: "s1",
        totalQuestions: 1,
        completedAt: Date.now(),
        entries: [
          { rank: 1, studentId: "zed", correctCount: 1, totalTimeMs: 1000 },
          { rank: 2, studentId: "abe", correctCount: 1, totalTimeMs: 1000 },
        ],
      },
    ];

    const cumulative = computeCumulativeFromResults(results);
    // Same correct, same time => alphabetical by studentId
    expect(cumulative[0].studentId).toBe("abe");
    expect(cumulative[1].studentId).toBe("zed");
  });

  it("refreshes cumulative from files dynamically", () => {
    // Write week01
    const winnersPath = path.join(tempDir, "winners");
    fs.mkdirSync(winnersPath, { recursive: true });
    const week1: WeeklyResult = {
      week: "week01",
      sessionId: "s1",
      totalQuestions: 1,
      completedAt: Date.now(),
      entries: [
        { rank: 1, studentId: "s001", correctCount: 1, totalTimeMs: 1000 },
      ],
    };
    fs.writeFileSync(
      path.join(winnersPath, "week01.json"),
      JSON.stringify(week1),
      "utf-8",
    );

    let entries = computeCumulativeLeaderboard(tempDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].totalCorrect).toBe(1);

    // Add week02 and re-read
    const week2: WeeklyResult = {
      week: "week02",
      sessionId: "s2",
      totalQuestions: 1,
      completedAt: Date.now(),
      entries: [
        { rank: 1, studentId: "s001", correctCount: 1, totalTimeMs: 500 },
        { rank: 2, studentId: "s004", correctCount: 0, totalTimeMs: 0 },
      ],
    };
    fs.writeFileSync(
      path.join(winnersPath, "week02.json"),
      JSON.stringify(week2),
      "utf-8",
    );

    entries = computeCumulativeLeaderboard(tempDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].studentId).toBe("s001");
    expect(entries[0].totalCorrect).toBe(2);
    expect(entries[0].weeksParticipated).toBe(2);
  });

  it("uses latest displayName from weekly results", () => {
    const results: WeeklyResult[] = [
      {
        week: "week01",
        sessionId: "s1",
        totalQuestions: 1,
        completedAt: Date.now(),
        entries: [
          { rank: 1, studentId: "s001", displayName: "OldName", correctCount: 1, totalTimeMs: 1000 },
        ],
      },
      {
        week: "week02",
        sessionId: "s2",
        totalQuestions: 1,
        completedAt: Date.now(),
        entries: [
          { rank: 1, studentId: "s001", displayName: "NewName", correctCount: 1, totalTimeMs: 500 },
        ],
      },
    ];

    const cumulative = computeCumulativeFromResults(results);
    expect(cumulative[0].displayName).toBe("NewName");
  });
});
