import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Quiz } from "@mdq/shared";
import { createSession, addParticipant, recordSubmission, transitionState } from "../session";
import { ensureRunClassification, loadRunClassification, setRunClassification } from "../run-classification";
import { classifyLocalRun } from "../classify-local-run";
import { computeCumulativeLeaderboard, getSessionResultsCsvPath, getSessionSummaryMarkdownPath, loadAllWeeklyResults, loadWeeklyResult, persistSessionOnEnd, saveWeeklyResult } from "../persistence";

const quiz: Quiz = { week: "fixture", title: "Synthetic fixture", sourceFile: "fixture.md", questions: [0, 1, 2].map(index => ({
  index, topic: "Fixture", textMd: "Fixture?", textHtml: "Fixture?", options: [{ label: "A", textMd: "A", textHtml: "A" }],
  correctOptions: ["A"], allowsMultiple: false, explanation: "Fixture", timeLimitSec: 20,
})) };
function run(ids = ["test1"]) {
  const session = createSession(quiz.week, "open");
  ids.forEach((id, index) => addParticipant(session, id, `socket${index}`));
  transitionState(session, "QUESTION_OPEN");
  session.currentQuestionIndex = 0;
  session.questionStartedAt = Date.now() - 1000;
  if (ids.length) recordSubmission(session, ids[0], 0, ["A"]);
  return session;
}

