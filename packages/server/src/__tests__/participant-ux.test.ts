import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { Quiz, Session, SocketEvents } from "@mdq/shared";
import { createApp } from "../app";
import { apply } from "../engine";
import { clearAllSessions } from "../session";
import { parseQuizMarkdown } from "../parser";
import { deckLabel, formatQuizLabel, resultsHeading } from "../../../client/src/deckLabel";
import { SESSION_MISSING_MESSAGE, extraLabelNote, joinRefusalMessage } from "../../../client/src/joinForm";
import { getQuestionModeText } from "../../../client/src/questionMode";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

const DECK = `# Team Retro

---

## Welcome

type: slide

Hello.

---

## First

time-limit: 20

**Pick one.**

A. One
B. Two

> Correct Answer: B. Two
> Overall Feedback: Two.

---

## Second

time-limit: 20

**Pick again.**

A. Three
B. Four

> Correct Answer: A. Three
> Overall Feedback: Three.

---

## Break

type: slide

Rest.

---

## Third

type: poll
time-limit: 20

**Pick a side.**

A. Left
B. Right

> Overall Feedback: Thanks.
`;

const deck = (): Quiz => parseQuizMarkdown(DECK, "retro.md").quiz as Quiz;
const lobby = (quiz: Quiz): Session => ({
  sessionId: "s", sessionCode: "ABC123", week: quiz.week, mode: "open", state: "LOBBY", currentQuestionIndex: -1,
  revealedQuestionIndexes: new Set<number>(), participants: new Map(), submissions: [], createdAt: 0,
});

describe("question counter", () => {
  it("counts questions only, skips slides, and is the same wherever a question opens", () => {
    const quiz = deck();
    let session = lobby(quiz);
    const seen: { index: number; number?: number; total?: number }[] = [];
    const record = (messages: ReturnType<typeof apply>["messages"]) => {
      const open = messages.find((m) => m.event === SocketEvents.QUESTION_OPEN)?.payload as { questionIndex: number; questionNumber?: number; questionTotal?: number };
      seen.push({ index: open.questionIndex, number: open.questionNumber, total: open.questionTotal });
    };
    let result = apply(session, quiz, { type: "start" }, 1000);
    record(result.messages);
    for (let i = 1; i < quiz.questions.length; i++) {
      session = result.session;
      if (session.state === "QUESTION_OPEN" && quiz.questions[session.currentQuestionIndex].questionType !== "slide") {
        session = apply(session, quiz, { type: "close" }, 1000).session;
        session = apply(session, quiz, { type: "reveal" }, 1000).session;
      }
      result = apply(session, quiz, { type: "next" }, 1000);
      record(result.messages);
    }
    expect(seen).toEqual([
      { index: 0, number: undefined, total: undefined },
      { index: 1, number: 1, total: 3 },
      { index: 2, number: 2, total: 3 },
      { index: 3, number: undefined, total: undefined },
      { index: 4, number: 3, total: 3 },
    ]);
  });

  it("carries the same numbers in the snapshot a reloaded phone gets", () => {
    const quiz = deck();
    let session = lobby(quiz);
    session = apply(session, quiz, { type: "start" }, 1000).session;
    session = apply(session, quiz, { type: "next" }, 1000).session;
    const joined = apply(session, quiz, { type: "join", socketId: "sock", newToken: "tok", newPublicKey: "pk", payload: { studentId: "S0001", displayName: "Alex Tan" } }, 2000);
    const open = joined.messages.find((m) => m.event === SocketEvents.QUESTION_OPEN)?.payload as { questionNumber?: number; questionTotal?: number };
    expect(open).toMatchObject({ questionNumber: 1, questionTotal: 3 });
  });

  it("shows no number on the phone for a slide, and words it as Question N of M otherwise", () => {
    const view = read("views/StudentView.tsx");
    expect(view).toContain("`Question ${question.questionNumber} of ${question.questionTotal}`");
    expect(view).not.toContain("Q{positionLabel}");
    const slideBlock = view.slice(view.indexOf('mode="student"') - 400, view.indexOf('mode="student"'));
    expect(slideBlock).not.toContain("positionLabel");
  });
});

