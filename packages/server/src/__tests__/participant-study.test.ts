import { participantStudyPayload, apply } from "../engine";
import { createSession } from "../session";
import { Question, Quiz, Session } from "@mdq/shared";
const question = (index: number, questionType: Question["questionType"] = "multiple_choice"): Question => ({
  index, topic: `Synthetic ${index}`, questionType, textMd: "Choose", textHtml: "Choose", timeLimitSec: 10,
  options: [{ label: "A", textMd: "one", textHtml: "one" }], correctOptions: ["A"], explanation: "PRIVATE_EXPLANATION",
  presenterNotes: [{ id: "private", scope: "section", audience: "presenter", bodyMd: "PRIVATE_NOTE", bodyHtml: "PRIVATE_NOTE" }], allowsMultiple: false,
});
const quiz: Quiz = { week: "synthetic", title: "Synthetic", sourceFile: "synthetic.md", questions: [question(0, "cover"), question(1), question(2, "poll"), question(3, "open_response"), question(4)] };
function setup(selfPaced = true) {
  let session = createSession("synthetic", "open");
  const step = (command: Parameters<typeof apply>[2], now = 0) => { session = apply(session, quiz, command, now).session; };
  step({ type: "configurePolicy", role: "control", pacing: selfPaced ? "self-paced" : "presenter-paced" });
  for (const id of ["one", "two"]) step({ type: "join", payload: { studentId: id }, socketId: id, newToken: `token-${id}` });
  step({ type: "start" });
  return { step, current: () => session };
}
it("projects only released content and own submitted evidence, never grading or private notes", () => {
  const { step, current } = setup();
  step({ type: "next" });
  step({ type: "answerSubmit", studentId: "one", sessionToken: "token-one", payload: { questionIndex: 1, selectedOptions: ["A"] } });
  step({ type: "next" });
  step({ type: "next" });
  step({ type: "answerSubmit", studentId: "two", sessionToken: "token-two", payload: { questionIndex: 3, responseText: "OTHER_PRIVATE_TEXT" } });
  const data = participantStudyPayload(current(), quiz, "one", 100000);
  expect(data.items.map(item => item.questionIndex)).toEqual([0, 1, 2, 3]);
  expect(data.answers).toEqual([{ questionIndex: 1, selectedOptions: [0] }]);
  expect(data.answerableQuestionIndexes).toEqual([2, 3]);
  expect(JSON.stringify(data)).not.toMatch(/PRIVATE|correctOptions|explanation|studentId|Synthetic 4/);
  expect(current().releasedQuestionIndexes?.size).toBe(4);
});
it("projection eligibility agrees with presenter deadlines, reveal, single submissions, and End", () => {
  const { step, current } = setup(false); step({ type: "next" }, 1000);
  expect(participantStudyPayload(current(), quiz, "one", 10999).answerableQuestionIndexes).toEqual([1]);
  expect(participantStudyPayload(current(), quiz, "one", 11000).answerableQuestionIndexes).toEqual([]);
  step({ type: "close" }, 11000); step({ type: "reveal" }, 11001);
  expect(participantStudyPayload(current(), quiz, "one", 11001).answerableQuestionIndexes).toEqual([]);
  const ended: Session = apply(current(), quiz, { type: "end" }, 12000).session;
  expect(participantStudyPayload(ended, quiz, "one", 12000).answerableQuestionIndexes).toEqual([]);
});

import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { createApp } from "../app";
import { clearAllSessions, getSession } from "../session";
it("native released items API requires a seat bearer and excludes other seats and future stems", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-study-"));
  const oldPassword = process.env.INSTRUCTOR_PASSWORD;
  delete process.env.INSTRUCTOR_PASSWORD;
  try {
    fs.writeFileSync(path.join(dir, "synthetic.md"), "# Synthetic\n\n---\n\n## First\n\nA question\n\nA. one\n\n> Correct Answer: A\n\n---\n\n## FUTURE_SECRET_STEM\n\nFuture question\n\nA. next\n\n> Correct Answer: A\n");
    const app = createApp({ quizDir: dir, dataDir: path.join(dir, "data"), shortUrlProviders: [] });
    const made = await request(app).post("/api/session").send({ week: "synthetic" }).expect(201);
    const id = made.body.sessionId;
    const session = getSession(id)!;
    const loadedQuiz = { ...quiz, questions: quiz.questions.slice(0, 2).map((q, index) => ({ ...q, questionType: "multiple_choice" as const, topic: index ? "FUTURE_SECRET_STEM" : "First" })) };
    Object.assign(session, apply(session, loadedQuiz, { type: "join", payload: { studentId: "one" }, socketId: "socket", newToken: "seat-token" }, 0).session);
    await request(app).post(`/api/session/${id}/start`).expect(200);
    await request(app).get(`/api/session/${id}/items`).expect(401);
    await request(app).get(`/api/session/${id}/items`).set("Authorization", "Bearer wrong-token").expect(401);
    const response = await request(app).get(`/api/session/${id}/items`).set("Authorization", "Bearer seat-token").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.items).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toMatch(/FUTURE_SECRET_STEM|correctOptions|explanation|studentId|sessionToken/);
    session.participants.get("one")!.released = true;
    await request(app).get(`/api/session/${id}/items`).set("Authorization", "Bearer seat-token").expect(401);
  } finally {
    if (oldPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD; else process.env.INSTRUCTOR_PASSWORD = oldPassword;
    clearAllSessions(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
