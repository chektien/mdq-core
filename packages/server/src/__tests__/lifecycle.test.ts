import request from "supertest";
import { createApp } from "../app";
import { clearAllSessions, getSession } from "../session";
import { setCachedAccessInfo } from "../access-info";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const quizDir = path.join(__dirname, "fixtures/quizzes");

describe("REST API", () => {
  const app = createApp({ quizDir, shortUrlProviders: [] });

  beforeEach(() => {
    clearAllSessions();
    clearInstructorSessionsForTests();
    setCachedAccessInfo(null);
  });

  describe("Instructor login", () => {
    const originalInstructorPassword = process.env.INSTRUCTOR_PASSWORD;

    afterEach(() => {
      if (typeof originalInstructorPassword === "string") {
        process.env.INSTRUCTOR_PASSWORD = originalInstructorPassword;
      } else {
        delete process.env.INSTRUCTOR_PASSWORD;
      }
      clearInstructorSessionsForTests();
    });

    it("blocks instructor endpoints until login when password is configured", async () => {
      process.env.INSTRUCTOR_PASSWORD = "secret-password";
      const protectedApp = createApp(quizDir);

      await request(protectedApp)
        .post("/api/session")
        .send({ week: "week01" })
        .expect(401);

      await request(protectedApp)
        .get("/api/session/nope/state")
        .expect(401);

      await request(protectedApp)
        .post("/api/instructor/login")
        .send({ password: "wrong" })
        .expect(401);

      const agent = request.agent(protectedApp);
      await agent
        .post("/api/instructor/login")
        .send({ password: "secret-password" })
        .expect(204);

      const createRes = await agent
        .post("/api/session")
        .send({ week: "week01" })
        .expect(201);

      await agent
        .get(`/api/session/${createRes.body.sessionId}/state`)
        .expect(200);

      const status = await agent
        .get("/api/instructor/session")
        .expect(200);
      expect(status.body.authenticated).toBe(true);
      expect(status.body.configured).toBe(true);
    });

    it("reports instructor session as authenticated when password is not configured", async () => {
      delete process.env.INSTRUCTOR_PASSWORD;
      const unprotectedApp = createApp(quizDir);

      const status = await request(unprotectedApp)
        .get("/api/instructor/session")
        .expect(200);

      expect(status.body.authenticated).toBe(true);
      expect(status.body.configured).toBe(false);
    });

    it("requires instructor auth for presentation metadata when password is configured", async () => {
      process.env.INSTRUCTOR_PASSWORD = "presentation-secret";
      const protectedApp = createApp({ quizDir, shortUrlProviders: [] });

      const agent = request.agent(protectedApp);
      await agent
        .post("/api/instructor/login")
        .send({ password: "presentation-secret" })
        .expect(204);

      const createRes = await agent
        .post("/api/session")
        .send({ week: "week01" })
        .expect(201);

      await request(protectedApp)
        .get(`/api/session/${createRes.body.sessionId}/presentation`)
        .expect(401);

      const res = await agent
        .get(`/api/session/${createRes.body.sessionId}/presentation`)
        .set("Host", "quiz-host.local:3001")
        .expect(200);

      expect(res.body.sessionId).toBe(createRes.body.sessionId);
      expect(res.body.accessInfo.presentationUrl).toBe(
        `http://quiz-host.local:3001/#/present/${createRes.body.sessionId}`,
      );
    });
  });

  describe("GET /api/health", () => {
    it("returns ok", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      expect(typeof res.body.instanceId).toBe("string");
      expect(res.body.instanceId.length).toBeGreaterThan(0);
      expect(res.headers["x-mdq-instance-id"]).toBe(res.body.instanceId);
    });
  });

  describe("GET /api/runtime-config", () => {
    it("returns the configured browser-visible runtime options", async () => {
      const res = await request(createApp({ quizDir, theme: "light", autoGenerateStudentIds: true })).get("/api/runtime-config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        theme: "light",
        palette: "classic",
        autoGenerateStudentIds: true,
        presenterNotes: false,
        presenterNotesDefaultOpen: false,
      });
    });
  });

  describe("GET /api/decks", () => {
    it("lists available decks", async () => {
      const res = await request(app).get("/api/decks");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      const w1 = res.body.find((q: { week: string }) => q.week === "week01");
      expect(w1).toBeDefined();
      expect(w1.questionCount).toBe(3);
      expect(w1.liveQuestionCount).toBe(3);
      expect(w1.slideCount).toBe(0);
    });

    it("separates quiz questions from slides in deck summaries", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-quiz-summary-"));
      fs.writeFileSync(
        path.join(tempQuizDir, "week99-mixed.md"),
        `# Mixed Fixture Quiz

---

## Orientation Slide

type: slide

- First, orient the room.

---

## Live Check

**Which item is interactive?**

A. This answer
B. The slide

> Correct Answer: A
> Overall Feedback: This is the live question.
`,
        "utf-8",
      );

      const mixedApp = createApp(tempQuizDir);

      try {
        const res = await request(mixedApp).get("/api/decks");
        expect(res.status).toBe(200);
        const summary = res.body.find((q: { week: string }) => q.week === "week99-mixed");
        expect(summary).toBeDefined();
        expect(summary.questionCount).toBe(2);
        expect(summary.liveQuestionCount).toBe(1);
        expect(summary.slideCount).toBe(1);
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });

    it("loads week and lab variant decks as distinct keys", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-quiz-variants-"));
      const fixtureWeek01 = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "week03.md"), fixtureWeek01.replace(/^# .+$/m, "# Week 03"), "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "week03-lab.md"), fixtureWeek01.replace(/^# .+$/m, "# Week 03 Lab"), "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "featured-demo.md"), fixtureWeek01.replace(/^# .+$/m, "# Featured Demo"), "utf-8");

      const variantApp = createApp(tempQuizDir);

      try {
        const listRes = await request(variantApp).get("/api/decks");
        expect(listRes.status).toBe(200);
        expect(listRes.body[0].week).toBe("featured-demo");
        expect(listRes.body.find((q: { week: string }) => q.week === "week03")).toBeDefined();
        expect(listRes.body.find((q: { week: string }) => q.week === "week03-lab")).toBeDefined();
        expect(listRes.body.find((q: { week: string }) => q.week === "featured-demo")).toBeDefined();

        const weekRes = await request(variantApp).get("/api/deck/week03");
        expect(weekRes.status).toBe(200);

        const labRes = await request(variantApp).get("/api/deck/week03-lab");
        expect(labRes.status).toBe(200);

        const namedDeckRes = await request(variantApp).get("/api/deck/featured-demo");
        expect(namedDeckRes.status).toBe(200);
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });

    it("collapses duplicate deck titles and prefers descriptive filenames over week-prefixed aliases", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-duplicate-decks-"));
      const descriptiveDeck = fs
        .readFileSync(path.join(quizDir, "week01.md"), "utf-8")
        .replace(/^# .+$/m, "# Featured Demo Session (10 min MDQ)");
      const weekAliasDeck = descriptiveDeck.replace(
        /^# .+$/m,
        "# Featured Demo Session (10 min, MDQ)",
      );
      fs.writeFileSync(path.join(tempQuizDir, "week13-featured-demo.md"), weekAliasDeck, "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "featured-demo.md"), descriptiveDeck, "utf-8");

      const duplicateApp = createApp(tempQuizDir);

      try {
        const listRes = await request(duplicateApp).get("/api/decks");
        expect(listRes.status).toBe(200);
        const matchingDecks = listRes.body.filter((q: { title: string }) => q.title.includes("Featured Demo Session"));
        expect(matchingDecks).toHaveLength(1);
        expect(matchingDecks[0].week).toBe("featured-demo");
        expect(matchingDecks[0].title).toBe("Featured Demo Session (10 min MDQ)");

        await request(duplicateApp).get("/api/deck/featured-demo").expect(200);
        await request(duplicateApp).get("/api/deck/week13-featured-demo").expect(404);
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });

    it("blocks instructor setup when any deck file has format errors", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-invalid-quiz-list-"));
      const fixtureWeek01 = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      const invalidQuiz = `# Broken Quiz

---

## Q4

**Short Answer Question:**

Name the file to edit.

> Correct Answer: package.json
> Overall Feedback: package.json.

---
`;
      fs.writeFileSync(path.join(tempQuizDir, "week01.md"), fixtureWeek01, "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "week04-lab.md"), invalidQuiz, "utf-8");

      const invalidApp = createApp(tempQuizDir);

      try {
        const res = await request(invalidApp).get("/api/decks");
        expect(res.status).toBe(409);
        expect(res.body.error).toContain("week04-lab.md:6");
        expect(res.body.error).toContain("no answer choices");
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });
  });

  describe("POST /api/decks/reload", () => {
    it("reloads deck markdown files without restarting server", async () => {
      const res = await request(app).post("/api/decks/reload");
      expect(res.status).toBe(200);
      expect(res.body.loaded).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(res.body.quizzes)).toBe(true);
      const w1 = res.body.quizzes.find((q: { week: string }) => q.week === "week01");
      expect(w1).toBeDefined();
    });

    it("skips a deck file deleted during reload instead of failing", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-quiz-reload-"));
      const week01Path = path.join(tempQuizDir, "week01.md");
      const fixtureWeek01 = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      fs.writeFileSync(week01Path, fixtureWeek01, "utf-8");

      const deletedTargetPath = path.join(tempQuizDir, "week02.deleted.md");
      const staleLinkPath = path.join(tempQuizDir, "week02.md");
      fs.symlinkSync(deletedTargetPath, staleLinkPath);

      const flakyApp = createApp(tempQuizDir);

      try {
        const res = await request(flakyApp).post("/api/decks/reload");
        expect(res.status).toBe(200);
        expect(res.body.loaded).toBe(1);
        expect(Array.isArray(res.body.quizzes)).toBe(true);
        expect(res.body.quizzes).toHaveLength(1);
        expect(res.body.quizzes[0].week).toBe("week01");
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });

    it("returns a lecturer-friendly validation error when reload finds a broken deck", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-invalid-quiz-reload-"));
      const fixtureWeek01 = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      const invalidQuiz = `# Broken Quiz

---

## Q4

**Short Answer Question:**

Name the file to edit.

> Correct Answer: package.json
> Overall Feedback: package.json.

---
`;
      fs.writeFileSync(path.join(tempQuizDir, "week01.md"), fixtureWeek01, "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "week04-lab.md"), invalidQuiz, "utf-8");

      const invalidApp = createApp(tempQuizDir);

      try {
        const res = await request(invalidApp).post("/api/decks/reload");
        expect(res.status).toBe(409);
        expect(res.body.error).toContain("week04-lab.md:6");
        expect(res.body.error).toContain("Fix the markdown file and reload decks");
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });
  });

  describe("GET /api/deck/:week", () => {
    it("returns quiz metadata", async () => {
      const res = await request(app).get("/api/deck/week01");
      expect(res.status).toBe(200);
      expect(res.body.week).toBe("week01");
      expect(res.body.questionCount).toBe(3);
    });

    it("returns 404 for non-existent week", async () => {
      const res = await request(app).get("/api/deck/week99");
      expect(res.status).toBe(404);
    });
  });

  describe("unknown API routes", () => {
    it("returns a JSON 404 instead of falling through to the production SPA route", async () => {
      const res = await request(app).get("/api/no-such-route").expect(404);

      expect(res.type).toBe("application/json");
      expect(res.body.error).toBe("API route not found");
    });
  });

  describe("GET /data/images/*", () => {
    it("serves quiz attachment files from the data images directory", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-images-quiz-"));
      const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-images-data-"));
      const imageDir = path.join(tempDataDir, "images");
      fs.mkdirSync(imageDir, { recursive: true });

      const fixtureWeek01 = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "week01.md"), fixtureWeek01, "utf-8");

      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f59e0b"/></svg>';
      fs.writeFileSync(path.join(imageDir, "xr-setup.svg"), svg, "utf-8");

      const imageApp = createApp({ quizDir: tempQuizDir, dataDir: tempDataDir });

      try {
        const res = await request(imageApp).get("/data/images/xr-setup.svg");
        expect(res.status).toBe(200);
        const bodyText = Buffer.isBuffer(res.body) ? res.body.toString("utf-8") : String(res.text || "");
        expect(bodyText).toContain("<svg");
        expect(res.headers["content-type"]).toContain("image/svg+xml");
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      }
    });
  });

  describe("GET /data/videos/*", () => {
    it("serves local slide videos with byte-range support", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-videos-quiz-"));
      const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-videos-data-"));
      const videoDir = path.join(tempDataDir, "videos");
      fs.mkdirSync(videoDir, { recursive: true });

      const fixtureWeek01 = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "week01.md"), fixtureWeek01, "utf-8");
      fs.writeFileSync(path.join(videoDir, "demo.mp4"), Buffer.from("0123456789"));

      const videoApp = createApp({ quizDir: tempQuizDir, dataDir: tempDataDir });

      try {
        const res = await request(videoApp)
          .get("/data/videos/demo.mp4")
          .set("Range", "bytes=2-5");
        expect(res.status).toBe(206);
        expect(res.headers["accept-ranges"]).toBe("bytes");
        expect(res.headers["content-range"]).toBe("bytes 2-5/10");
        expect(Buffer.from(res.body).toString("utf-8")).toBe("2345");
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      }
    });
  });

  describe("Session lifecycle", () => {
    let sessionId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post("/api/session")
        .send({ week: "week01", mode: "open" });
      sessionId = res.body.sessionId;
    });

    it("creates a session", async () => {
      const res = await request(app)
        .post("/api/session")
        .send({ week: "week01" });
      expect(res.status).toBe(201);
      expect(res.body.sessionId).toBeTruthy();
      expect(res.body.sessionCode).toHaveLength(6);
      expect(res.body.questionHeadings).toEqual([
        "Intro: Definitions",
        "Intro: Defaults",
        "Intro: Multi-select",
      ]);
      expect(res.body.questionSummaries).toEqual([
        { heading: "Intro: Definitions", questionType: "multiple_choice" },
        { heading: "Intro: Defaults", questionType: "multiple_choice" },
        { heading: "Intro: Multi-select", questionType: "multiple_choice" },
      ]);
    });

    it("rejects session creation without week", async () => {
      const res = await request(app).post("/api/session").send({});
      expect(res.status).toBe(400);
    });

    it("rejects session creation for non-existent quiz", async () => {
      const res = await request(app)
        .post("/api/session")
        .send({ week: "week99" });
      expect(res.status).toBe(404);
    });

    it("blocks session creation when quiz validation errors exist", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-invalid-quiz-session-"));
      const fixtureWeek01 = fs.readFileSync(path.join(quizDir, "week01.md"), "utf-8");
      const invalidQuiz = `# Broken Quiz

---

## Q4

**Short Answer Question:**

Name the file to edit.

> Correct Answer: package.json
> Overall Feedback: package.json.

---
`;
      fs.writeFileSync(path.join(tempQuizDir, "week01.md"), fixtureWeek01, "utf-8");
      fs.writeFileSync(path.join(tempQuizDir, "week04-lab.md"), invalidQuiz, "utf-8");

      const invalidApp = createApp(tempQuizDir);

      try {
        const res = await request(invalidApp)
          .post("/api/session")
          .send({ week: "week01" });
        expect(res.status).toBe(409);
        expect(res.body.error).toContain("week04-lab.md:6");
        expect(res.body.error).toContain("cannot run it safely");
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });

    it("starts session (LOBBY -> QUESTION_OPEN)", async () => {
      const res = await request(app).post(`/api/session/${sessionId}/start`);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("QUESTION_OPEN");
      expect(res.body.questionIndex).toBe(0);
    });

    it("repairs a closed slide when the instructor resumes the session", async () => {
      const tempQuizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-slide-resume-"));
      fs.writeFileSync(
        path.join(tempQuizDir, "recovery.md"),
        `# Recovery Deck

---

## Opening Slide

type: slide

- This slide must remain navigable after resume.
`,
        "utf-8",
      );
      const recoveryApp = createApp(tempQuizDir);

      try {
        const createRes = await request(recoveryApp)
          .post("/api/session")
          .send({ week: "recovery" })
          .expect(201);
        const session = getSession(createRes.body.sessionId)!;
        session.currentQuestionIndex = 0;
        session.state = "QUESTION_CLOSED";

        const restoreRes = await request(recoveryApp)
          .get(`/api/session/${session.sessionId}/state`)
          .expect(200);

        expect(restoreRes.body.state).toBe("QUESTION_OPEN");
        expect(session.state).toBe("QUESTION_OPEN");
      } finally {
        fs.rmSync(tempQuizDir, { recursive: true, force: true });
      }
    });

    it("follows full lifecycle", async () => {
      // Start
      let res = await request(app).post(`/api/session/${sessionId}/start`);
      expect(res.body.state).toBe("QUESTION_OPEN");

      // Close
      res = await request(app).post(`/api/session/${sessionId}/close`);
      expect(res.body.state).toBe("QUESTION_CLOSED");

      // Reveal
      res = await request(app).post(`/api/session/${sessionId}/reveal`);
      expect(res.body.state).toBe("REVEAL");

      // Next question
      res = await request(app).post(`/api/session/${sessionId}/next`);
      expect(res.body.state).toBe("QUESTION_OPEN");
      expect(res.body.questionIndex).toBe(1);

      // Close
      res = await request(app).post(`/api/session/${sessionId}/close`);
      expect(res.body.state).toBe("QUESTION_CLOSED");

      // Reveal
      res = await request(app).post(`/api/session/${sessionId}/reveal`);
      expect(res.body.state).toBe("REVEAL");

      // Next question
      res = await request(app).post(`/api/session/${sessionId}/next`);
      expect(res.body.state).toBe("QUESTION_OPEN");
      expect(res.body.questionIndex).toBe(2);

      // Close + Reveal + End
      res = await request(app).post(`/api/session/${sessionId}/close`);
      res = await request(app).post(`/api/session/${sessionId}/reveal`);
      res = await request(app).post(`/api/session/${sessionId}/end`);
      expect(res.body.state).toBe("ENDED");
    });

    it("goes back to the previous revealed quiz in review mode", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/next`).expect(200);

      const res = await request(app)
        .post(`/api/session/${sessionId}/prev`)
        .expect(200);

      expect(res.body.state).toBe("REVEAL");
      expect(res.body.questionIndex).toBe(0);
    });

    it("keeps completed quiz questions in review mode when navigating back and forward", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/next`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);

      let res = await request(app)
        .post(`/api/session/${sessionId}/prev`)
        .expect(200);

      expect(res.body.state).toBe("REVEAL");
      expect(res.body.questionIndex).toBe(0);

      res = await request(app)
        .post(`/api/session/${sessionId}/next`)
        .expect(200);

      expect(res.body.state).toBe("REVEAL");
      expect(res.body.questionIndex).toBe(1);
    });

    it("allows ending directly from a closed question", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);

      const res = await request(app)
        .post(`/api/session/${sessionId}/end`)
        .expect(200);

      expect(res.body.state).toBe("ENDED");
    });

    it("writes per-reveal CSV progress and end-of-quiz markdown summary", async () => {
      const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-lifecycle-persist-"));
      const persistApp = createApp({ quizDir, dataDir: tempDataDir });
      const consoleLogSpy = jest.spyOn(console, "log").mockImplementation();

      try {
        const createRes = await request(persistApp)
          .post("/api/session")
          .send({ week: "week01", mode: "open" })
          .expect(201);

        const sid = createRes.body.sessionId;
        const code = createRes.body.sessionCode;

        await request(persistApp).post(`/api/session/${sid}/start`).expect(200);
        await request(persistApp).post(`/api/session/${sid}/close`).expect(200);
        await request(persistApp).post(`/api/session/${sid}/reveal`).expect(200);

        const revealLogCall = consoleLogSpy.mock.calls.find((call) => call.join(" ").includes("csv_created"));
        expect(revealLogCall).toBeDefined();
        expect(revealLogCall?.join(" ")).toContain(`session=${sid}`);

        const submissionsPath = path.join(tempDataDir, "submissions");
        const csvFilesAfterReveal = fs.readdirSync(submissionsPath).filter((f) => f.endsWith(".csv"));
        expect(csvFilesAfterReveal).toHaveLength(1);
        expect(csvFilesAfterReveal[0]).toMatch(new RegExp(`^${code}-\\d{8}-\\d{6}\\.csv$`));

        await request(persistApp).post(`/api/session/${sid}/next`).expect(200);
        await request(persistApp).post(`/api/session/${sid}/close`).expect(200);
        await request(persistApp).post(`/api/session/${sid}/reveal`).expect(200);

        const updateLogCall = consoleLogSpy.mock.calls.find((call) => call.join(" ").includes("csv_updated"));
        expect(updateLogCall).toBeDefined();
        expect(updateLogCall?.join(" ")).toContain(`session=${sid}`);

        const csvContentAfterReveal = fs.readFileSync(path.join(submissionsPath, csvFilesAfterReveal[0]), "utf-8");
        expect(csvContentAfterReveal).toContain("q1_revealed_at_iso");

        const summaryFilesAfterReveal = fs.readdirSync(submissionsPath).filter((f) => f.endsWith("-summary.md"));
        expect(summaryFilesAfterReveal).toHaveLength(0);

        await request(persistApp).post(`/api/session/${sid}/end`).expect(200);

        const endCsvLogCall = consoleLogSpy.mock.calls.find(
          (call) => call.join(" ").includes("csv_updated") && !call.join(" ").includes("reveal_q="),
        );
        expect(endCsvLogCall).toBeDefined();
        expect(endCsvLogCall?.join(" ")).toContain(`session=${sid}`);
        expect(endCsvLogCall?.join(" ")).toContain(`code=${code}`);
        expect(endCsvLogCall?.join(" ")).toContain("path=");

        const summaryLogCall = consoleLogSpy.mock.calls.find((call) => call.join(" ").includes("summary_markdown_created"));
        expect(summaryLogCall).toBeDefined();
        expect(summaryLogCall?.join(" ")).toContain(`session=${sid}`);

        const summaryFilesAfterEnd = fs.readdirSync(submissionsPath).filter((f) => f.endsWith("-summary.md"));
        expect(summaryFilesAfterEnd).toHaveLength(1);

        const summaryContent = fs.readFileSync(path.join(submissionsPath, summaryFilesAfterEnd[0]), "utf-8");
        expect(summaryContent).toContain("# Quiz Session Summary");
        expect(summaryContent).toContain(`Session ID: ${sid}`);
      } finally {
        consoleLogSpy.mockRestore();
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      }
    });

    it("rejects invalid transitions", async () => {
      // Try to close before starting
      let res = await request(app).post(`/api/session/${sessionId}/close`);
      expect(res.status).toBe(400);

      // Try to reveal before starting
      res = await request(app).post(`/api/session/${sessionId}/reveal`);
      expect(res.status).toBe(400);

      // Start, then try to start again
      await request(app).post(`/api/session/${sessionId}/start`);
      res = await request(app).post(`/api/session/${sessionId}/start`);
      expect(res.status).toBe(400);
    });

    it("rejects next when no more questions", async () => {
      // week01 has 3 questions, advance through all
      await request(app).post(`/api/session/${sessionId}/start`);
      await request(app).post(`/api/session/${sessionId}/close`);
      await request(app).post(`/api/session/${sessionId}/reveal`);
      await request(app).post(`/api/session/${sessionId}/next`);
      await request(app).post(`/api/session/${sessionId}/close`);
      await request(app).post(`/api/session/${sessionId}/reveal`);
      await request(app).post(`/api/session/${sessionId}/next`);
      await request(app).post(`/api/session/${sessionId}/close`);
      await request(app).post(`/api/session/${sessionId}/reveal`);
      // Now try to go beyond
      const res = await request(app).post(`/api/session/${sessionId}/next`);
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await request(app).post("/api/session/no-such-id/start");
      expect(res.status).toBe(404);
    });

    it("gets leaderboard", async () => {
      const res = await request(app).get(`/api/session/${sessionId}/leaderboard`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toBeDefined();
      expect(res.body.totalQuestions).toBe(3);
    });

    it("resolves session code lookup with normalization", async () => {
      const createRes = await request(app)
        .post("/api/session")
        .send({ week: "week01" })
        .expect(201);

      const lower = createRes.body.sessionCode.toLowerCase();
      const res = await request(app)
        .get(`/api/session/by-code/%20${lower}%20`)
        .expect(200);

      expect(res.body.sessionId).toBe(createRes.body.sessionId);
      expect(res.body.sessionCode).toBe(createRes.body.sessionCode);
    });

    it("returns session-specific join access info", async () => {
      const createRes = await request(app)
        .post("/api/session")
        .send({ week: "week01" })
        .expect(201);

      const res = await request(app)
        .get(`/api/session/${createRes.body.sessionId}/access-info`)
        .set("Host", "quiz-host.local:3001")
        .expect(200);

      expect(res.body.fullUrl).toBe(`http://quiz-host.local:3001/join/${createRes.body.sessionCode}`);
      expect(res.body.fullUrl).toContain(`/join/${createRes.body.sessionCode}`);
      expect(res.body.qrTargetUrl).toContain(`/join/${createRes.body.sessionCode}`);
    });

    it("returns presentation metadata for an active session when instructor auth is disabled", async () => {
      const createRes = await request(app)
        .post("/api/session")
        .send({ week: "week01" })
        .expect(201);

      const res = await request(app)
        .get(`/api/session/${createRes.body.sessionId}/presentation`)
        .set("Host", "quiz-host.local:3001")
        .expect(200);

      expect(res.body.sessionId).toBe(createRes.body.sessionId);
      expect(res.body.sessionCode).toBe(createRes.body.sessionCode);
      expect(res.body.questionHeadings).toEqual([
        "Intro: Definitions",
        "Intro: Defaults",
        "Intro: Multi-select",
      ]);
      expect(res.body.questionSummaries).toEqual([
        { heading: "Intro: Definitions", questionType: "multiple_choice" },
        { heading: "Intro: Defaults", questionType: "multiple_choice" },
        { heading: "Intro: Multi-select", questionType: "multiple_choice" },
      ]);
      expect(res.body.accessInfo.fullUrl).toBe(`http://quiz-host.local:3001/join/${createRes.body.sessionCode}`);
      expect(res.body.accessInfo.presentationUrl).toBe(`http://quiz-host.local:3001/#/present/${createRes.body.sessionId}`);
    });

    it("returns instructor restore snapshot for active session", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);

      const res = await request(app)
        .get(`/api/session/${sessionId}/state`)
        .expect(200);

      expect(res.body.sessionId).toBe(sessionId);
      expect(res.body.state).toBe("QUESTION_OPEN");
      expect(res.body.questionCount).toBe(3);
      expect(res.body.week).toBe("week01");
      expect(res.body.questionHeadings).toEqual([
        "Intro: Definitions",
        "Intro: Defaults",
        "Intro: Multi-select",
      ]);
      expect(res.body.questionSummaries).toEqual([
        { heading: "Intro: Definitions", questionType: "multiple_choice" },
        { heading: "Intro: Defaults", questionType: "multiple_choice" },
        { heading: "Intro: Multi-select", questionType: "multiple_choice" },
      ]);
      expect(res.body.reviewQuestions).toHaveLength(1);
      expect(res.body.reviewQuestions[0]).toMatchObject({
        questionIndex: 0,
        topic: "Intro",
        questionType: "multiple_choice",
      });
      expect(res.body.reviewReveals).toEqual([]);
    });

    it("returns visited question and reveal history for resumed instructor review", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/next`).expect(200);

      const res = await request(app)
        .get(`/api/session/${sessionId}/state`)
        .expect(200);

      expect(res.body.state).toBe("QUESTION_OPEN");
      expect(res.body.currentQuestionIndex).toBe(1);
      expect(res.body.reviewQuestions).toHaveLength(2);
      expect(res.body.reviewQuestions.map((question: { questionIndex: number }) => question.questionIndex)).toEqual([0, 1]);
      expect(res.body.reviewReveals).toHaveLength(1);
      expect(res.body.reviewReveals[0]).toMatchObject({
        questionIndex: 0,
        questionType: "multiple_choice",
        correctOptions: ["B"],
      });
    });

    it("returns 410 for restore request on ended session", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/end`).expect(200);

      const res = await request(app)
        .get(`/api/session/${sessionId}/state`)
        .expect(410);

      expect(res.body.error).toContain("ended");
    });

    it("uses request host for startup access info fallback", async () => {
      const res = await request(app)
        .get("/api/access-info")
        .set("Host", "quiz-host.local:3001")
        .expect(200);

      expect(res.body.fullUrl).toBe("http://quiz-host.local:3001");
      expect(res.body.qrTargetUrl).toBe("http://quiz-host.local:3001");
      expect(res.body.warning).toContain("not yet detected");
    });

    it("allows LEADERBOARD -> REVEAL resume", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/leaderboard-show`).expect(200);

      const res = await request(app)
        .post(`/api/session/${sessionId}/leaderboard-hide`)
        .expect(200);
      expect(res.body.state).toBe("REVEAL");
    });

    it("keeps LEADERBOARD when hiding after final question", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/next`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/next`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/leaderboard-show`).expect(200);

      const res = await request(app)
        .post(`/api/session/${sessionId}/leaderboard-hide`)
        .expect(200);

      expect(res.body.state).toBe("LEADERBOARD");
      expect(res.body.lockedOnLeaderboard).toBe(true);
    });

    it("allows leaderboard show from QUESTION_CLOSED on final question", async () => {
      await request(app).post(`/api/session/${sessionId}/start`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/next`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);
      await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
      await request(app).post(`/api/session/${sessionId}/next`).expect(200);
      await request(app).post(`/api/session/${sessionId}/close`).expect(200);

      const res = await request(app)
        .post(`/api/session/${sessionId}/leaderboard-show`)
        .expect(200);

      expect(res.body.state).toBe("LEADERBOARD");
    });
  });
});
