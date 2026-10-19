import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../app";
import { clearAllSessions } from "../session";
import { parseQuizMarkdown } from "../parser";

const QUESTION = `
---

## Check

**Ready?**

A. Yes
B. No

> Correct Answer: A
> Overall Feedback: Ready.

---
`;

function deck(title: string, theme?: string): string {
  return `# ${title}\n${theme ? `dark: ${theme}\n` : ""}${QUESTION}`;
}

describe("per-deck theme", () => {
  afterEach(() => clearAllSessions());

  it("parses on and off mode overrides case-insensitively", () => {
    expect(parseQuizMarkdown(deck("Light", "OFF"), "light.md").quiz?.theme).toBe("light");
    expect(parseQuizMarkdown(deck("Dark", "'on'"), "dark.md").quiz?.theme).toBe("dark");
    expect(parseQuizMarkdown(deck("Fallback"), "fallback.md").quiz?.theme).toBeUndefined();
  });

  it("reports invalid dark metadata at deck level", () => {
    const result = parseQuizMarkdown(deck("Invalid", "sepia"), "invalid.md");
    expect(result.errors.map((error) => error.detail)).toContain(
      "Invalid dark: sepia (expected on or off)",
    );
  });

  it("delivers the effective theme on deck and session endpoints", async () => {
    const quizDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-theme-"));
    fs.writeFileSync(path.join(quizDir, "light.md"), deck("Light", "off"));
    fs.writeFileSync(path.join(quizDir, "fallback.md"), deck("Fallback"));
    const app = createApp({ quizDir, theme: "dark" });

    const decks = await request(app).get("/api/decks").expect(200);
    expect(decks.body.find((item: { week: string }) => item.week === "light").theme).toBe("light");
    expect(decks.body.find((item: { week: string }) => item.week === "fallback").theme).toBe("dark");

    const deckResponse = await request(app).get("/api/deck/light").expect(200);
    expect(deckResponse.body.theme).toBe("light");

    const created = await request(app).post("/api/session").send({ week: "light" }).expect(201);
    expect(created.body.theme).toBe("light");

    const lookup = await request(app).get(`/api/session/by-code/${created.body.sessionCode}`).expect(200);
    expect(lookup.body.theme).toBe("light");

    const restored = await request(app).get(`/api/session/${created.body.sessionId}/state`).expect(200);
    expect(restored.body.theme).toBe("light");

    const presentation = await request(app).get(`/api/session/${created.body.sessionId}/presentation`).expect(200);
    expect(presentation.body.theme).toBe("light");
  });
});
