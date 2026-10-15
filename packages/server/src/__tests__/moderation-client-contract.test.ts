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

  it("shows the projector the real total and shown responses while open", () => {
    expect(projector).toContain("<OpenResponseCount count={liveResponseCount} responses={liveOpenResponses} />");
    expect(projector).toContain("answerCount?.openResponseTotal");
    expect(projector).toContain("answerCount?.openResponses");
    expect(projector.match(/total={currentReveal.openResponseTotal}/g)).toHaveLength(2);
    // The projector names the real total and lists what is shown; the empty label only when nothing was submitted.
    expect(list).toContain("total === 0 && <p className=\"open-response-empty text-sm\">{emptyLabel}</p>");
    expect(list).not.toContain("All responses are hidden from the projector.");
    // Only the presenter is told how many are hidden.
    expect(list).toContain("{onToggleHidden && (hiddenCount > 0 || hiddenByDefault) && (");
  });

  it("offers bulk controls and a default-hidden hint only to the presenter", () => {
    expect(list).toContain("{onSetAllHidden && (");
    expect(list).toContain(">Show all</button>");
    expect(list).toContain(">Hide all</button>");
    expect(list).toContain("New responses start hidden.");
    expect(instructor).toContain("onSetAllHidden: setAllHidden");
    expect(projector).not.toContain("onSetAllHidden");
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
