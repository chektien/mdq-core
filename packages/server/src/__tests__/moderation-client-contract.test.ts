import fs from "fs";
import path from "path";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

describe("open response moderation in the client", () => {
  const list = read("components/OpenResponseList.tsx");
  const instructor = read("views/InstructorView.tsx");
  const projector = read("views/PresentationView.tsx");
  const student = read("views/StudentView.tsx");

  it("gives every response a real Hide / Show button whose name starts with its visible word", () => {
    expect(list).toMatch(/<button[^>]*\n?[^>]*type="button"[^>]*\n?[^>]*className="open-response-toggle/);
    expect(list).not.toContain("aria-pressed={hidden}");
    expect(list).toContain('aria-label={`${hidden ? "Show" : "Hide"} response from ${participantLabel}`}');
    expect(list).toContain('{hidden ? "Show" : "Hide"}');
    expect(list).toContain("Hidden from the projector");
  });

  it("offers the toggle to the instructor only, and never while reviewing an earlier question", () => {
    expect(instructor).toContain("const moderationProps = isReviewing || !sock.connected");
    expect(projector).not.toContain("onToggleHidden");
    expect(projector).not.toContain("setResponseHidden");
  });

  it("shows the projector a count while the question is open, not the responses", () => {
    expect(projector).toContain("<OpenResponseCount count={liveResponseCount} />");
    expect(projector).not.toContain("liveOpenResponses");
    expect(projector).not.toContain("answerCount?.openResponses");
  });

  it("links to the results download from the ended screen and the live controls", () => {
    expect(instructor).toContain("Download results (CSV)");
    expect(instructor.match(/resultsCsvUrl\(/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("caps the phone's response box at the engine's limit", () => {
    expect(student).not.toContain("maxLength={MAX_OPEN_RESPONSE_LENGTH}");
    expect(student).toContain("clampOpenResponse(e.target.value)");
    expect(student).toContain("characters left");
  });
});
