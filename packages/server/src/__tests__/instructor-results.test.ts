import fs from "fs";
import path from "path";
import { hasResultsAnswers } from "../../../client/src/instructorResults";

const empty = { distribution: { A: 0, B: 0 }, openResponses: [] };

describe("instructor results download visibility", () => {
  it("hides unknown and zero answer counts", () => {
    expect(hasResultsAnswers(null, [])).toBe(false);
    expect(hasResultsAnswers({ submitted: 0 }, [empty])).toBe(false);
  });

  it("shows a live answer before reveal, even if it is incorrect", () => {
    expect(hasResultsAnswers({ submitted: 1 }, [])).toBe(true);
  });

  it("keeps earlier multiple-choice and poll answers available after an unanswered question", () => {
    expect(hasResultsAnswers({ submitted: 0 }, [empty, { ...empty, distribution: { A: 0, B: 1 } }])).toBe(true);
  });

  it("includes written responses, including hidden responses", () => {
    expect(hasResultsAnswers(null, [{ distribution: {}, openResponses: [{ hidden: true, responseText: "Sample" }] }])).toBe(true);
  });

  it("guards both the ended link and live toolbar without changing their names", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../../client/src/views/InstructorView.tsx"), "utf-8");
    expect(source).toContain("{sid && hasAnswers && (");
    expect(source).toContain('if (hasAnswers) actions.push({ label: "Download results (CSV)", href: resultsCsvUrl(sessionId) });');
    expect(source).toContain("hasAnswers={hasAnswers}");
    expect(source).toContain("setRestoredRevealCache((previous) => ({ ...previous, [reveal.questionIndex]: reveal }))");
  });
});
