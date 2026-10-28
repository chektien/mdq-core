import path from "path";
import { buildSync } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuestionState } from "../../../client/src/hooks/useSocket";

// The existing client-render test setup: bundle the real JSX, then render with React.
const root = path.resolve(__dirname, "../../../..");
const bundle = buildSync({
  entryPoints: [path.join(root, "packages/client/src/views/StudentView.tsx")],
  bundle: true, platform: "node", format: "cjs", jsx: "automatic", write: false, packages: "external",
  alias: { "@mdq/shared": path.join(root, "packages/shared/src/index.ts") },
});
const compiled = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, compiled, compiled.exports);
const { QuestionView } = compiled.exports as { QuestionView: ComponentType<{
  question: QuestionState; state: "QUESTION_OPEN" | "QUESTION_CLOSED"; remainingSec: null;
  submitted: boolean; submittedOptions: string[]; submittedResponseText: null;
  timedOut: boolean; connected: boolean; onSubmit: () => void; selfPaced: boolean;
  answerRejection?: { questionIndex: number; reason: string } | null;
}> };
const reason = "This question changed. Refresh the page to answer it.";

for (const selfPaced of [false, true]) {
  for (const questionType of ["multiple_choice", "open_response"] as const) {
    describe(`${selfPaced ? "study" : "presenter"} ${questionType} answer refusal`, () => {
      const question: QuestionState = {
        questionIndex: 2, questionType, topic: "Synthetic item", text: "<p>Synthetic prompt</p>",
        options: questionType === "open_response" ? [] : [{ label: "A", text: "Synthetic option" }],
        allowsMultiple: false, isPoll: false, startedAt: 0, timeLimitSec: null,
      };
      const render = (answerRejection: { questionIndex: number; reason: string } | null, closed = false) => renderToStaticMarkup(createElement(QuestionView, {
        question, state: closed ? "QUESTION_CLOSED" : "QUESTION_OPEN", remainingSec: null,
        submitted: false, submittedOptions: [], submittedResponseText: null, timedOut: false,
        connected: true, onSubmit: () => undefined, selfPaced, answerRejection,
      }));
      it("renders the shown item's exact reason as polite warning feedback beside Submit", () => {
        const html = render({ questionIndex: 2, reason });
        expect(html).toContain(`<p class="student-screen-text mb-3 text-center text-sm text-amber-400" role="status" aria-live="polite" aria-atomic="true">${reason}</p>`);
        expect(html.indexOf(reason)).toBeLessThan(html.indexOf("student-submit-button"));
        expect(html.indexOf(reason)).toBeGreaterThan(html.indexOf('class="mt-4 pt-4 border-t border-zinc-800"'));
        expect(html).not.toContain("Answer rejected:");
      });
      it("does not show another item's refusal or change the normal answer view", () => {
        expect(render({ questionIndex: 3, reason })).toBe(render(null));
      });
      it("keeps deadline and closed-item refusals beside closed answer controls", () => {
        expect(render({ questionIndex: 2, reason: "Deadline passed" }, true)).toContain(">Deadline passed</p>");
      });
      it("renders server wording as text rather than HTML", () => {
        const html = render({ questionIndex: 2, reason: '<img src=x onerror="alert(1)">' });
        expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
        expect(html).not.toContain("<img");
      });
    });
  }
}