describe("deck title on results", () => {
  it("names the deck by its title, and falls back to the id", () => {
    expect(deckLabel("Team Retro", "DECK")).toBe("Team Retro");
    expect(deckLabel("  ", "week03")).toBe("WEEK03 MDQ");
    expect(deckLabel(undefined, "")).toBe("MDQ");
    expect(formatQuizLabel("quiz mdq")).toBe("quiz mdq");
    expect(resultsHeading("leaderboard", "Team Retro")).toBe("Leaderboard for Team Retro");
    expect(resultsHeading("final", "Team Retro")).toBe("Final Results for Team Retro");
    expect(resultsHeading("final", "")).toBe("Final Results");
  });

  it("sends the title to a joining phone and leaves it out when the deck has none", () => {
    const quiz = deck();
    const joined = apply(lobby(quiz), quiz, { type: "join", socketId: "sock", newToken: "tok", newPublicKey: "pk", payload: { studentId: "S0001" } }, 2000);
    expect((joined.messages[0].payload as { deckTitle?: string }).deckTitle).toBe("Team Retro");
    const untitled = { ...quiz, title: "" };
    const again = apply(lobby(untitled), untitled, { type: "join", socketId: "sock", newToken: "tok", newPublicKey: "pk", payload: { studentId: "S0001" } }, 2000);
    expect(again.messages[0].payload).not.toHaveProperty("deckTitle");
  });

  it("puts the title on the routes the phone, projector and instructor load", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-ux-title-"));
    try {
      fs.writeFileSync(path.join(dir, "retro.md"), DECK);
      clearAllSessions();
      const app = createApp({ quizDir: dir, dataDir: path.join(dir, "data"), shortUrlProviders: [] });
      const created = await request(app).post("/api/session").send({ week: "retro" }).expect(201);
      const byCode = await request(app).get(`/api/session/by-code/${created.body.sessionCode}`).expect(200);
      expect(byCode.body.title).toBe("Team Retro");
      const restored = await request(app).get(`/api/session/${created.body.sessionId}/state`).expect(200);
      expect(restored.body.title).toBe("Team Retro");
      const present = await request(app).get(`/api/session/${created.body.sessionId}/presentation`).expect(200);
      expect(present.body.title).toBe("Team Retro");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the deck title on the phone, projector and instructor headings", () => {
    for (const file of ["views/StudentView.tsx", "views/PresentationView.tsx", "views/InstructorView.tsx"]) {
      const source = read(file);
      expect(source).toContain("deckLabel");
      expect(source).not.toContain("quizLabel.toUpperCase()");
    }
    expect(read("views/StudentView.tsx")).toContain("sock.deckTitle");
  });
});

describe("closing early and the wording around it", () => {
  const view = read("views/StudentView.tsx");

  it("only says time is up when the timer ran out", () => {
    expect(view).toContain("Answers are closed. Waiting for the instructor.");
    expect(view).toContain("Time's up. Waiting for the instructor.");
    expect(view).toContain("timedOut ?");
    expect(view).not.toContain("Time expired");
    const socket = read("hooks/useSocket.ts");
    expect(socket).toContain("setTimedOut(data?.timedOut === true)");
  });

  it("warns that a submitted answer cannot be changed, and no longer contradicts the Update button", () => {
    expect(view).toContain("You cannot change your answer after you submit.");
    expect(view).toContain("You cannot change your vote after you submit.");
    const text = getQuestionModeText("open_response", false);
    expect(text).not.toContain("Submit one written reply");
    expect(text).toContain("update");
  });

  it("offers to send an answer that was left unsent after reconnecting", () => {
    expect(view).toContain("Reconnected. Tap Submit to send your answer.");
  });
});

describe("join form messages", () => {
  it("adds the next step when a code is not found, whether it never existed or has ended", () => {
    expect(SESSION_MISSING_MESSAGE).toBe("We could not find a session with that code. It may have ended. Check the code with your instructor.");
    expect(joinRefusalMessage("Session has ended")).toBe(SESSION_MISSING_MESSAGE);
    expect(joinRefusalMessage("Session not found")).toBe(SESSION_MISSING_MESSAGE);
  });

  it("adds the next step when a Student ID is already in use, once", () => {
    const clash = 'The Student ID "S0001" is already in this session on another device. Use that device, or check that you typed your own ID.';
    const shown = joinRefusalMessage(clash);
    expect(shown.startsWith(clash)).toBe(true);
    expect(shown).toContain("If that device is not working, ask your instructor to let you join again.");
    expect(joinRefusalMessage(shown)).toBe(shown);
    expect(joinRefusalMessage("Enter your name to join.")).toBe("Enter your name to join.");
  });

  it("keeps the join address until a join is accepted", () => {
    const view = read("views/StudentView.tsx");
    const joinBody = view.slice(view.indexOf("const handleJoin"), view.indexOf("// When socket connects and we have pending join"));
    expect(joinBody).not.toContain("window.location.hash");
    expect(view).toContain("if (sessionToken && sessionId && window.location.hash !==");
  });

  it("puts the form at the top, with 14px labels and no Back link where it goes nowhere", () => {
    const view = read("views/StudentView.tsx");
    expect(view).toContain("justify-start");
    expect(view).toContain("max-w-md");
    expect(view).not.toMatch(/text-zinc-400 text-xs mb-1/);
    expect(view).toContain("!initialSessionCode && !initialSessionId");
    expect(view).toContain("min-h-11 min-w-11");
  });
});

