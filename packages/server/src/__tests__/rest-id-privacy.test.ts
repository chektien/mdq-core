import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { Quiz } from "@mdq/shared";
import { createApp, publicCumulativeEntries } from "../app";
import { apply } from "../engine";
import { clearAllSessions, getSession } from "../session";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import { parseQuizMarkdown } from "../parser";

// Saved results and restored review name people by Student ID. These routes may only
// return IDs to a logged-in instructor; with no login configured they return labels only.

const DECK = `# Rest privacy

---

## Say something

question-type: open-response
time-limit: 20

Share a thought.

> Overall Feedback: Thanks.
`;

const winners = {
  week: "week01", sessionId: "s1", totalQuestions: 1, completedAt: 1,
  entries: [
    { rank: 1, studentId: "ZQ-1001", displayName: "Alex", correctCount: 3, totalTimeMs: 100 },
    { rank: 2, studentId: "ZQ-2002", displayName: "alex", correctCount: 2, totalTimeMs: 100 },
    { rank: 3, studentId: "ZQ-3003", correctCount: 1, totalTimeMs: 100 },
  ],
};

describe("REST routes that could carry Student IDs", () => {
  const original = process.env.INSTRUCTOR_PASSWORD;
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-rest-privacy-"));
    fs.writeFileSync(path.join(dir, "rest.md"), DECK);
    fs.mkdirSync(path.join(dir, "data", "winners"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "winners", "week01.json"), JSON.stringify(winners));
    clearAllSessions();
    clearInstructorSessionsForTests();
  });
  afterEach(() => {
    if (typeof original === "string") process.env.INSTRUCTOR_PASSWORD = original;
    else delete process.env.INSTRUCTOR_PASSWORD;
    clearInstructorSessionsForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const build = () => createApp({ quizDir: dir, dataDir: path.join(dir, "data"), shortUrlProviders: [] });

  /** A session that has revealed one open response from ZQ-1001. */
  async function sessionWithOpenResponse(agent: { post: (url: string) => request.Test; get: (url: string) => request.Test }) {
    const created = await (agent.post("/api/session") as request.Test).send({ week: "rest" }).expect(201);
    const sessionId: string = created.body.sessionId;
    const quiz = parseQuizMarkdown(DECK, "rest.md").quiz as Quiz;
    const step = (command: Parameters<typeof apply>[2], at: number) => { const stored = getSession(sessionId)!; Object.assign(stored, apply(stored, quiz, command, at).session); };
    step({ type: "join", socketId: "sock", newToken: "tok", newPublicKey: "pk", payload: { studentId: "ZQ-1001", displayName: "Alex" } }, 1);
    await agent.post(`/api/session/${sessionId}/start`).expect(200);
    step({ type: "answerSubmit", studentId: "ZQ-1001", payload: { questionIndex: 0, responseText: "A thought" } }, 2);
    await agent.post(`/api/session/${sessionId}/close`).expect(200);
    await agent.post(`/api/session/${sessionId}/reveal`).expect(200);
    await agent.post(`/api/session/${sessionId}/leaderboard-show`).expect(200);
    return sessionId;
  }

  describe("with no instructor login configured", () => {
    beforeEach(() => { delete process.env.INSTRUCTOR_PASSWORD; app = build(); });

    it("returns saved results by label, never by Student ID", async () => {
      const res = await request(app).get("/api/leaderboard/cumulative").expect(200);
      expect(JSON.stringify(res.body)).not.toContain("ZQ-");
      expect(JSON.stringify(res.body)).not.toContain("studentId");
      expect(res.body.entries.map((e: { rank: number; label: string; totalCorrect: number }) => [e.rank, e.label, e.totalCorrect]))
        .toEqual([[1, "Alex", 3], [2, "alex (2)", 2], [3, "Participant 3", 1]]);
    });

    it("restores open responses by label, never by Student ID or name", async () => {
      const sessionId = await sessionWithOpenResponse(request(app));
      const res = await request(app).get(`/api/session/${sessionId}/state`).expect(200);
      expect(res.body.reviewReveals).toHaveLength(1);
      const [response] = res.body.reviewReveals[0].openResponses;
      expect(response).toMatchObject({ label: "Alex", responseText: "A thought" });
      expect(JSON.stringify(res.body)).not.toContain("ZQ-1001");
      expect(response.studentId).toBeUndefined();
      expect(response.displayName).toBeUndefined();
    });
  });

  describe("with an instructor login configured", () => {
    beforeEach(() => { process.env.INSTRUCTOR_PASSWORD = "secret-password"; app = build(); });

    it("refuses saved results and restore without the login", async () => {
      await request(app).get("/api/leaderboard/cumulative").expect(401);
      await request(app).get("/api/session/anything/state").expect(401);
    });

    it("gives the logged-in instructor Student IDs in both", async () => {
      const agent = request.agent(app);
      await agent.post("/api/instructor/login").send({ password: "secret-password" }).expect(204);
      const cumulative = await agent.get("/api/leaderboard/cumulative").expect(200);
      expect(cumulative.body.entries.map((e: { studentId: string }) => e.studentId)).toEqual(["ZQ-1001", "ZQ-2002", "ZQ-3003"]);
      const sessionId = await sessionWithOpenResponse(agent);
      const restored = await agent.get(`/api/session/${sessionId}/state`).expect(200);
      expect(restored.body.reviewReveals[0].openResponses[0]).toMatchObject({ studentId: "ZQ-1001", displayName: "Alex", label: "Alex" });
    });
  });

  it("gives every saved-results label once, in rank order", () => {
    const rows = publicCumulativeEntries([
      { rank: 1, studentId: "a", displayName: "Sam", totalCorrect: 1, totalTimeMs: 1, weeksParticipated: 1 },
      { rank: 2, studentId: "b", displayName: "SAM", totalCorrect: 1, totalTimeMs: 2, weeksParticipated: 1 },
      { rank: 3, studentId: "c", displayName: "  ", totalCorrect: 1, totalTimeMs: 3, weeksParticipated: 1 },
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Sam", "SAM (2)", "Participant 3"]);
  });
});
