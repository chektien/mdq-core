import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../app";
import { parseQuizMarkdown, QuizParseError } from "../parser";
import { buildDeckValidationResponse, likelyValidationFix } from "../deck-validation";
import { clearAllSessions } from "../session";
import { clearInstructorSessionsForTests } from "../instructor-auth";

const brokenDeck = `# Written responses
---
## First prompt
Name a useful tool.
---
## Second prompt
type: unsupported
Describe your workflow.
`;
const fixedDeck = `# Written responses
---
## First prompt
type: open_response
Name a useful tool.
---
## Second prompt
type: open_response
Describe your workflow.
`;

describe("deck authoring diagnostics and reload recovery", () => {
  let dir: string;
  let warning: jest.SpyInstance;
  const originalPassword = process.env.INSTRUCTOR_PASSWORD;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-validation-"));
    warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.INSTRUCTOR_PASSWORD = "fixture-instructor-password";
  });
  afterEach(() => {
    warning.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    clearAllSessions();
    clearInstructorSessionsForTests();
    if (originalPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD;
    else process.env.INSTRUCTOR_PASSWORD = originalPassword;
  });

  it("lists every reported parser error grouped by file, with unchanged details and precise locations", async () => {
    fs.writeFileSync(path.join(dir, "written.md"), brokenDeck);
    fs.writeFileSync(path.join(dir, "theme.md"), fixedDeck.replace("# Written responses", "# Theme\ntheme: sepia"));
    const app = createApp({ quizDir: dir, shortUrlProviders: [] });
    const response = await request(app).get("/api/decks").expect(409);
    expect(response.body.validation.issueCount).toBe(3);
    expect(response.body.validation.files.map((file: { sourceFile: string }) => file.sourceFile)).toEqual(["theme.md", "written.md"]);
    const written = response.body.validation.files[1];
    const parsed = parseQuizMarkdown(brokenDeck, "written.md");
    expect(written.issues).toEqual(parsed.errors.map((error) => ({
      questionIndex: error.questionIndex,
      lineNumber: error.lineNumber,
      detail: error.detail,
      likelyFix: expect.any(String),
    })));
    expect(written.issues[0].likelyFix).toContain("type: open_response");
    expect(written.issues[0].likelyFix).toContain("A. First choice");
    for (const error of parsed.errors) {
      expect(response.body.error).toContain(`${error.sourceFile}:${error.lineNumber}`);
      expect(response.body.error).toContain(error.detail);
    }
    expect(response.body.error).toContain("No server restart is needed");
  });

  it.each([
    ["/api/decks", "/api/decks/reload"],
    ["/api/quizzes", "/api/quizzes/reload"],
  ])("recovers initial validation failure through %s and %s on the same server app", async (listUrl, reloadUrl) => {
    const deckPath = path.join(dir, "written.md");
    fs.writeFileSync(deckPath, brokenDeck);
    const app = createApp({ quizDir: dir, shortUrlProviders: [] });
    const instructor = request.agent(app);
    await instructor.post("/api/instructor/login").send({ password: process.env.INSTRUCTOR_PASSWORD }).expect(204);
    await instructor.get(listUrl).expect(409);
    await instructor.post("/api/session").send({ week: "written" }).expect(409);
    await instructor.post(reloadUrl).expect(409);

    fs.writeFileSync(deckPath, fixedDeck);
    // Saving alone does not change the cached result. The recovery is Reload Decks.
    await instructor.get(listUrl).expect(409);
    await request(app).post(reloadUrl).expect(401);
    const recovered = await instructor.post(reloadUrl).expect(200);
    expect(recovered.body.loaded).toBe(1);
    expect(recovered.body.quizzes).toEqual([expect.objectContaining({ week: "written", questionCount: 2 })]);
    expect(recovered.body.validation).toBeUndefined();
    expect((await instructor.get(listUrl).expect(200)).body).toEqual(recovered.body.quizzes);
    const created = await instructor.post("/api/session").send({ week: "written" }).expect(201);
    await instructor.post(`/api/session/${created.body.sessionId}/start`).expect(200);
    const state = await instructor.get(`/api/session/${created.body.sessionId}/state`).expect(200);
    expect(state.body.state).toBe("QUESTION_OPEN");
    expect(state.body.questionCount).toBe(2);
  });

  it("clears validation when the broken file is removed and reloads files added to an empty library", async () => {
    const deckPath = path.join(dir, "written.md");
    fs.writeFileSync(deckPath, brokenDeck);
    const app = createApp({ quizDir: dir, shortUrlProviders: [] });
    const instructor = request.agent(app);
    await instructor.post("/api/instructor/login").send({ password: process.env.INSTRUCTOR_PASSWORD }).expect(204);
    await instructor.get("/api/decks").expect(409);
    fs.unlinkSync(deckPath);
    expect((await instructor.post("/api/decks/reload").expect(200)).body).toEqual({ loaded: 0, quizzes: [] });
    expect((await instructor.get("/api/decks").expect(200)).body).toEqual([]);
    fs.writeFileSync(deckPath, fixedDeck);
    expect((await instructor.post("/api/decks/reload").expect(200)).body.loaded).toBe(1);
  });

  it.each([
    ["slide items must not define answer options", "Remove the lettered options"],
    ["slide items must not define correct answers", "Remove the '> Correct Answer:'"],
    ["slide items must not use time-limit", "Remove the 'time_limit:'"],
    ["open-response questions must not use multi-select", "Remove the 'multi_select:'"],
    ["Missing correct answer line", "> Correct Answer: A"],
    ["Correct answer \"Z\" does not match any option label (A, B)", "lettered options"],
    ["Invalid theme: sepia", "theme: light"],
    ["Use '> Correct Answers: X, Y' when a question has multiple correct options", "> Correct Answers: A, B"],
  ])("offers syntax-specific guidance for %s", (detail, expected) => {
    expect(likelyValidationFix(detail)).toContain(expected);
  });

  it("preserves original parser messages and supplies useful unknown-error fallback text", () => {
    const error = new QuizParseError("example.md", 0, "A new parser diagnostic", 9);
    const originalMessage = error.message;
    const response = buildDeckValidationResponse([error]);
    expect(error.message).toBe(originalMessage);
    expect(response.validation.files[0].issues[0].detail).toBe(error.detail);
    expect(response.validation.files[0].issues[0].likelyFix).toContain("Markdown syntax");
  });
});
