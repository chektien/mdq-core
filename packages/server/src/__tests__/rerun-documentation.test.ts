import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "../../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("the public re-run integration contract", () => {
  it("README describes the engine command, archive responsibility and attempt compatibility", () => {
    const source = read("README.md");
    expect(source).not.toContain("cannot be restarted or reopened for another scored attempt");
    expect(source).toContain("[engine re-run API](docs/engine-rerun.md)");
    expect(source).toContain("Core provides no HTTP route or instructor button");
    expect(source).toContain("`archived` so the archive keeps what participants answered");
    expect(source).toContain("Omission means\nattempt 1");
    expect(source).toContain("Policy-less legacy\nsessions cannot re-run");
  });
  it("the API reference covers payloads, host persistence, routing, timing and legacy ranking", () => {
    const source = read("docs/engine-rerun.md");
    for (const text of ["Core provides no HTTP route or\ninstructor button", "archived: oldQuestion", "persists it and routes `result.messages`", "scheduling any new question deadline", "must pass the old `Question`", "Policy-less legacy\nsessions cannot re-run", "AnswerSubmitPayload.attempt", "Omission means\nattempt 1", "SessionStatePayload.questionAttempts", "StudentAnswer.attempt"]) expect(source).toContain(text);
    expect(source).toContain("An announced\nattempt immediately invalidates earlier answers, drafts");
    expect(source).toContain("An item with older content shows a loading state");
    expect(source).toContain("A failed refresh keeps it waiting");
    expect(source).toContain("Submissions never use an announced attempt with earlier content");
    expect(source).toContain("Stored-session readability after a rollback to main does not guarantee live\nrecovery of re-run questions");
    expect(source).toContain("Main omits both `attempt` and `acceptedRevision`\nfrom own answers and sends no participant `session:state` snapshot");
    expect(source).toContain("already saw attempt 2 treats main's answers and openings as attempt 1 and rejects\nthem");
    expect(source).toContain("HTTP refresh and reconnect cannot recover an accepted edit to that re-run\nquestion");
    expect(source).toContain("An accepted edit with a lost ACK can therefore leave the page stuck on\nits previously known answer until reload");
    expect(source).toContain("Reload clears the page's attempt\nknowledge and lets it read main's current answer as attempt 1");
    expect(source).not.toMatch(/[;—]/);
  });
  it("attempt comments use plain sentences in the shared and client API", () => {
    for (const file of ["packages/shared/src/index.ts", "packages/client/src/hooks/useSocket.ts"]) {
      const comment = read(file).match(/\/\*\* Which time this question is asked[^]*?\*\//)?.[0];
      expect(comment).toBeDefined();
      expect(comment).not.toMatch(/[:;—]/);
    }
    const draftComment = read("packages/client/src/participantDrafts.ts").match(/\/\*\* `attempt`[^]*?\*\//)?.[0];
    expect(draftComment).toBeDefined();
    expect(draftComment).not.toMatch(/[:;—]/);
  });
});
