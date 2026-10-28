import fs from "fs";
import path from "path";
import { serializeSession } from "../session";
import { goldenQuiz, goldenSession, readerOutputs, seats } from "./attempts-test-support";

function capture() {
  const captures: unknown[] = [];
  for (const [pacing, legacy] of [["presenter-paced", false], ["self-paced", false], ["presenter-paced", true]] as const) {
    const { step, current } = goldenSession(pacing, legacy);
    const take = (label: string) => captures.push({ pacing, legacy, label, ...readerOutputs(current()), serialized: serializeSession(current()) });
    for (let index = 0; index < 4; index++) {
      for (const [position, id] of seats.entries()) {
        step({ type: "answerSubmit", studentId: id, sessionToken: `token-${id}`, payload: { questionIndex: index,
          ...(index === 3 ? { responseText: `Smoke response ${id}` } : { selectedOptions: index === 1 ? (position === 0 ? ["A", "C"] : ["B"]) : [position === 1 ? "B" : "A"] }) } }, 1000 + index * 100 + position);
        if (index === 2) take(`poll-${position + 1}-voters`);
      }
      if (index === 3) {
        step({ type: "responseVisibility", role: "control", questionIndex: 3, publicKey: "key-one", hidden: false });
        step({ type: "responseVisibility", role: "control", questionIndex: 3, publicKey: "key-two", hidden: true });
      }
      take(`open-${index}`);
      if (pacing === "presenter-paced") { step({ type: "close" }, 2000 + index * 100); step({ type: "reveal" }, 2100 + index * 100); take(`reveal-${index}`); }
      if (index < 3) step({ type: "next" }, 2200 + index * 100);
    }
    step({ type: "end", discloseResults: true }, 5000); take("ended");
  }
  return JSON.parse(JSON.stringify(captures));
}

it("preserves original engine reader outputs and serialized bytes", () => {
  jest.spyOn(Date, "now").mockReturnValue(100);
  try {
    const actual = capture();
    const fixture = path.join(__dirname, "fixtures", "attempts-origin-main.json");
    expect(actual).toEqual(JSON.parse(fs.readFileSync(fixture, "utf8")));
  } finally { jest.restoreAllMocks(); }
});