describe("local post-quiz trial classification", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-classification-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

  it("only suggests a possible trial with all conservative signals and explains it", () => {
    const session = run();
    const result = ensureRunClassification(session, quiz, dir, session.createdAt + 30000);
    expect(result.classification).toBe("possible-trial");
    expect(result.reasons).toHaveLength(3);
    expect(result.evidence).toEqual({ participantCount: 1, durationMs: 30000, answeredQuestions: 1, questionCount: 3 });
    expect(loadRunClassification(session.sessionId, dir)).toEqual(result);
  });

  it.each([["s001"], ["s001", "s002"], ["test1", "s001"], [], ["test1", "test2", "test3"]])(
    "does not flag an ordinary small/empty class or mixed/large test-looking cohort %j", (...ids: string[]) => {
      const session = run(ids);
      expect(ensureRunClassification(session, quiz, dir).classification).toBe("normal");
    },
  );

  it("does not use names, low scores, long duration, or complete quizzes as trial proof", () => {
    const ordinary = run(["s001"]);
    ordinary.participants.get("s001")!.displayName = "Test";
    expect(ensureRunClassification(ordinary, quiz, dir).classification).toBe("normal");
    const long = run();
    expect(ensureRunClassification(long, quiz, dir, long.createdAt + 121000).classification).toBe("normal");
    const complete = run();
    complete.submissions.push(...[1, 2].map(questionIndex => ({ ...complete.submissions[0], questionIndex })));
    expect(ensureRunClassification(complete, quiz, dir).classification).toBe("normal");
  });

  it("preserves raw snapshot, submissions and CSV while tagging summary and excluding winners", () => {
    const session = run();
    persistSessionOnEnd(session, quiz, dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "submissions", `${session.sessionId}.json`), "utf8")).submissions).toEqual(session.submissions);
    expect(fs.existsSync(path.join(dir, "sessions", `${session.sessionId}.json`))).toBe(true);
    expect(fs.readFileSync(getSessionResultsCsvPath(session, dir), "utf8")).toContain("test1");
    expect(fs.readFileSync(getSessionSummaryMarkdownPath(session, dir), "utf8")).toContain("Classification: possible-trial");
    expect(fs.existsSync(path.join(dir, "results", `${session.sessionId}.json`))).toBe(true);
    expect(loadWeeklyResult(quiz.week, dir)).toBeNull();
    expect(loadAllWeeklyResults(dir)).toEqual([]);
    expect(computeCumulativeLeaderboard(dir)).toEqual([]);
  });

  it("manual normal wins over suggestions and survives repeat persistence", () => {
    const session = run();
    setRunClassification(session.sessionId, "normal", "Confirmed genuine small classroom", dir);
    persistSessionOnEnd(session, quiz, dir);
    expect(loadWeeklyResult(quiz.week, dir)?.sessionId).toBe(session.sessionId);
    expect(loadRunClassification(session.sessionId, dir)?.source).toBe("manual");
    expect(fs.readFileSync(getSessionSummaryMarkdownPath(session, dir), "utf8")).toContain("Classification: normal");
  });

  it("CLI inspection and reversible overrides preserve history/raw data without duplicate weeks", () => {
    const previous = run(["s001"]);
    persistSessionOnEnd(previous, quiz, dir);
    const latest = run(["s002"]);
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
    persistSessionOnEnd(latest, quiz, dir);
    clock.mockRestore();
    expect(loadWeeklyResult(quiz.week, dir)?.sessionId).toBe(latest.sessionId);
    const csvBefore = fs.readFileSync(getSessionResultsCsvPath(latest, dir), "utf8");
    const args = ["--data-dir", dir, "--session", latest.sessionId];
    expect(classifyLocalRun(args)).toMatchObject({ classification: "normal" });
    expect(classifyLocalRun([...args, "--set", "trial", "--reason", "Instructor rehearsal"])).toMatchObject({ classification: "trial", eligibleForOrdinaryResults: false });
    expect(loadWeeklyResult(quiz.week, dir)?.sessionId).toBe(previous.sessionId);
    expect(loadAllWeeklyResults(dir)).toHaveLength(1);
    expect(classifyLocalRun(["--data-dir", dir, "--eligible-csvs"])).toMatchObject({ csvFiles: [getSessionResultsCsvPath(previous, dir)] });
    expect(computeCumulativeLeaderboard(dir).map(entry => entry.studentId)).toEqual(["s001"]);
    expect(fs.readFileSync(getSessionSummaryMarkdownPath(latest, dir), "utf8")).toContain("Classification: trial");
    expect(classifyLocalRun([...args, "--set", "normal", "--reason", "Review confirmed actual class"])).toMatchObject({ classification: "normal" });
    expect(loadWeeklyResult(quiz.week, dir)?.sessionId).toBe(latest.sessionId);
    expect(loadAllWeeklyResults(dir)).toHaveLength(1);
    expect(loadRunClassification(latest.sessionId, dir)?.history.map(item => item.classification)).toEqual(["normal", "trial", "normal"]);
    expect(fs.readFileSync(getSessionResultsCsvPath(latest, dir), "utf8")).toBe(csvBefore);
    expect(fs.readFileSync(getSessionSummaryMarkdownPath(latest, dir), "utf8").match(/## Local Run Classification/g)).toHaveLength(1);
  });

  it("does not overwrite ordinary weekly winner with a later possible-trial", () => {
    const genuine = run(["s001"]);
    saveWeeklyResult(genuine, quiz, dir);
    const rehearsal = run();
    saveWeeklyResult(rehearsal, quiz, dir);
    expect(loadWeeklyResult(quiz.week, dir)?.sessionId).toBe(genuine.sessionId);
  });

  it("preserves legacy winners, excludes post-hoc flags, and keeps legacy raw files intact", () => {
    const session = run(["s001"]);
    persistSessionOnEnd(session, quiz, dir);
    // Model a pre-feature deployment that has only the existing winner and snapshot files.
    fs.rmSync(path.join(dir, "results"), { recursive: true });
    fs.rmSync(path.join(dir, "classifications"), { recursive: true });
    const args = ["--data-dir", dir, "--session", session.sessionId];
    classifyLocalRun([...args, "--set", "trial", "--reason", "Legacy rehearsal"]);
    expect(loadAllWeeklyResults(dir)).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "winners", "excluded"))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "results", `${session.sessionId}.json`))).toBe(true);
    classifyLocalRun([...args, "--set", "normal", "--reason", "Review corrected flag"]);
    expect(loadWeeklyResult(quiz.week, dir)?.sessionId).toBe(session.sessionId);
  });

  it("fails closed on corrupt classification metadata and rejects unsafe CLI input", () => {
    const session = run(["s001"]);
    persistSessionOnEnd(session, quiz, dir);
    fs.writeFileSync(path.join(dir, "classifications", `${session.sessionId}.json`), "{broken");
    expect(loadAllWeeklyResults(dir)).toEqual([]);
    expect(loadWeeklyResult(quiz.week, dir)).toBeNull();
    expect(classifyLocalRun(["--data-dir", dir, "--eligible-csvs"])).toMatchObject({ csvFiles: [] });
    expect(() => classifyLocalRun(["--data-dir", dir, "--session", "../escape"])).toThrow("Invalid local session ID");
    expect(() => classifyLocalRun(["--data-dir", dir, "--session", session.sessionId, "--set", "trial"])).toThrow();
    expect(() => classifyLocalRun(["--data-dir", dir, "--session", "nonexistent"])).toThrow("No ended local session");
  });
});