describe("waiting screen name", () => {
  it("shows one line for an assigned name, and keeps the note about a duplicate name", () => {
    expect(extraLabelNote("Participant 3", "You appear as Participant 3.")).toBeNull();
    expect(extraLabelNote("Alex (2)", "Another participant is also called Alex, so you appear as Alex (2).")).toBe("Another participant is also called Alex, so you appear as Alex (2).");
    expect(extraLabelNote("Alex", null)).toBeNull();
  });
});

describe("screen reader and touch details", () => {
  const view = read("views/StudentView.tsx");

  it("exposes the choices as radios or checkboxes in a labelled group", () => {
    expect(view).toContain('role={question.allowsMultiple ? "checkbox" : "radio"}');
    expect(view).toContain("aria-checked={wasSubmitted || isSelected}");
    expect(view).toContain('role={question.allowsMultiple ? "group" : "radiogroup"}');
    expect(view).toContain("aria-labelledby={questionTextId}");
  });

  it("announces the reveal banner politely", () => {
    const banner = view.slice(view.indexOf("reveal-banner") - 200, view.indexOf("reveal-banner"));
    expect(banner).toContain('role="status"');
    expect(banner).toContain('aria-live="polite"');
  });

  it("shows no repeated no-response line, and 0 (0%) on an empty poll bar", () => {
    expect(view).toContain("With no response, the banner above already says so.");
    const chart = read("components/DistributionChart.tsx");
    expect(chart).toContain("widthPct={count > 0 ? Math.max(pct, 2) : 0}");
    expect(chart).not.toContain("count > 0 ? `${count}");
  });

  it("labels the leaderboard numbers and caps the phone leaderboard's width", () => {
    const board = read("components/Leaderboard.tsx");
    expect(board).toContain("of ${totalQuestions} correct");
    expect(board).toContain(" s<span");
    const css = read("index.css");
    expect(css).toMatch(/\.leaderboard-board-compact \{\s*width: min\(100%, 32rem\);/);
  });

  it("makes the phone slide's status line 14px and its controls 44px", () => {
    const css = read("index.css");
    const rule = (selector: string): string => {
      const at = css.lastIndexOf(`${selector} {`);
      expect(at).toBeGreaterThan(0);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".slide-surface-student .slide-status-pill")).toContain("font-size: 0.875rem");
    expect(rule(".slide-surface-student .slide-fullscreen-button")).toContain("min-height: 44px");
    expect(rule(".slide-surface-student .slide-fullscreen-button")).toContain("font-size: 0.875rem");
  });
});

describe("reduced motion", () => {
  const css = read("index.css");
  const start = css.lastIndexOf("@media (prefers-reduced-motion: reduce) {");
  const block = css.slice(start);

  it("has a reduced-motion rule", () => {
    expect(start).toBeGreaterThan(0);
  });

  it("stops the timer pulse and the leaderboard slide-in", () => {
    expect(block).toMatch(/\.timer-urgent,\s*\.leaderboard-row \{\s*animation: none;/);
  });

  it("swaps the spinning loader for a fade", () => {
    expect(block).toMatch(/\.animate-spin \{\s*animation: reduced-motion-fade/);
    expect(css).toContain("@keyframes reduced-motion-fade");
  });

  it("ends the bar and button transitions and the press-down scale", () => {
    for (const selector of [".bar-fill", ".option-btn", ".quiz-surface-content-fit", ".image-expandable-inline", ".slide-video-card"]) {
      expect(block).toContain(selector);
    }
    expect(block).toContain("transition: none");
    expect(block).toContain('[class*="active:scale"]:active');
  });

  it("shortens anything else that moves", () => {
    expect(block).toContain("animation-duration: 0.01ms !important");
    expect(block).toContain("transition-duration: 0.01ms !important");
  });

  it("covers every animation and transition the stylesheet declares", () => {
    const animated = [...css.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]).filter((n) => n !== "none");
    expect(new Set(animated)).toEqual(new Set(["timer-pulse", "slide-in", "reduced-motion-fade"]));
  });
});
