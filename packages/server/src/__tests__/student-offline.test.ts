import fs from "fs";
import path from "path";
import { clockOffsetFromTick, localRemainingSec } from "../../../client/src/countdown";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

describe("student countdown while offline", () => {
  const question = { startedAt: 100_000, timeLimitSec: 30 };

  it("counts down from the question's start time", () => {
    expect(localRemainingSec(question, 100_000)).toBe(30);
    expect(localRemainingSec(question, 100_999)).toBe(30);
    expect(localRemainingSec(question, 101_000)).toBe(29);
    expect(localRemainingSec(question, 125_500)).toBe(5);
  });

  it("stays within zero and the time limit", () => {
    expect(localRemainingSec(question, 200_000)).toBe(0);
    expect(localRemainingSec(question, 90_000)).toBe(30);
  });

  it("corrects for a device clock that differs from the server's", () => {
    // The device clock runs 14 s behind: the server reported 20 s left at local 96 000.
    const offset = clockOffsetFromTick(question, 20, 96_000);
    expect(offset).toBe(14_000);
    expect(localRemainingSec(question, 96_000, offset)).toBe(20);
    expect(localRemainingSec(question, 101_000, offset)).toBe(15);
  });
});

describe("student submit while offline", () => {
  const socket = read("hooks/useSocket.ts");
  const student = read("views/StudentView.tsx");

  it("does not hand an answer to a disconnected socket", () => {
    const submit = socket.slice(socket.indexOf("const submitAnswer = useCallback("));
    const guard = submit.indexOf("if (!socketRef.current.connected)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(submit.indexOf("socketRef.current.emit(SocketEvents.ANSWER_SUBMIT"));
    expect(submit).toContain("Not connected. Your answer was not sent");
  });

  it("runs the countdown locally only while disconnected on an open question", () => {
    expect(socket).toContain('if (connected || sessionState !== "QUESTION_OPEN" || !currentQuestion');
    expect(socket).toContain("localRemainingSec(currentQuestion, Date.now(), clockOffsetRef.current)");
    expect(socket).toContain("clockOffsetFromTick(shown, data.remainingSec, Date.now())");
  });

  it("disables Submit and says it is reconnecting while disconnected", () => {
    expect(student).toContain("connected={connected}");
    expect(student).toContain("disabled={!connected || (");
    expect(student).toMatch(/\{!connected && \(\s*<p className="student-reconnecting[^"]*" role="status"/);
    expect(student).toContain("Connection lost. Reconnecting&hellip;");
    const theme = read("theme.css");
    const disabled = theme.slice(theme.indexOf("html[data-theme] .student-submit-button:disabled {"));
    expect(disabled.slice(0, disabled.indexOf("}"))).toContain("border: 1px dashed var(--mdq-control-border) !important");
  });
});
